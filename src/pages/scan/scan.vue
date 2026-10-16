<template>
  <view class="page">
    <!-- 启动自检：开蓝牙 + 申请定位权限。不需要用户点任何按钮 -->
    <view class="card empty-card" v-if="adapterState === 'checking'">
      <view class="spinner" />
      <view class="empty-title">正在准备蓝牙…</view>
      <view class="empty-desc">首次使用会请求定位权限</view>
    </view>

    <!-- 安卓没有定位权限，一台设备都扫不到，必须先解决 -->
    <view class="notice notice-warn" v-if="adapterState === 'needLocation'">
      <view class="notice-title">需要定位权限</view>
      <view class="notice-body">
        安卓系统规定：扫描附近蓝牙设备必须先允许定位权限，否则一台设备都搜不到。
      </view>
      <view class="notice-advice">
        <view class="advice-item">· 之前拒绝过的话，要去设置页手动打开</view>
        <view class="advice-item">· 另外请确认手机的定位开关是打开的</view>
      </view>
      <text class="btn-link notice-action" @click="onFixPermission">
        {{ needSetting ? '打开设置页' : '重新申请' }}
      </text>
    </view>

    <!-- 蓝牙本身不可用 -->
    <view class="notice notice-error" v-if="adapterState === 'error' && adapterError">
      <view class="notice-title">{{ adapterError.title }}</view>
      <view class="notice-body">{{ adapterError.message }}</view>
      <view class="notice-advice" v-if="adapterError.advice.length">
        <view v-for="(item, i) in adapterError.advice" :key="i" class="advice-item">· {{ item }}</view>
      </view>
      <text class="btn-link notice-action" @click="initAdapter">重新检查</text>
    </view>

    <!-- 以下都是「蓝牙已就绪」之后的内容 -->

    <!-- 扫描状态条 -->
    <view class="scan-bar" v-if="adapterState === 'ok'">
      <view class="scan-state">
        <view class="mini-spinner" v-if="scanning" />
        <view class="dot dot-ok" v-else />
        <text class="scan-text">{{ scanning ? '正在扫描附近设备…' : '已停止扫描' }}</text>
      </view>
      <view class="scan-actions">
        <text class="btn-link" @click="onRefresh">重新扫描</text>
        <view class="scan-divider" />
        <text class="btn-link" @click="onToggleShowAll">{{ showAll ? '只看可配网' : '显示全部' }}</text>
      </view>
    </view>

    <!-- 连接失败详情 -->
    <view class="notice notice-error" v-if="error && adapterState === 'ok'">
      <view class="notice-title">{{ error.title }}</view>
      <view class="notice-body">{{ error.message }}</view>
      <view class="notice-advice" v-if="error.advice.length">
        <view v-for="(item, i) in error.advice" :key="i" class="advice-item">· {{ item }}</view>
      </view>
      <text class="btn-link notice-action" @click="onCopyError">复制错误信息</text>
    </view>

    <!-- 扫描超时排查清单 -->
    <view class="notice notice-warn" v-if="hint && !error && adapterState === 'ok'">
      <view class="notice-body">{{ hint }}</view>
    </view>

    <!-- 设备列表 -->
    <view class="card card-tight" v-if="devices.length && adapterState === 'ok'">
      <view
        class="row device-row"
        v-for="item in devices"
        :key="item.deviceId"
        @click="onConnect(item)"
      >
        <view class="row-main">
          <view class="device-name">
            <text class="ellipsis">{{ item.name }}</text>
            <text class="badge badge-brand" v-if="item.matched">可配网</text>
          </view>
          <view class="row-sub">{{ item.shortId }} · {{ item.rssiText }}</view>
        </view>
        <view class="row-extra">
          <view class="bars">
            <view class="bar bar-1" :class="{ on: item.bars >= 1 }" />
            <view class="bar bar-2" :class="{ on: item.bars >= 2 }" />
            <view class="bar bar-3" :class="{ on: item.bars >= 3 }" />
            <view class="bar bar-4" :class="{ on: item.bars >= 4 }" />
          </view>
          <view class="connect-btn" :class="{ connecting: connectingId === item.deviceId }">
            {{ connectingId === item.deviceId ? '连接中' : '连接' }}
          </view>
        </view>
      </view>
    </view>

    <!-- 空状态 -->
    <view class="card empty-card" v-else-if="scanning && adapterState === 'ok'">
      <view class="spinner" />
      <view class="empty-title">正在查找设备</view>
      <view class="empty-desc">请确认设备已通电，并且处于配网模式</view>
    </view>

    <view class="card empty-card" v-else-if="adapterState === 'ok'">
      <view class="empty-title">没找到设备</view>
      <view class="empty-desc">广播名以 <text class="mono">{{ namePrefix }}</text> 开头的设备才是可配网设备</view>
      <button class="btn btn-ghost retry-btn" @click="onRefresh">重新扫描</button>
    </view>

    <!-- 上次配网：一键复用（原来在首页，首页删掉后挪到这里） -->
    <view class="card" v-if="adapterState === 'ok' && lastRecord && !reuseActive">
      <view class="row">
        <view class="row-main">
          <view class="row-title ellipsis">上次配过「{{ lastRecord.ssid }}」</view>
          <view class="row-sub">{{ lastRecordText }}</view>
        </view>
        <view class="row-extra">
          <text class="btn-link" @click="onReuseLast">用同样配置</text>
        </view>
      </view>
      <view class="row">
        <view class="row-main">
          <view class="row-sub">设备：{{ lastRecord.deviceName || '未知设备' }}</view>
        </view>
        <view class="row-extra">
          <text class="btn-link" @click="onClearHistory">清空记录</text>
        </view>
      </view>
    </view>

    <view class="reuse-tip" v-if="adapterState === 'ok' && reuseActive">
      已选择复用上次的 Wi-Fi 和城市，连接设备后只需要重新输入密码
    </view>

    <!-- 底部提示 -->
    <view class="footer-tip" v-if="adapterState === 'ok'">
      已发现 {{ totalCount }} 个蓝牙设备，其中 {{ matchedCount }} 个可配网
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * 设备扫描页
 * ---------------------------------------------------------------------------
 * 只做一件事：把周围「可配网的设备」找出来，让用户点一下连上。
 *
 * 设计取舍：
 *   - 默认只显示匹配上的设备（广播名以 CS- 开头，或广播里带 0xFF00 / 芯海厂商 ID），
 *     避免用户在一堆耳机、手环里找。给一个「显示全部蓝牙设备」的开关用于排查。
 *   - 连接成功后就地把通知能力准备好，但**不开通知** —— 因为开通知会让设备立刻
 *     开始扫 Wi-Fi，而 Wi-Fi 列表要到下一个页面才有人接收，先开就丢了。
 *   - 扫描超时不是简单报错，而是给一份现场排查清单。
 */

import { ref, computed } from 'vue';
import { onLoad, onUnload } from '@dcloudio/uni-app';
import { config } from '../../config.ts';
import { ble, describeError, errorToPlainText, type ErrorInfo, type ScannedDevice } from '../../ble/index.ts';
import { useBleEvents } from '../../composables/useBle.ts';
import { flow, resetFlow } from '../../store/flow.ts';
import { getLastRecord, clearHistory, type HistoryRecord } from '../../utils/storage.ts';

const scanning = ref(true);
const devices = ref<ScannedDevice[]>([]);
const showAll = ref(false);
const connectingId = ref('');
const hint = ref('');
const error = ref<ErrorInfo | null>(null);
const matchedCount = ref(0);
const totalCount = ref(0);

/**
 * 适配器自检状态。
 *
 * 就绪之前**不显示扫描 UI** —— 否则会误导用户：界面写着「正在扫描」，
 * 其实根本没开始扫（安卓没定位权限时，扫描返回的是空列表，不是报错）。
 */
type AdapterState = 'checking' | 'ok' | 'needLocation' | 'error';
const adapterState = ref<AdapterState>('checking');
const adapterError = ref<ErrorInfo | null>(null);
/** true = 用户之前拒绝过定位权限，authorize 不会再弹窗，只能引导去设置页 */
const needSetting = ref(false);

/** 上次配网记录（原来在首页，首页删掉后挪到这里） */
const lastRecord = ref<HistoryRecord | null>(null);

const namePrefix = computed(() => (config.ble.deviceNamePrefixes || []).join(' / ') || '（未配置）');

const lastRecordText = computed(() => {
  const r = lastRecord.value;
  if (!r) return '';
  const parts: string[] = [];
  if (r.city) parts.push(r.city + (r.district ? ' ' + r.district : ''));
  parts.push(r.success ? '配网成功' : '配网未完成');
  parts.push(formatTime(r.time));
  return parts.join(' · ');
});

/** 相对时间：刚刚 / x 分钟前 / x 小时前 / x 天前 / 具体日期 */
function formatTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前';
  const d = new Date(ts);
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

/** 去重用的原始表：deviceId → 最新一条 */
let deviceMap: Record<string, ScannedDevice> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let destroyed = false;
/** 是否处于「复用上次配置」模式：连接设备后跳过选网和选城市 */
const reuseActive = ref(false);

/** 设备上报非常密集，节流到 300ms 一次，避免频繁渲染卡界面 */
function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 300);
}

function flush(): void {
  const all: ScannedDevice[] = [];
  const matched: ScannedDevice[] = [];
  for (const key of Object.keys(deviceMap)) {
    const d = deviceMap[key];
    all.push(d);
    if (d.matched) matched.push(d);
  }

  const list = (showAll.value ? all : matched).slice();
  // 目标设备排前面；同为（或同为不是）目标设备时按信号从强到弱
  list.sort((a, b) => {
    if (a.matched !== b.matched) return a.matched ? -1 : 1;
    return (b.rssi === null ? -999 : b.rssi) - (a.rssi === null ? -999 : a.rssi);
  });

  devices.value = list;
  matchedCount.value = matched.length;
  totalCount.value = all.length;

  // 扫到目标设备就别再提示「没扫到」了
  if (matched.length > 0 && hint.value) {
    hint.value = '';
    clearScanTimer();
  }
}

function clearScanTimer(): void {
  if (scanTimer) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
}

function clearTimers(): void {
  clearScanTimer();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function armScanTimeout(): void {
  clearScanTimer();
  scanTimer = setTimeout(() => {
    if (destroyed) return;
    // 扫到一个可配网设备都不算失败，所以只有真的一个都没扫到时才提示
    if (matchedCount.value === 0) {
      hint.value = errorToPlainText(describeError('TIMEOUT_SCAN'));
    }
  }, config.timeouts.scan);
}

async function startScan(): Promise<void> {
  scanning.value = true;
  hint.value = '';
  error.value = null;
  devices.value = [];
  matchedCount.value = 0;
  totalCount.value = 0;
  deviceMap = {};

  try {
    await ble.startScan();
  } catch (e) {
    if (destroyed) return;
    scanning.value = false;
    error.value = describeError(e);
    return;
  }

  armScanTimeout();
}

function onDeviceFound(device: ScannedDevice): void {
  deviceMap[device.deviceId] = device;
  scheduleFlush();
}

async function onConnect(device: ScannedDevice): Promise<void> {
  if (connectingId.value) return;

  connectingId.value = device.deviceId;
  error.value = null;
  hint.value = '';
  uni.showLoading({ title: '连接中…', mask: true });

  try {
    await ble.stopScan();
    scanning.value = false;

    await ble.connect(device.deviceId, device.name);

    uni.hideLoading();

    const conn = ble.connection;
    flow.device = {
      deviceId: device.deviceId,
      name: device.name,
      rssi: device.rssi,
      mtu: conn.mtu,
      chunkSize: conn.chunkSize
    };

    if (reuseActive.value && flow.prefill && flow.prefill.ssid) {
      // 「再配一次」：Wi-Fi 名和城市都从历史记录回填，用户只需重输密码
      flow.wifi = { ssid: flow.prefill.ssid, manual: false, fromHistory: true };
      flow.provision = {
        ssid: flow.prefill.ssid,
        pwd: '',
        city: flow.prefill.city || '',
        district: flow.prefill.district || ''
      };
      uni.redirectTo({ url: '/pages/password/password' });
    } else {
      uni.redirectTo({ url: '/pages/wifi/wifi' });
    }
  } catch (e) {
    uni.hideLoading();
    console.warn('[scan] 连接失败:', e);

    // 半截连接要让客户端丢掉，否则下一次连接会被残留状态干扰
    try {
      await ble.disconnect();
    } catch {
      /* 忽略 */
    }

    if (destroyed) return;
    connectingId.value = '';
    error.value = describeError(e);
    // 让用户可以直接重试，不用手动点重新扫描
    void startScan();
  }
}

function onToggleShowAll(): void {
  showAll.value = !showAll.value;
  flush();
  uni.showToast({ title: showAll.value ? '显示全部蓝牙设备' : '只显示可配网设备', icon: 'none' });
}

function onRefresh(): void {
  void startScan();
}

function onCopyError(): void {
  const d = error.value;
  if (!d) return;
  uni.setClipboardData({ data: `[${d.code}] ${d.title} ${d.message}` });
}

/**
 * 启动自检：打开蓝牙适配器 + 申请定位权限。
 * 一路通过就直接开始扫描 —— **用户不需要点任何按钮**（原来首页那个「开始配网」已经删掉）。
 *
 * 为什么定位权限是硬门槛：安卓系统规定，扫描附近蓝牙设备必须有定位权限。
 * 没有它，`startBluetoothDevicesDiscovery` **不报错但永远返回空列表**，
 * 表现就是"转圈转到超时、一个设备都搜不到"，很难排查。所以这里先在门口拦下来。
 *
 * 蓝牙权限不需要单独申请：那是系统级权限，由微信 App 统一持有，
 * 小程序侧只有 `openBluetoothAdapter` 这一个入口（失败会给出 10001 等错误码）。
 */
async function initAdapter(): Promise<void> {
  adapterState.value = 'checking';
  adapterError.value = null;
  needSetting.value = false;

  try {
    const res = await ble.openAdapter();

    if (!res.locationOk) {
      adapterState.value = 'needLocation';
      needSetting.value = res.needSetting;
      return;
    }

    adapterState.value = 'ok';
    void startScan();
  } catch (e) {
    adapterState.value = 'error';
    adapterError.value = describeError(e);
    console.warn('[scan] 蓝牙自检失败:', e);
  }
}

/**
 * 权限没通过时点这个：
 *   - 还没问过 / 系统定位开关没开 → 再走一次申请流程（会弹系统授权框）
 *   - 用户之前拒绝过（authorize 不会再弹窗）→ 直接送到小程序设置页
 */
async function onFixPermission(): Promise<void> {
  if (!needSetting.value) {
    void initAdapter();
    return;
  }
  try {
    const res = await ble.openPermissionSetting();
    if (res.granted) {
      void initAdapter();
    } else {
      uni.showToast({ title: '仍未授权定位权限', icon: 'none' });
    }
  } catch {
    uni.showToast({ title: '打开设置失败', icon: 'none' });
  }
}

function loadHistory(): void {
  try {
    lastRecord.value = getLastRecord();
  } catch {
    lastRecord.value = null;
  }
}

/**
 * 用上次的 Wi-Fi 和城市再配一次。
 * 先把上次的 Wi-Fi 名和城市填进 prefill，连接设备后就会跳过选网和选城市，
 * 用户只需要重新输一遍密码。
 */
function onReuseLast(): void {
  const r = lastRecord.value;
  if (!r) return;
  resetFlow(false);
  flow.prefill = {
    ssid: r.ssid,
    city: r.city || '',
    district: r.district || ''
  };
  reuseActive.value = true;
  uni.showToast({ title: '连接设备后复用上次配置', icon: 'none' });
}

function onClearHistory(): void {
  uni.showModal({
    title: '清空配网记录',
    content: '会删掉本机保存的配网历史，不影响设备上的配置。',
    success: (res) => {
      if (res.confirm) {
        clearHistory();
        loadHistory();
        uni.showToast({ title: '已清空', icon: 'success' });
      }
    }
  });
}

/**
 * 事件订阅必须在 setup 阶段同步完成，这样组件卸载时的清理逻辑才挂得上。
 * 写在 onLoad 回调里就来不及注册了 —— 这是这类小程序最容易漏的地方。
 */
useBleEvents({ device: onDeviceFound });

onLoad((options) => {
  reuseActive.value = !!(options && options.reuse === '1');
  loadHistory();
  // 打开小程序就直接做自检并开始扫描，没有「开始配网」这一步
  void initAdapter();
});

onUnload(() => {
  destroyed = true;
  clearTimers();
  // 连接成功后在跳转前已经停过扫描了，这里只处理用户直接返回的情况
  void ble.stopScan();
});
</script>

<style scoped>
.scan-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8rpx 8rpx 24rpx;
}

.scan-state {
  display: flex;
  align-items: center;
}

.scan-state .mini-spinner {
  margin-right: 14rpx;
}

.scan-state .dot {
  margin-right: 14rpx;
}

.scan-text {
  font-size: 26rpx;
  color: #6b7280;
}

.scan-actions {
  display: flex;
  align-items: center;
}

.scan-divider {
  width: 1rpx;
  height: 24rpx;
  background: #e2e5e9;
  margin: 0 20rpx;
}

.device-row:active {
  background: #f7f8fa;
}

.device-name {
  display: flex;
  align-items: center;
  min-width: 0;
}

.device-name .ellipsis {
  max-width: 380rpx;
}

.device-name .badge {
  margin-left: 14rpx;
  flex-shrink: 0;
}

.connect-btn {
  margin-left: 24rpx;
  padding: 10rpx 28rpx;
  border-radius: 32rpx;
  background: #07c160;
  color: #ffffff;
  font-size: 26rpx;
  line-height: 1.5;
  white-space: nowrap;
}

.connect-btn.connecting {
  background: #e2e5e9;
  color: #8a9099;
}

.empty-card {
  text-align: center;
  padding: 80rpx 40rpx;
}

.retry-btn {
  margin-top: 40rpx;
}

.footer-tip {
  text-align: center;
  font-size: 24rpx;
  color: #a0a6ad;
  padding: 24rpx 0 8rpx;
}

.reuse-tip {
  margin-top: 16rpx;
  padding: 20rpx 24rpx;
  background: #eef7f1;
  border-radius: 16rpx;
  font-size: 26rpx;
  color: #0a7a45;
  line-height: 1.6;
}
</style>
