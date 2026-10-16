<template>
  <view class="page">
    <!-- 设备提示 -->
    <view class="notice notice-info" v-if="deviceName">
      <view class="notice-body">
        正在与 <text class="strong">{{ deviceName }}</text> 通信。下面的 Wi-Fi 列表是设备自己扫描到的。
      </view>
    </view>

    <!-- 出错 -->
    <template v-if="error">
      <view class="notice notice-error">
        <view class="notice-title">{{ error.title }}</view>
        <view class="notice-body">{{ error.message }}</view>
        <view class="notice-advice" v-if="error.advice.length">
          <view v-for="(item, i) in error.advice" :key="i" class="advice-item">· {{ item }}</view>
        </view>
      </view>
      <button class="btn btn-primary" @click="onRescan">让设备重新扫描</button>
    </template>

    <!-- 扫到但为空 -->
    <template v-else-if="empty">
      <view class="card empty-card">
        <view class="empty-title">设备没扫到任何 Wi-Fi</view>
        <view class="empty-desc">可能是设备离路由器太远，或者路由器在 5G 频段而设备只支持 2.4G。</view>
      </view>
      <button class="btn btn-primary" @click="onRescan">让设备重新扫描</button>
    </template>

    <!-- 列表 -->
    <template v-else-if="!loading">
      <view class="section-title">设备扫描到 {{ list.length }} 个 Wi-Fi，请选择你家要连的那个</view>
      <view class="card card-tight">
        <view class="row wifi-row" v-for="item in list" :key="item.ssid" @click="onPick(item.ssid)">
          <view class="row-main">
            <view class="row-title ellipsis">{{ item.ssid }}</view>
            <view class="row-sub" v-if="hasRssi && item.rssi !== null">{{ item.rssi }} dBm</view>
          </view>
          <view class="row-extra">
            <text class="badge" v-if="item.secured === true">加密</text>
            <text class="badge" v-else-if="item.secured === false">开放</text>
            <view class="bars" v-if="hasRssi">
              <view class="bar bar-1" :class="{ on: item.bars >= 1 }" />
              <view class="bar bar-2" :class="{ on: item.bars >= 2 }" />
              <view class="bar bar-3" :class="{ on: item.bars >= 3 }" />
              <view class="bar bar-4" :class="{ on: item.bars >= 4 }" />
            </view>
          </view>
        </view>
      </view>
      <view class="list-note">
        没看到你家的 Wi-Fi？
        <text class="btn-link" @click="manualMode = !manualMode">手动输入名称</text>
        <text class="sep">·</text>
        <text class="btn-link" @click="onRescan">重新扫描</text>
      </view>
    </template>

    <!-- 加载中 -->
    <view class="card loading-card" v-else>
      <view class="spinner" />
      <view class="loading-title">正在让设备扫描 Wi-Fi…</view>
      <view class="loading-desc">设备扫完会把列表发过来，通常需要几秒</view>
    </view>

    <!-- 手动输入 -->
    <view class="card" v-if="manualMode">
      <view class="manual-title">手动输入 Wi-Fi 名称</view>
      <input
        class="manual-input"
        :value="manualSsid"
        placeholder="例如 MyWiFi（区分大小写）"
        :maxlength="32"
        confirm-type="next"
        @input="onManualInput"
      />
      <view class="manual-tip">用于隐藏了 SSID 的热点，或者设备扫不到的情况。名称必须和路由器完全一致。</view>
      <button class="btn btn-primary manual-btn" @click="onManualNext">下一步</button>
    </view>

    <!-- 原始报文（排查用） -->
    <view class="raw-box">
      <view class="raw-toggle" @click="onToggleRaw">
        {{ showRaw ? '收起原始报文' : '查看设备原始报文' }}
      </view>
      <view class="raw-body" v-if="showRaw">
        <view class="raw-text">{{ rawSample || '（还没有收到设备数据）' }}</view>
        <text class="btn-link raw-copy" v-if="rawSample" @click="onCopyRaw">复制</text>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * Wi-Fi 列表页
 * ---------------------------------------------------------------------------
 * 这一页负责一件容易被写错的事：**先订阅，再开通知**。
 *
 * 设备侧的时序是这样的：
 *   手机写 CCCD = 0x0001  →  设备立刻开始扫 Wi-Fi  →  扫完把列表用通知推上来
 * 也就是说「开通知」这个动作本身就是「命令设备去扫」，列表几秒后就会到。
 * 如果先开通知、再订阅事件，那几秒内推上来的消息就没人接，页面永远转圈。
 * 所以顺序必须是：ble.on('wifiList', …) → ble.enableNotify()。
 *
 * 另外设备发的列表只有 SSID 名字，没有信号强度（示例代码里没带 rssi），
 * 所以这里对信号格做了「有就显示、没有就不显示」的宽容处理。
 */

import { ref } from 'vue';
import { onLoad, onUnload } from '@dcloudio/uni-app';
import { config } from '../../config.ts';
import {
  ble,
  describeError,
  rssiToBars,
  validateSsid,
  type ErrorInfo,
  type WifiListResult
} from '../../ble/index.ts';
import { useBleEvents } from '../../composables/useBle.ts';
import { inputValue } from '../../utils/uni-event.ts';
import { flow } from '../../store/flow.ts';

interface WifiRow {
  ssid: string;
  rssi: number | null;
  bars: number;
  secured: boolean | null;
}

const deviceName = ref('');
const loading = ref(true);
const list = ref<WifiRow[]>([]);
const empty = ref(false);
const error = ref<ErrorInfo | null>(null);
const hasRssi = ref(false);
const manualMode = ref(false);
const manualSsid = ref('');
const rawSample = ref('');
const showRaw = ref(false);

let listTimer: ReturnType<typeof setTimeout> | null = null;
let destroyed = false;
let rawCache = '';

function clearListTimer(): void {
  if (listTimer) {
    clearTimeout(listTimer);
    listTimer = null;
  }
}

function armListTimeout(): void {
  clearListTimer();
  listTimer = setTimeout(() => {
    if (destroyed) return;
    if (loading.value) {
      loading.value = false;
      error.value = describeError('TIMEOUT_WIFI_LIST');
    }
  }, config.timeouts.wifiList);
}

/**
 * 打开通知并等列表。
 * 如果通知已经开着（用户从密码页返回），只重挂定时器，不重复触发扫描。
 */
async function ensureNotify(): Promise<void> {
  try {
    if (!ble.isNotifyEnabled()) {
      await ble.enableNotify();
    }
    if (destroyed) return;
    armListTimeout();
  } catch (e) {
    if (destroyed) return;
    loading.value = false;
    error.value = describeError(e);
  }
}

function handleWifiList(payload: WifiListResult): void {
  clearListTimer();

  if (!payload || !payload.ok) {
    loading.value = false;
    error.value = describeError('BAD_JSON');
    return;
  }

  const rows: WifiRow[] = payload.list.map((item) => ({
    ssid: item.ssid,
    rssi: item.rssi,
    bars: rssiToBars(item.rssi),
    secured: item.sec === null || item.sec === undefined ? null : item.sec !== 0
  }));

  loading.value = false;
  error.value = null;
  list.value = rows;
  empty.value = rows.length === 0;
  hasRssi.value = rows.some((x) => x.rssi !== null && x.rssi !== undefined);
  rawSample.value = rawCache;
}

function handleDisconnected(): void {
  clearListTimer();
  if (destroyed) return;
  loading.value = false;
  error.value = describeError({ errCode: 10006, errMsg: 'device disconnected while listing wifi' });
}

function handleMessage(value: unknown): void {
  const text = JSON.stringify(value);
  rawCache = text;
  if (showRaw.value) {
    rawSample.value = text;
  }
}

/** 重新让设备扫一次。协议里没有独立的重扫命令，只能靠重写 CCCD 触发 */
async function onRescan(): Promise<void> {
  loading.value = true;
  error.value = null;
  empty.value = false;
  list.value = [];
  try {
    await ble.triggerRescan();
    if (destroyed) return;
    armListTimeout();
  } catch (e) {
    if (destroyed) return;
    loading.value = false;
    error.value = describeError(e);
  }
}

function onPick(ssid: string): void {
  if (!ssid) return;
  flow.wifi = { ssid, manual: false };
  uni.navigateTo({ url: '/pages/password/password' });
}

function onManualInput(e: Event): void {
  manualSsid.value = inputValue(e);
}

function onManualNext(): void {
  const raw = String(manualSsid.value || '').trim();
  const check = validateSsid(raw);
  if (!check.ok) {
    uni.showToast({ title: check.message, icon: 'none' });
    return;
  }
  flow.wifi = { ssid: raw, manual: true };
  uni.navigateTo({ url: '/pages/password/password' });
}

function onToggleRaw(): void {
  showRaw.value = !showRaw.value;
  rawSample.value = showRaw.value ? rawCache : rawSample.value;
}

function onCopyRaw(): void {
  if (!rawSample.value) return;
  uni.setClipboardData({ data: rawSample.value });
}

/**
 * 先订阅，再开通知 —— 顺序反了就会丢设备推上来的 Wi-Fi 列表。
 * 订阅在 setup 阶段同步完成，卸载时自动退订。
 */
useBleEvents({
  wifiList: handleWifiList,
  disconnected: handleDisconnected,
  message: handleMessage
});

onLoad(() => {
  const device = flow.device;
  deviceName.value = device ? device.name : '';
  void ensureNotify();
});

onUnload(() => {
  destroyed = true;
  clearListTimer();
});
</script>

<style scoped>
.loading-card {
  text-align: center;
  padding: 80rpx 40rpx;
}

.loading-title {
  font-size: 32rpx;
  font-weight: 500;
  margin-bottom: 12rpx;
}

.loading-desc {
  font-size: 26rpx;
  color: #8a9099;
}

.empty-card {
  text-align: center;
  padding: 80rpx 40rpx;
}

.wifi-row:active {
  background: #f7f8fa;
}

.wifi-row .row-extra .badge {
  margin-right: 16rpx;
}

.list-note {
  text-align: center;
  font-size: 26rpx;
  color: #8a9099;
  padding: 12rpx 0 24rpx;
}

.sep {
  margin: 0 16rpx;
  color: #d4d8dd;
}

.manual-title {
  font-size: 32rpx;
  font-weight: 500;
  margin-bottom: 24rpx;
}

.manual-input {
  height: 92rpx;
  background: #f6f7f9;
  border-radius: 16rpx;
  padding: 0 28rpx;
  font-size: 30rpx;
  box-sizing: border-box;
}

.manual-tip {
  font-size: 24rpx;
  color: #8a9099;
  line-height: 1.6;
  margin-top: 16rpx;
}

.manual-btn {
  margin-top: 32rpx;
}
</style>
