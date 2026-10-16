<template>
  <view class="page">
    <!-- 状态区 -->
    <view class="status">
      <view class="status-icon" :class="'status-icon-' + phase">
        <view class="spinner-light" v-if="phase === 'sending' || phase === 'waiting'" />
        <view class="tick" v-else-if="phase === 'success'" />
        <view class="cross" v-else />
      </view>
      <view class="status-title">{{ phaseTitle }}</view>
      <view class="status-desc">{{ phaseDesc }}</view>
      <view class="status-elapsed" v-if="phase === 'waiting'">已等待 {{ elapsed }} 秒</view>
    </view>

    <!-- 进度步骤 -->
    <view class="card">
      <view class="step" :class="phase === 'sending' ? 'step-active' : 'step-done'">
        <view class="step-dot" />
        <view class="step-body">
          <view class="step-title">下发配网信息</view>
          <view class="step-sub">{{ sentChunks ? `已分成 ${sentChunks} 包发完` : '进行中' }}</view>
        </view>
      </view>
      <view class="step-line" />
      <view class="step" :class="phase === 'waiting' ? 'step-active' : phase === 'sending' ? '' : 'step-done'">
        <view class="step-dot" />
        <view class="step-body">
          <view class="step-title">设备连接路由器</view>
          <view class="step-sub">设备会自己连 Wi-Fi 并获取 IP</view>
        </view>
      </view>
      <view class="step-line" />
      <view class="step" :class="phase === 'success' ? 'step-done' : phase === 'fail' || phase === 'timeout' ? 'step-fail' : ''">
        <view class="step-dot" />
        <view class="step-body">
          <view class="step-title">返回结果</view>
          <view class="step-sub">
            <text v-if="phase === 'success'">设备已确认连接成功</text>
            <text v-else-if="phase === 'fail'">设备报告连接失败</text>
            <text v-else-if="phase === 'timeout'">没有等到设备回复</text>
            <text v-else>等待中</text>
          </view>
        </view>
      </view>
    </view>

    <!-- 失败原因与建议 -->
    <view class="notice notice-error" v-if="error">
      <view class="notice-title">{{ error.title }}</view>
      <view class="notice-body">{{ error.message }}</view>
      <view class="notice-advice" v-if="error.advice.length">
        <view v-for="(item, i) in error.advice" :key="i" class="advice-item">· {{ item }}</view>
      </view>
    </view>

    <!-- 本次信息 -->
    <view class="card card-tight">
      <view class="row">
        <view class="row-main">
          <view class="row-sub">设备</view>
          <view class="row-title ellipsis">{{ deviceName || '未知设备' }}</view>
        </view>
      </view>
      <view class="row">
        <view class="row-main">
          <view class="row-sub">Wi-Fi</view>
          <view class="row-title ellipsis">{{ ssid }}</view>
        </view>
      </view>
      <view class="row">
        <view class="row-main">
          <view class="row-sub">城市</view>
          <view class="row-title">{{ locationText || '未设置' }}</view>
        </view>
      </view>
    </view>

    <!-- 排查详情 -->
    <view class="raw-box">
      <view class="detail-toggle" @click="showDetail = !showDetail">
        {{ showDetail ? '收起排查信息' : '展开排查信息' }}
      </view>
      <view class="detail-body" v-if="showDetail">
        <view class="detail-label">协商到的 MTU</view>
        <view class="detail-value">{{ mtuText }}</view>

        <view class="detail-label">下发给设备的报文</view>
        <view class="detail-value mono">{{ payloadText || '（未发送）' }}</view>
        <text class="btn-link detail-copy" v-if="payloadText" @click="onCopyPayload">复制报文</text>

        <view class="detail-label">设备回传的报文</view>
        <view class="detail-value mono" v-if="rawMessages.length">
          <view v-for="(item, i) in rawMessages" :key="i">{{ item }}</view>
        </view>
        <view class="detail-value" v-else>（还没收到任何回传）</view>
      </view>
    </view>

    <view class="flex-fill" />

    <!-- 操作 -->
    <view class="footer-bar">
      <template v-if="phase === 'success'">
        <button class="btn btn-primary" @click="onDone">完成</button>
      </template>
      <template v-else-if="phase === 'fail' || phase === 'timeout' || phase === 'error'">
        <button class="btn btn-primary" @click="onRetry">再试一次</button>
        <button class="btn btn-ghost retry-btn" @click="onEdit">返回修改信息</button>
      </template>
      <template v-else>
        <button class="btn btn-ghost" @click="onGiveUp">放弃配网</button>
      </template>
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * 配网结果页
 * ---------------------------------------------------------------------------
 * 这一页负责整个流程里最关键的收尾动作：**下发 + 等待结果**。
 *
 * 为什么把「下发」放在结果页而不是密码页：
 *   设备收到配置后会连路由器，连上/失败都会用通知推回来。如果密码页发完就跳走，
 *   接收方还没订阅上，结果消息就丢了，用户会一直等不到反馈。
 *   所以本页的顺序是：先订阅 → 再确保通知已开 → 最后才写入。
 *
 * 另外一个真实情况：设备侧配网成功后按约定会释放蓝牙资源、停止广播，
 * 会直接 deinit BLE 并停止广播，也就是说 **成功通知之后连接马上就会断**。
 * 所以收到 success 之后再来的断开事件必须被忽略，否则用户看到的是「配网失败」。
 */

import { ref, computed } from 'vue';
import { onLoad, onUnload } from '@dcloudio/uni-app';
import { config } from '../../config.ts';
import {
  ble,
  buildWifiConfigPayload,
  describeError,
  type DeviceStateResult,
  type ErrorInfo
} from '../../ble/index.ts';
import { useBleEvents } from '../../composables/useBle.ts';
import { addRecord } from '../../utils/storage.ts';
import { flow } from '../../store/flow.ts';

type Phase = 'sending' | 'waiting' | 'success' | 'fail' | 'timeout' | 'error';

const phase = ref<Phase>('sending');
const phaseTitle = ref('正在下发配网信息');
const phaseDesc = ref('请保持小程序在前台');
const error = ref<ErrorInfo | null>(null);

const deviceName = ref('');
const ssid = ref('');
const payloadText = ref('');
const sentChunks = ref(0);
const mtuText = ref('');
const elapsed = ref(0);
const rawMessages = ref<string[]>([]);
const showDetail = ref(false);

const locationText = computed(() => {
  const p = flow.provision;
  if (!p) return '';
  return (p.city || '') + (p.district ? ' · ' + p.district : '');
});

let finished = false;
let destroyed = false;
let rawList: string[] = [];
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
let resultTimer: ReturnType<typeof setTimeout> | null = null;
let elapsedBase = 0;

function getPhoneCoordinates(): Promise<{ latitude: number; longitude: number } | null> {
  return new Promise((resolve) => {
    uni.getLocation({
      type: 'wgs84',
      isHighAccuracy: true,
      highAccuracyExpireTime: 4000,
      success: (res) => resolve({ latitude: res.latitude, longitude: res.longitude }),
      fail: (err) => {
        console.warn('[result] 获取手机位置失败，继续使用设备 IP 定位:', err);
        resolve(null);
      }
    });
  });
}

function stopTimers(): void {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  if (resultTimer) {
    clearTimeout(resultTimer);
    resultTimer = null;
  }
}

function armResultTimeout(): void {
  if (resultTimer) clearTimeout(resultTimer);
  resultTimer = setTimeout(() => {
    if (finished || destroyed) return;
    finished = true;
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    phase.value = 'timeout';
    phaseTitle.value = '配网超时';
    phaseDesc.value = `等了 ${Math.round(config.timeouts.provision / 1000)} 秒还没收到设备回复`;
    error.value = describeError('TIMEOUT_PROVISION');
    recordHistory(false);
  }, config.timeouts.provision);
}

function startElapsed(): void {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedBase = Date.now();
  elapsedTimer = setInterval(() => {
    if (destroyed) return;
    elapsed.value = Math.floor((Date.now() - elapsedBase) / 1000);
  }, 1000);
}

async function send(): Promise<void> {
  const provision = flow.provision;

  if (!provision || !ble.isConnected()) {
    phase.value = 'error';
    phaseTitle.value = '设备已断开';
    phaseDesc.value = '连接断开了，无法下发配网信息';
    error.value = describeError({ errCode: 10006, errMsg: 'not connected' });
    return;
  }

  phase.value = 'sending';
  phaseTitle.value = '正在下发配网信息';
  phaseDesc.value = '请保持小程序在前台';
  error.value = null;

  try {
    phaseDesc.value = '正在获取手机位置，用于查询当地天气';
    const coordinates = await getPhoneCoordinates();
    if (coordinates) {
      provision.latitude = coordinates.latitude;
      provision.longitude = coordinates.longitude;
    }

    // 通知没开就先开。这一步同时会让设备扫一次 Wi-Fi，列表我们这里不关心。
    if (!ble.isNotifyEnabled()) {
      await ble.enableNotify();
    }

    const payload = buildWifiConfigPayload(
      provision.ssid,
      provision.pwd,
      provision.city,
      provision.district,
      provision.latitude,
      provision.longitude
    );

    if (destroyed) return;

    payloadText.value = payload.text;
    mtuText.value = ble.connection.mtu
      ? ble.connection.mtu + ' 字节'
      : `未协商（按 ${ble.connection.chunkSize} 字节分包）`;

    const res = await ble.writeConfig(payload);
    console.log('[result] 已下发:', payload.text, '分片数:', res.chunks);

    if (destroyed) return;

    phase.value = 'waiting';
    phaseTitle.value = '设备正在连接路由器';
    phaseDesc.value = '通常 5~20 秒，慢的话可能要到 1 分钟';
    sentChunks.value = res.chunks;

    startElapsed();
    armResultTimeout();
  } catch (e) {
    stopTimers();
    console.warn('[result] 下发失败:', e);
    if (destroyed) return;
    phase.value = 'error';
    phaseTitle.value = '下发失败';
    phaseDesc.value = '配网信息没能发到设备';
    error.value = describeError(e);
    recordHistory(false);
  }
}

function handleState(payload: DeviceStateResult): void {
  if (finished || !payload || payload.state === 'unknown') {
    // 认不出来的报文不当作结果，继续等（可能只是 Wi-Fi 列表或别的消息）
    return;
  }

  finished = true;
  stopTimers();

  if (payload.state === 'success') {
    phase.value = 'success';
    phaseTitle.value = '配网成功';
    phaseDesc.value = '设备已经连上 Wi-Fi 了';
    error.value = null;
    recordHistory(true);
  } else {
    phase.value = 'fail';
    phaseTitle.value = '配网失败';
    phaseDesc.value = payload.reason || '设备没能连上这个 Wi-Fi';
    error.value = {
      code: 'DEVICE_FAIL',
      title: '设备报告配网失败',
      message: payload.reason || '设备尝试连接路由器但没有成功。',
      advice: [
        '确认 Wi-Fi 密码没有输错（注意大小写）',
        '确认路由器是 2.4GHz，多数 IoT 设备不支持 5GHz',
        '路由器如果开了 MAC 地址过滤或「禁止新设备接入」，先关掉',
        '路由器如果开了「双频合一」，试试临时关掉',
        '靠近路由器再试一次'
      ],
      raw: payload.raw
    };
    recordHistory(false);
  }
}

function handleDisconnected(): void {
  // 成功后设备会主动断开 BLE（固件里配网成功就 deinit 了蓝牙），这是正常现象，
  // 不能当成失败
  if (finished || destroyed) return;
  finished = true;
  stopTimers();
  phase.value = 'error';
  phaseTitle.value = '设备已断开';
  phaseDesc.value = '还没收到结果，连接就断开了';
  error.value = describeError({ errCode: 10006, errMsg: 'disconnected before result' });
  recordHistory(false);
}

function handleMessage(value: unknown): void {
  rawList.push(JSON.stringify(value));
  if (rawList.length > 6) {
    rawList.shift();
  }
  rawMessages.value = rawList.slice();
}

/** 写一条历史记录，首页会显示「上次配网」 */
function recordHistory(success: boolean): void {
  const provision = flow.provision;
  const device = flow.device;
  try {
    addRecord({
      deviceId: device ? device.deviceId : '',
      deviceName: device ? device.name : '',
      ssid: provision ? provision.ssid : '',
      city: (provision && provision.city) || '',
      district: (provision && provision.district) || '',
      pwd: (provision && provision.pwd) || '',
      success
    });
  } catch (e) {
    console.warn('[result] 保存配网记录失败:', e);
  }
}

/** 重试：设备失败后往往仍连着，直接重发一次即可，不用重新扫描 */
function onRetry(): void {
  if (!ble.isConnected()) {
    uni.showModal({
      title: '设备已断开',
      content: '需要重新扫描并连接设备。',
      showCancel: false,
      success: () => {
        uni.reLaunch({ url: '/pages/scan/scan' });
      }
    });
    return;
  }
  finished = false;
  rawList = [];
  rawMessages.value = [];
  elapsed.value = 0;
  showDetail.value = false;
  void send();
}

function onEdit(): void {
  uni.navigateBack();
}

function onCopyPayload(): void {
  if (!payloadText.value) return;
  uni.setClipboardData({ data: payloadText.value });
}

async function onDone(): Promise<void> {
  await ble.close();
  // 回到第一页（扫描页）。首页删掉前这里是 /pages/index/index。
  uni.reLaunch({ url: '/pages/scan/scan' });
}

async function onGiveUp(): Promise<void> {
  await ble.close();
  uni.reLaunch({ url: '/pages/scan/scan' });
}

/**
 * 先订阅，再下发 —— 顺序反了就会丢设备回报的 success/fail。
 * 订阅在 setup 阶段同步完成，卸载时自动退订。
 */
useBleEvents({
  state: handleState,
  disconnected: handleDisconnected,
  message: handleMessage
});

onLoad(() => {
  const device = flow.device;
  const provision = flow.provision;
  deviceName.value = device ? device.name : '';
  ssid.value = provision ? provision.ssid : '';
  mtuText.value = ble.connection.mtu ? ble.connection.mtu + ' 字节' : '未协商（按 20 字节分包）';

  void send();
});

onUnload(() => {
  destroyed = true;
  stopTimers();
});
</script>

<style scoped>
.status {
  padding: 48rpx 40rpx 40rpx;
  text-align: center;
}

.status-icon {
  width: 148rpx;
  height: 148rpx;
  border-radius: 50%;
  margin: 0 auto 32rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #eef1f4;
}

.status-icon-sending,
.status-icon-waiting {
  background: linear-gradient(135deg, #07c160 0%, #06ad56 100%);
}

.status-icon-success {
  background: #07c160;
}

.status-icon-fail,
.status-icon-timeout,
.status-icon-error {
  background: #fa5151;
}

.spinner-light {
  width: 56rpx;
  height: 56rpx;
  border: 8rpx solid rgba(255, 255, 255, 0.35);
  border-top-color: #ffffff;
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}

/* 纯 CSS 打勾 */
.tick {
  width: 36rpx;
  height: 68rpx;
  border-right: 10rpx solid #ffffff;
  border-bottom: 10rpx solid #ffffff;
  transform: rotate(45deg) translate(-6rpx, -10rpx);
}

/* 纯 CSS 打叉 */
.cross {
  width: 64rpx;
  height: 64rpx;
  position: relative;
}

.cross::before,
.cross::after {
  content: '';
  position: absolute;
  left: 0;
  top: 28rpx;
  width: 64rpx;
  height: 10rpx;
  background: #ffffff;
  border-radius: 5rpx;
}

.cross::before {
  transform: rotate(45deg);
}

.cross::after {
  transform: rotate(-45deg);
}

.status-title {
  font-size: 40rpx;
  font-weight: 600;
}

.status-desc {
  font-size: 28rpx;
  color: #8a9099;
  margin-top: 12rpx;
  line-height: 1.6;
}

.status-elapsed {
  font-size: 26rpx;
  color: #b6bcc4;
  margin-top: 16rpx;
}

.step {
  display: flex;
  align-items: flex-start;
  padding: 20rpx 0;
}

.step-dot {
  width: 32rpx;
  height: 32rpx;
  border-radius: 50%;
  background: #dfe3e8;
  flex-shrink: 0;
  margin-right: 24rpx;
  margin-top: 6rpx;
  position: relative;
}

.step-done .step-dot {
  background: #07c160;
}

.step-done .step-dot::after {
  content: '';
  position: absolute;
  left: 10rpx;
  top: 5rpx;
  width: 8rpx;
  height: 15rpx;
  border-right: 3rpx solid #ffffff;
  border-bottom: 3rpx solid #ffffff;
  transform: rotate(45deg);
}

.step-active .step-dot {
  background: #07c160;
  box-shadow: 0 0 0 8rpx rgba(7, 193, 96, 0.16);
}

.step-fail .step-dot {
  background: #fa5151;
}

.step-body {
  flex: 1;
}

.step-title {
  font-size: 30rpx;
  color: #1a1a1a;
}

.step-sub {
  font-size: 24rpx;
  color: #8a9099;
  margin-top: 4rpx;
}

.step-line {
  width: 2rpx;
  height: 28rpx;
  background: #eef1f4;
  margin-left: 15rpx;
  margin-top: -14rpx;
  margin-bottom: -14rpx;
}

.retry-btn {
  margin-top: 20rpx;
}
</style>
