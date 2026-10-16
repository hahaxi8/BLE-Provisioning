/**
 * BLE 配网客户端（平台无关的编排层）
 * ---------------------------------------------------------------------------
 * 把「打开适配器 → 扫描 → 连接 → 发现服务 → 开通知 → 收 Wi-Fi 列表 →
 * 下发配置 → 收结果」这条链路编排起来。
 *
 * 关键设计：**本文件不 import 任何平台模块**，适配器从构造函数注入。
 * 带来两个直接好处：
 *   1. 以后出 App 端，这里一行都不用改；
 *   2. 单元测试可以塞一个假适配器，把整条流程（分包写、分片重组、超时、
 *      重扫、断开）在 Node 里完整跑一遍 —— 设备固件还没做出来也能验证逻辑。
 *
 * 处理的几个真实坑（都是真机上会遇到的）：
 *
 *   1. 收包分片：设备一条 JSON 可能被 MTU 切成多片推上来，甚至两片之间正好
 *      切断一个中文字符。这里先按字节流拼接、再按 UTF-8 边界解码、
 *      最后用括号配平的方式从流里提取完整 JSON（见 protocol.ts）。
 *   2. 写并发限制：iOS 上连续快速 write 会报 system error，所以串行 + 间隔。
 *   3. MTU 差异：安卓能协商到 512，iOS 拿不到值，按 23 兜底（每包 20 字节）。
 *   4. 重新扫描：协议里没有「重新扫描」命令，设备只在收到 CCCD 写 0x0001 时
 *      才扫一次。所以用「关通知 → 开通知」重新触发。
 */

import type {
  AdapterOpenResult,
  BleAdapter,
  BleEventMap,
  BleListener,
  DeviceStateResult,
  DiscoveredGatt,
  RawDevice,
  ScannedDevice,
  WifiConfigPayload,
  WifiListResult
} from './types.ts';
import type { AppSettings } from '../config.ts';
import { config as defaultSettings } from '../config.ts';
import { classifyPayload, chunkBytes, concatBytes, decodeUtf8Stream, deviceMatchesFilter, extractJsonValues, parseDeviceState, parseWifiList, rssiToBars, toArrayBuffer } from './protocol.ts';

/**
 * 内部用的宽松监听函数类型。
 * 对外暴露的 on/off 是带 BleEventMap 约束的泛型版本，这里只是为了能存进同一个表。
 */
type InternalListener = (payload: unknown) => void;

/** deviceId 很长，列表里只显示尾部，方便用户区分同名设备 */
export function shortDeviceId(deviceId: string): string {
  const s = String(deviceId || '');
  const hex = s.replace(/[^0-9A-Fa-f]/g, '');
  return (hex.slice(-6) || s.slice(-6)).toUpperCase();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 给一个 Promise 加超时；超时抛自定义错误键，交给 errors.ts 翻译 */
export function withTimeout<T>(promise: Promise<T>, ms: number, timeoutKey: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(timeoutKey || { errCode: -1, errMsg: 'timeout' });
      }
    }, ms);
    promise.then(
      (v) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      (e) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(e);
        }
      }
    );
  });
}

/** 把原始的扫描结果归一化成界面能直接用的形态 */
export function toScannedDevice(raw: RawDevice, settings: AppSettings): ScannedDevice {
  const match = deviceMatchesFilter(raw, settings.ble);
  const rssi = typeof raw.RSSI === 'number' ? raw.RSSI : null;
  const deviceId = String(raw.deviceId || '');
  return {
    deviceId,
    name: match.displayName || '未命名设备',
    localName: match.parsed.localName || '',
    rssi,
    bars: rssiToBars(rssi),
    matched: match.matched,
    advertised: match.advMatch,
    named: match.nameMatch,
    shortId: shortDeviceId(deviceId),
    rssiText: rssi === null ? '信号未知' : `${rssi} dBm`
  };
}

/** 当前连接状态快照，界面用 */
export interface BleConnection {
  deviceId: string;
  deviceName: string;
  gatt: DiscoveredGatt | null;
  mtu: number;
  chunkSize: number;
  notifyEnabled: boolean;
}

export class BleClient {
  private adapter: BleAdapter;
  private settings: AppSettings;

  private listeners: Record<string, InternalListener[]> = {};

  private deviceId = '';
  private deviceName = '';
  private gatt: DiscoveredGatt | null = null;
  private mtuValue = 0;
  private chunkSizeValue = 20;
  private notifyOn = false;
  private adapterOpened = false;

  private rxCarry: Uint8Array = new Uint8Array(0);
  private rxText = '';
  private rxIdleTimer: ReturnType<typeof setTimeout> | null = null;

  private offNotify: (() => void) | null = null;
  private offConn: (() => void) | null = null;

  /** 扫描发现计数，用于判断「一个都没扫到」 */
  private scanCount = 0;

  constructor(adapter: BleAdapter, settings: AppSettings = defaultSettings) {
    this.adapter = adapter;
    this.settings = settings;
    this.chunkSizeValue = settings.ble.fallbackChunkSize;
  }

  /* ================================================================ 事件 */

  /**
   * 订阅事件。
   *
   * 事件名和负载类型都由 BleEventMap 约束：
   *   ble.on('wifiLst', …)      → 编译期就报错，不用等真机上「怎么没反应」
   *   ble.on('wifiList', (p) => …)  → p 自动推断成 WifiListResult
   */
  on<K extends keyof BleEventMap>(event: K, fn: BleListener<K>): void {
    let list = this.listeners[event];
    if (!list) {
      list = [];
      this.listeners[event] = list;
    }
    list.push(fn as unknown as InternalListener);
  }

  off<K extends keyof BleEventMap>(event: K, fn?: BleListener<K>): void {
    const list = this.listeners[event];
    if (!list) {
      return;
    }
    if (!fn) {
      delete this.listeners[event];
      return;
    }
    const target = fn as unknown as InternalListener;
    this.listeners[event] = list.filter((f) => f !== target);
  }

  emit<K extends keyof BleEventMap>(event: K, payload?: BleEventMap[K]): void {
    const list = this.listeners[event] || [];
    for (const fn of list) {
      try {
        fn(payload);
      } catch (e) {
        // 单个监听器出错不能影响其它监听器和连接本身
        console.error('[ble-client] listener error on "' + String(event) + '":', e);
      }
    }
  }

  /* ============================================================== 状态 */

  get connection(): BleConnection {
    return {
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      gatt: this.gatt,
      mtu: this.mtuValue,
      chunkSize: this.chunkSizeValue,
      notifyEnabled: this.notifyOn
    };
  }

  get capabilities() {
    return this.adapter.capabilities;
  }

  isConnected(): boolean {
    return !!this.deviceId && !!this.gatt;
  }

  isNotifyEnabled(): boolean {
    return this.notifyOn;
  }

  /* ========================================================== 适配器 */

  async openAdapter(): Promise<AdapterOpenResult> {
    if (this.adapterOpened) {
      return { opened: true, locationOk: true, needSetting: false };
    }
    const res = await this.adapter.openAdapter();
    this.adapterOpened = true;
    return res;
  }

  async requestLocationPermission(): Promise<{ ok: boolean; needSetting: boolean }> {
    return this.adapter.requestLocationPermission();
  }

  async openPermissionSetting(): Promise<{ granted: boolean }> {
    return this.adapter.openPermissionSetting();
  }

  /* ============================================================== 扫描 */

  /** 开始扫描。每发现/刷新一个设备就 emit('device', ScannedDevice) */
  async startScan(): Promise<void> {
    if (!this.adapterOpened) {
      await this.openAdapter();
    }
    this.scanCount = 0;

    await this.adapter.startScan((raw: RawDevice) => {
      try {
        this.scanCount++;
        this.emit('device', toScannedDevice(raw, this.settings));
      } catch (e) {
        console.warn('[ble-client] 归一化扫描结果失败:', e);
      }
    });
  }

  async stopScan(): Promise<void> {
    await this.adapter.stopScan();
  }

  /** 本轮扫描一共上报过多少个设备（含刷新） */
  get scanReportCount(): number {
    return this.scanCount;
  }

  /* ============================================================== 连接 */

  /**
   * 连接设备并完成服务发现与 MTU 协商。
   * 刻意**不打开通知** —— 因为开通知会让设备立刻开始扫 Wi-Fi，而 Wi-Fi 列表
   * 要到下一个页面才有人接收，先开就丢了。谁需要列表谁负责开。
   */
  async connect(deviceId: string, deviceName: string): Promise<DiscoveredGatt> {
    if (!this.adapterOpened) {
      await this.openAdapter();
    }
    await this.stopScan();

    await withTimeout(
      this.adapter.connect(deviceId),
      this.settings.timeouts.connect + 3000,
      { errCode: 10012, errMsg: 'connect timeout' }
    );

    this.deviceId = deviceId;
    this.deviceName = deviceName || '';

    this.gatt = await withTimeout(
      this.adapter.discover(deviceId),
      this.settings.timeouts.discover,
      { code: 'SERVICE_NOT_FOUND' }
    );

    this.mtuValue = await this.adapter.negotiateMtu(deviceId, this.gatt.writeType);
    this.chunkSizeValue = this.mtuValue
      ? Math.max(this.settings.ble.fallbackChunkSize, this.mtuValue - 3)
      : this.settings.ble.fallbackChunkSize;

    this.bindConnectionHandler();
    this.emit('connected', { deviceId, deviceName: this.deviceName, gatt: this.gatt, mtu: this.mtuValue });

    return this.gatt;
  }

  private bindConnectionHandler(): void {
    if (this.offConn) {
      return;
    }
    this.offConn = this.adapter.onConnectionStateChange((connected) => {
      if (connected) {
        return;
      }
      // 我们自己主动断的时候 disconnect() 已经把 deviceId 清了，这里不重复上报
      if (!this.deviceId) {
        return;
      }
      const lostId = this.deviceId;
      // 连接断了必须把连接态清干净：否则 isConnected() 还返回 true，
      // 页面会以为「还能继续下发」，一直等到写失败才发现设备早没了
      this.deviceId = '';
      this.gatt = null;
      this.notifyOn = false;
      this.clearRx();
      this.emit('disconnected', { deviceId: lostId });
    });
  }

  /* ============================================================== 通知 */

  /**
   * 打开通知，并开始收包。
   *
   * 关键：设备侧是在「看到 CCCD 被写 0x0001」的那一刻才开始扫 Wi-Fi 的
   * 设备只在 CCCD 被写 0x0001 时扫描一次。
   * 所以打开通知这个动作本身，就是「让设备去扫 Wi-Fi」的命令。
   *
   * 调用方必须先订阅 'wifiList' 事件再调这里，顺序反了会丢消息。
   */
  async enableNotify(): Promise<void> {
    const gatt = this.requireGatt();

    this.bindNotifyHandler();
    this.clearRx();

    await this.adapter.enableNotify(this.deviceId, gatt.serviceId, gatt.notifyCharId);
    this.notifyOn = true;
  }

  /**
   * 重新触发一次 Wi-Fi 扫描。
   *
   * 协议里没有独立的「重新扫描」命令，设备只在 CCCD 写入 0x0001 时扫。
   * 平台没有直接写描述符的接口，所以只能「关通知 → 开通知」，
   * 底层就会依次写 0x0000 和 0x0001，从而再触发一次扫描。
   *
   * 如果某些机型上不生效（系统缓存了 CCCD），退路是断开重连。
   */
  async triggerRescan(): Promise<void> {
    const gatt = this.requireGatt();
    try {
      await this.adapter.disableNotify(this.deviceId, gatt.serviceId, gatt.notifyCharId);
      this.notifyOn = false;
      await sleep(200);
    } catch {
      // 关失败也继续尝试开
    }
    this.clearRx();
    await this.adapter.enableNotify(this.deviceId, gatt.serviceId, gatt.notifyCharId);
    this.notifyOn = true;
  }

  private bindNotifyHandler(): void {
    if (this.offNotify) {
      return;
    }
    this.offNotify = this.adapter.onNotify((value) => this.handleNotifyChunk(value));
  }

  /**
   * 处理一个通知分片。
   *
   * 三步：
   *   1. 按字节拼接（因为分片边界可能切断一个多字节的汉字）
   *   2. 只解码“完整”的部分，残字节留到下一片
   *   3. 从文本流里提取所有括号配平的 JSON，完整的派发出去，没拼完的留着
   */
  handleNotifyChunk(value: ArrayBuffer): void {
    this.rxCarry = concatBytes(this.rxCarry, new Uint8Array(value));

    const decoded = decodeUtf8Stream(this.rxCarry);
    this.rxCarry = decoded.carry;
    this.rxText += decoded.text;

    this.restartRxIdleTimer();

    const extracted = extractJsonValues(this.rxText);
    this.rxText = extracted.rest;

    for (const v of extracted.values) {
      this.dispatch(v);
    }
  }

  /** 半截数据不能一直留着，否则下一轮配网的报文会被污染 */
  private restartRxIdleTimer(): void {
    if (this.rxIdleTimer) {
      clearTimeout(this.rxIdleTimer);
    }
    this.rxIdleTimer = setTimeout(() => {
      if (this.rxText || this.rxCarry.length) {
        console.warn(
          '[ble-client] 收到半截报文，超时丢弃: text="' + this.rxText + '" carry=' + this.rxCarry.length + 'B'
        );
      }
      this.clearRx();
    }, this.settings.timeouts.rxIdle);
  }

  clearRx(): void {
    if (this.rxIdleTimer) {
      clearTimeout(this.rxIdleTimer);
      this.rxIdleTimer = null;
    }
    this.rxCarry = new Uint8Array(0);
    this.rxText = '';
  }

  /** 把解析出来的 JSON 按类型分发出去 */
  private dispatch(value: unknown): void {
    // 原始报文也往外发一份：设备侧固件还在移植阶段时，界面上能直接看到
    // 设备到底发了什么，比抓串口日志方便得多
    this.emit('message', value);

    const kind = classifyPayload(value);
    if (kind === 'wifiList') {
      this.emit('wifiList', parseWifiList(value) as WifiListResult);
    } else if (kind === 'state') {
      this.emit('state', parseDeviceState(value) as DeviceStateResult);
    } else {
      this.emit('unknown', value);
    }
  }

  /* ============================================================== 下发 */

  /**
   * 分包写入配网数据。
   *
   * 必须分包：SSID 32 字节 + 密码 63 字节 + 城市/区级，JSON 轻松超过默认 MTU
   * 的可写长度（23 - 3 = 20 字节）。一次写完会失败或截断。
   *
   * 串行 + 间隔是必须的：iOS 上连续 write 会报 system error。
   *
   * 设备侧对应要求：固件不能假设「一次写 = 一条完整 JSON」，
   * 必须自己按长度累积到能 JSON.parse 为止（详见 docs/device-integration.md 的 3.1 节）。
   */
  async writeConfig(payload: WifiConfigPayload): Promise<{ chunks: number; bytes: number; chunkSize: number }> {
    const gatt = this.requireGatt();
    const bytes = payload.bytes;
    const chunks = chunkBytes(bytes, this.chunkSizeValue);

    for (let i = 0; i < chunks.length; i++) {
      await this.adapter.writeChunk(
        this.deviceId,
        gatt.serviceId,
        gatt.writeCharId,
        toArrayBuffer(chunks[i]),
        gatt.writeType
      );
      // 最后一片不用等
      if (i < chunks.length - 1) {
        await sleep(this.settings.ble.writeChunkDelayMs);
      }
    }

    return { chunks: chunks.length, bytes: bytes.length, chunkSize: this.chunkSizeValue };
  }

  /* ============================================================== 收尾 */

  async readRssi(): Promise<number | null> {
    if (!this.deviceId) {
      return null;
    }
    return this.adapter.readRssi(this.deviceId);
  }

  /** 断开当前连接（不影响适配器） */
  async disconnect(): Promise<void> {
    this.clearRx();
    this.notifyOn = false;
    const id = this.deviceId;
    this.deviceId = '';
    this.gatt = null;
    if (id) {
      await this.adapter.disconnect(id);
    }
  }

  /** 彻底收工：解绑回调、断连接、关适配器。页面 onUnload / 点「完成」时调用 */
  async close(): Promise<void> {
    await this.stopScan();

    if (this.offNotify) {
      this.offNotify();
      this.offNotify = null;
    }
    if (this.offConn) {
      this.offConn();
      this.offConn = null;
    }

    await this.disconnect();

    if (this.adapterOpened) {
      await this.adapter.closeAdapter();
    }
    this.adapterOpened = false;
    this.mtuValue = 0;
    this.chunkSizeValue = this.settings.ble.fallbackChunkSize;
    this.emit('closed');
  }

  private requireGatt(): DiscoveredGatt {
    if (!this.deviceId || !this.gatt) {
      throw { errCode: 10006, errMsg: 'not connected' };
    }
    return this.gatt;
  }
}
