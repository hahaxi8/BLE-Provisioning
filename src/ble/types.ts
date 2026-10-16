/**
 * 领域类型定义（纯类型，不含任何运行时代码）
 * ---------------------------------------------------------------------------
 * 这个文件被 Node 的 TypeScript 类型剥离完全抹掉，所以它不产生任何运行时开销。
 * 所有 import 都必须走 `import type`。
 */

/* ========================================================================== *
 * 协议层
 * ========================================================================== */

/** 设备推送的一条 Wi-Fi 记录（宽容解析后的形态） */
export interface WifiEntry {
  ssid: string;
  /** 信号强度 dBm；设备没给就是 null */
  rssi: number | null;
  /** 加密方式原始值；设备没给就是 null */
  sec: unknown;
}

/** 解析 Wi-Fi 列表的结果 */
export interface WifiListResult {
  ok: boolean;
  list: WifiEntry[];
  empty: boolean;
  raw: unknown;
}

/** 设备回报的配网状态 */
export type DeviceStateValue = 'success' | 'fail' | 'unknown';

export interface DeviceStateResult {
  state: DeviceStateValue;
  reason: string;
  raw: unknown;
}

/** 待下发给设备的配网数据 */
export interface WifiConfig {
  ssid: string;
  pwd: string;
  city?: string;
  district?: string;
  latitude?: number;
  longitude?: number;
}

/** 构造好的配网报文 */
export interface WifiConfigPayload {
  text: string;
  bytes: Uint8Array;
  arrayBuffer: ArrayBuffer;
  object: WifiConfig;
}

/** 解析后的广播包内容 */
export interface ServiceDataEntry {
  uuid: string;
  data: Uint8Array;
}

export interface ManufacturerData {
  id: number;
  data: Uint8Array;
}

export interface AdvertisData {
  flags: number | null;
  localName: string;
  serviceUuids: string[];
  serviceData: ServiceDataEntry[];
  manufacturer: ManufacturerData | null;
}

/** 一条扫描结果（已判定是否为目标设备） */
export interface ScannedDevice {
  deviceId: string;
  /** 展示用名字 */
  name: string;
  localName: string;
  rssi: number | null;
  /** 0~4 信号格 */
  bars: number;
  /** 是否判定为可配网设备 */
  matched: boolean;
  /** 广播内容命中 */
  advertised: boolean;
  /** 广播名命中 */
  named: boolean;
  /** 短 id，界面用 */
  shortId: string;
  /** RSSI 展示文案 */
  rssiText: string;
}

/** 过滤判定结果 */
export interface FilterMatchResult {
  matched: boolean;
  nameMatch: boolean;
  advMatch: boolean;
  displayName: string;
  parsed: AdvertisData;
}

/** 输入的原始设备信息（来自扫描回调，各平台字段名不同） */
export interface RawDevice {
  deviceId?: string;
  name?: string;
  localName?: string;
  RSSI?: number;
  advertisData?: ArrayBuffer | Uint8Array | null;
  advertisServiceUUIDs?: string[] | null;
}

/* ========================================================================== *
 * 错误
 * ========================================================================== */

export interface ErrorInfo {
  code: number | string;
  title: string;
  message: string;
  advice: string[];
  raw: unknown;
}

/* ========================================================================== *
 * 配置类型
 * ---------------------------------------------------------------------------
 * 放在这里而不是 config.ts，是为了让 protocol.ts 只 import 类型、不 import 值 ——
 * import type 会被完全擦除，协议层因此保持零运行时依赖，Node 能直接跑单测。
 * ========================================================================== */

/** 设备过滤策略 */
export type FilterMode = 'name' | 'adv' | 'name-or-adv' | 'name-and-adv';

/** BLE 协议相关配置：必须与设备侧一致 */
export interface BleConfig {
  /** 服务 UUID（设备侧 GATTS_SERVICE_FF00_UUID = 0xFF00） */
  serviceUuid: string;
  /** 写特征：手机 → 设备（设备侧 0xFF01） */
  writeCharUuid: string;
  /** 通知特征：设备 → 手机（设备侧 0xFF02） */
  notifyCharUuid: string;
  /** 设备广播名前缀白名单。设备侧示例是 "CS-" + MAC 前 3 字节 */
  deviceNamePrefixes: string[];
  /** 广播里 Service Data (AD type 0x16) 携带的 16 位 UUID，设备侧写的是 FF00 */
  serviceDataUuid16: string;
  /** 广播里厂商自定义数据 (AD type 0xFF) 的厂商 ID，芯海是 0x06A7 */
  manufacturerId: number;
  /** 设备过滤策略 */
  filterMode: FilterMode;
  /** 期望协商的 ATT MTU。注意只有安卓支持 uni.setBLEMTU，iOS 由系统协商 */
  preferredMtu: number;
  /** 单包最大字节数的兜底值（MTU 23 - 3 字节 ATT 头） */
  fallbackChunkSize: number;
  /** 分包写入之间的间隔，太密会被协议栈丢包 */
  writeChunkDelayMs: number;
  /** 扫描时是否允许重复上报同一设备（允许才能实时刷新 RSSI） */
  allowDuplicates: boolean;
  /** 设备侧「城市名 / 区级名」字符串的可用字节数（UTF-8 计） */
  deviceTextMaxBytes: number;
}

/* ========================================================================== *
 * BLE 适配器接口
 * ---------------------------------------------------------------------------
 * 整个小程序只认这个接口，不认 uni / wx / plus。
 * 以后出 App 端时，只要再写一个实现这个接口的适配器，业务代码一行都不用改。
 * ========================================================================== */

/** 发现服务与特征值的结果 */
export interface DiscoveredGatt {
  serviceId: string;
  writeCharId: string;
  notifyCharId: string;
  /** 'write' = 带响应写（设备侧声明的是 WRITE_REQ）；'writeNoResponse' = 无响应写 */
  writeType: 'write' | 'writeNoResponse';
}

/** 打开适配器的结果 */
export interface AdapterOpenResult {
  opened: boolean;
  /** 定位权限是否就绪（仅安卓需要，其他平台恒为 true） */
  locationOk: boolean;
  /** 是否需要用户去设置页手动开权限 */
  needSetting: boolean;
}

/** 平台能力探测：不同平台支持的接口不一样，界面据此隐藏/降级 */
export interface AdapterCapabilities {
  /** 平台标识：'mp-weixin' | 'app' | 'h5' ... */
  platform: string;
  /** 是否支持协商 MTU（只有安卓微信小程序支持） */
  supportsSetMtu: boolean;
  /** 是否支持读 RSSI */
  supportsRssi: boolean;
  /** 是否支持重新触发设备扫描（关通知→开通知） */
  supportsRescan: boolean;
}

/**
 * BLE 客户端向外发出的事件表。
 *
 * 有了这张表，`ble.on('wifiLst', …)` 这种拼写错误会在编译期就被拦下来，
 * 而不是等到真机上「怎么没反应」再回头查。每个事件的负载类型也是确定的。
 */
export interface BleConnectedInfo {
  deviceId: string;
  deviceName: string;
  gatt: DiscoveredGatt | null;
  mtu: number;
}

export interface BleDisconnectedInfo {
  deviceId: string;
}

export interface BleEventMap {
  /** 扫到一个设备（含重复上报的刷新） */
  device: ScannedDevice;
  /** 设备推送的 Wi-Fi 列表 */
  wifiList: WifiListResult;
  /** 设备回报的配网结果 */
  state: DeviceStateResult;
  /** 设备发过来的任何已解析 JSON（排查用） */
  message: unknown;
  /** 认不出类型的报文 */
  unknown: unknown;
  connected: BleConnectedInfo;
  disconnected: BleDisconnectedInfo;
  /** 适配器已关闭 */
  closed: undefined;
}

/** 某个事件的监听函数类型 */
export type BleListener<K extends keyof BleEventMap = keyof BleEventMap> = (
  payload: BleEventMap[K]
) => void;

/**
 * 蓝牙适配器接口。
 *
 * 所有方法都返回 Promise，失败时 reject 一个 `{ errCode, errMsg }` 形态的对象
 * （微信原样抛，App 端自己造），交给 `ble/errors.ts` 翻译成人话。
 */
export interface BleAdapter {
  readonly capabilities: AdapterCapabilities;

  /** 打开适配器。必须在其它调用之前执行 */
  openAdapter(): Promise<AdapterOpenResult>;

  /** 请求定位权限（安卓专有），已授权/不需要则直接返回 */
  requestLocationPermission(): Promise<{ ok: boolean; needSetting: boolean }>;

  /** 打开小程序设置页，返回用户是否授权了定位 */
  openPermissionSetting(): Promise<{ granted: boolean }>;

  /** 开始扫描；每发现/刷新一个设备回调一次 */
  startScan(onDevice: (device: RawDevice, res: { devices: RawDevice[] }) => void): Promise<void>;

  /** 停止扫描（页面离开必须调用） */
  stopScan(): Promise<void>;

  /** 监听连接状态变化；返回取消订阅函数 */
  onConnectionStateChange(cb: (connected: boolean) => void): () => void;

  /** 连接设备 */
  connect(deviceId: string): Promise<void>;

  /** 发现配网服务与特征值 */
  discover(deviceId: string): Promise<DiscoveredGatt>;

  /** 协商 MTU，返回实际值；拿不到返回 0 */
  negotiateMtu(deviceId: string, writeType: 'write' | 'writeNoResponse'): Promise<number>;

  /** 打开通知（这个动作同时会让设备开始扫 Wi-Fi） */
  enableNotify(deviceId: string, serviceId: string, notifyCharId: string): Promise<void>;

  /** 关闭通知 */
  disableNotify(deviceId: string, serviceId: string, notifyCharId: string): Promise<void>;

  /** 监听通知数据；返回取消订阅函数 */
  onNotify(cb: (value: ArrayBuffer) => void): () => void;

  /** 写一个分片（调用方负责分包与间隔） */
  writeChunk(
    deviceId: string,
    serviceId: string,
    writeCharId: string,
    value: ArrayBuffer,
    writeType: 'write' | 'writeNoResponse'
  ): Promise<void>;

  /** 读已连接设备的 RSSI；不支持或失败返回 null */
  readRssi(deviceId: string): Promise<number | null>;

  /** 断开连接 */
  disconnect(deviceId: string): Promise<void>;

  /** 关闭适配器 */
  closeAdapter(): Promise<void>;
}
