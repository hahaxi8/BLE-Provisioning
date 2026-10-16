/**
 * BLE 配网协议层（纯函数，零依赖）
 * ---------------------------------------------------------------------------
 * 本文件是本项目唯一“懂协议”的地方：数据编解码、广播包解析、设备过滤都在这。
 *
 * 它**刻意不 import 任何东西**（配置通过参数传进来），带来三个好处：
 *   1. 不依赖 uni / wx，Node 能直接跑单测（`node test/run.js`）；
 *   2. 以后出 App 端、换平台，这层一行都不用改；
 *   3. 所有行为都能被测试固定住，不靠“我记得是这样”。
 *
 * 协议约定见 `docs/device-integration.md`（第 1 节「协议速查表」）。
 *
 * 通信格式（一个字节都不能改，否则设备侧解析不了）：
 *   手机 → 设备（写 0xFF01）：
 *     {"ssid":"WiFi名称","pwd":"WiFi密码","city":"深圳市","district":"南山区"}
 *   设备 → 手机（通知 0xFF02）：[{"name":"WiFi名称1"},{"name":"WiFi名称2"}]
 *   设备 → 手机（通知 0xFF02）：{"state":"success"} 或 {"state":"fail"}
 *
 * 关于 city / district：
 *   设备本身不知道自己在哪，所以配网时由用户在手机上选好、连同 SSID / 密码一起
 *   下发。值都发全称（带「市」「区」）：按约定，设备侧显示城市时会自己把末尾的
 *   「市」剥掉，而区县原样显示。
 */

import type {
  AdvertisData,
  BleConfig,
  DeviceStateResult,
  FilterMatchResult,
  ManufacturerData,
  RawDevice,
  ServiceDataEntry,
  WifiConfig,
  WifiConfigPayload,
  WifiEntry,
  WifiListResult
} from './types.ts';

/* ========================================================================== *
 * 一、字节与 UTF-8
 * ========================================================================== */

/** 把任意输入转成 Uint8Array。各平台返回 ArrayBuffer / Uint8Array / number[] 都有 */
export function toUint8Array(input: ArrayBuffer | Uint8Array | number[] | null | undefined): Uint8Array {
  if (input === null || input === undefined) {
    return new Uint8Array(0);
  }
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (Array.isArray(input)) {
    return new Uint8Array(input);
  }
  // 某些环境返回的是带 buffer 的视图
  const view = input as ArrayBufferView;
  if (view.buffer) {
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return new Uint8Array(0);
}

/** Uint8Array → ArrayBuffer（写特征要 ArrayBuffer） */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const u8 = toUint8Array(bytes);
  const out = new ArrayBuffer(u8.length);
  new Uint8Array(out).set(u8);
  return out;
}

/**
 * 字符串 → UTF-8 字节。
 *
 * 为什么不用 TextEncoder：各端对它的支持不一致，而中文 SSID 必须走 UTF-8。
 * 自己实现最可控，也便于单测。
 */
export function encodeUtf8(str: string | null | undefined): Uint8Array {
  const s = String(str === null || str === undefined ? '' : str);
  const out: number[] = [];

  for (let i = 0; i < s.length; i++) {
    let code = s.charCodeAt(i);

    // 处理代理对（emoji 等 4 字节字符）
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    // 落单的代理项按替换字符处理，避免产出非法 UTF-8
    if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd;
    }

    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return new Uint8Array(out);
}

/**
 * UTF-8 字节 → 字符串。宽容解码：非法序列替换成 U+FFFD，绝不抛异常。
 * 收到的蓝牙数据可能是脏的，不能因为一个坏字节就把整包丢了。
 */
export function decodeUtf8(input: ArrayBuffer | Uint8Array | number[]): string {
  const b = toUint8Array(input);
  const n = b.length;
  let out = '';
  let i = 0;

  while (i < n) {
    const c = b[i];
    let cp: number;
    let len: number;

    if (c < 0x80) {
      cp = c;
      len = 1;
    } else if ((c & 0xe0) === 0xc0) {
      cp = c & 0x1f;
      len = 2;
    } else if ((c & 0xf0) === 0xe0) {
      cp = c & 0x0f;
      len = 3;
    } else if ((c & 0xf8) === 0xf0) {
      cp = c & 0x07;
      len = 4;
    } else {
      out += '\ufffd';
      i++;
      continue;
    }

    if (i + len > n) {
      out += '\ufffd';
      break;
    }

    let ok = true;
    for (let k = 1; k < len; k++) {
      const cc = b[i + k];
      if ((cc & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (cc & 0x3f);
    }
    if (!ok) {
      out += '\ufffd';
      i++;
      continue;
    }
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      out += '\ufffd';
      i += len;
      continue;
    }

    if (cp > 0xffff) {
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
    i += len;
  }

  return out;
}

/**
 * 返回“可以安全解码”的字节数：如果末尾是一个被切断的多字节字符，就不要解码它。
 *
 * 用途：设备把一条长的 JSON 拆成多个 BLE 通知分片发过来时，分片边界可能正好
 * 落在某个中文字符的中间。若直接解码会产生 U+FFFD，等下一个分片到了就再也
 * 拼不回原字了。所以先判断尾部是否完整，把残字节留到下一轮。
 */
export function utf8SafeLength(input: Uint8Array): number {
  const b = toUint8Array(input);
  const n = b.length;
  if (n === 0) {
    return 0;
  }

  let i = n - 1;
  let cont = 0;
  while (i >= 0 && (b[i] & 0xc0) === 0x80) {
    cont++;
    i--;
    if (cont > 3) {
      break;
    }
  }
  if (i < 0) {
    return n; // 整段都是续字节，数据本身异常，交给宽容解码器兜底
  }

  const lead = b[i];
  let need: number;
  if (lead < 0x80) {
    need = 1;
  } else if ((lead & 0xe0) === 0xc0) {
    need = 2;
  } else if ((lead & 0xf0) === 0xe0) {
    need = 3;
  } else if ((lead & 0xf8) === 0xf0) {
    need = 4;
  } else {
    return n; // 非法首字节，照常解码（会变成 U+FFFD）
  }

  const have = cont + 1;
  if (have >= need) {
    return n;
  }
  return i; // i 之后是不完整字符，先留着
}

/** 流式解码：返回本次能解出的文本 + 需要留到下一次的残字节 */
export function decodeUtf8Stream(input: Uint8Array): { text: string; carry: Uint8Array } {
  const b = toUint8Array(input);
  const safe = utf8SafeLength(b);
  return {
    text: decodeUtf8(b.subarray(0, safe)),
    carry: b.slice(safe)
  };
}

/** 拼接多段字节 */
export function concatBytes(...parts: Array<Uint8Array | null | undefined>): Uint8Array {
  const list: Uint8Array[] = [];
  let total = 0;
  for (const p of parts) {
    const u8 = toUint8Array(p);
    if (u8.length) {
      list.push(u8);
      total += u8.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const u8 of list) {
    out.set(u8, offset);
    offset += u8.length;
  }
  return out;
}

/** 字节数组 → 大写十六进制字符串（调试日志用） */
export function bytesToHex(input: ArrayBuffer | Uint8Array | number[], separator = ' '): string {
  const b = toUint8Array(input);
  const arr: string[] = [];
  for (let i = 0; i < b.length; i++) {
    arr.push((b[i] < 16 ? '0' : '') + b[i].toString(16).toUpperCase());
  }
  return arr.join(separator);
}

/** 按字节长度切分成多个分片（用于 BLE 分包写入） */
export function chunkBytes(input: Uint8Array, chunkSize: number): Uint8Array[] {
  const b = toUint8Array(input);
  const size = Math.max(1, Math.floor(chunkSize) || 1);
  const out: Uint8Array[] = [];
  for (let i = 0; i < b.length; i += size) {
    out.push(b.slice(i, i + size));
  }
  return out.length ? out : [new Uint8Array(0)];
}

/* ========================================================================== *
 * 二、UUID
 * ========================================================================== */

/** 16 位 UUID → 128 位标准基 UUID，例如 'FF00' → '0000FF00-0000-1000-8000-00805F9B34FB' */
export function expandUuid(uuid: string | null | undefined): string {
  const raw = String(uuid === null || uuid === undefined ? '' : uuid)
    .trim()
    .toUpperCase()
    .replace(/^0X/, '');
  if (!raw) {
    return '';
  }
  if (raw.indexOf('-') >= 0) {
    return raw;
  }
  const hex = raw.replace(/[^0-9A-F]/g, '');
  if (hex.length === 4) {
    return '0000' + hex + '-0000-1000-8000-00805F9B34FB';
  }
  if (hex.length === 8) {
    return hex + '-0000-1000-8000-00805F9B34FB';
  }
  if (hex.length === 32) {
    return (
      hex.slice(0, 8) +
      '-' +
      hex.slice(8, 12) +
      '-' +
      hex.slice(12, 16) +
      '-' +
      hex.slice(16, 20) +
      '-' +
      hex.slice(20)
    );
  }
  return raw;
}

/**
 * 比较两个 UUID 是否相同。
 * 平台 API 返回的一定是 128 位形式，而配置里写的是 'FF00'，
 * 所以必须先归一化再比，不能直接字符串相等。
 */
export function uuidEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  const ea = expandUuid(a);
  const eb = expandUuid(b);
  return !!ea && ea === eb;
}

/* ========================================================================== *
 * 三、构造报文（手机 → 设备）
 * ========================================================================== */

/**
 * 构造 Wi-Fi 配网报文（SSID + 密码 + 城市 + 区级，一条 JSON 一次下发）。
 *
 * 为什么合成一条而不分开发：设备侧收到写事件就 cJSON_Parse 整包，一次解析拿全
 * 四个字段最简单，也不用担心“先收到城市后收到密码”这种半截状态。
 *
 * 字段名必须是 ssid / pwd：设备侧是 cJSON_GetObjectItem(root, "ssid"/"pwd")，
 * 写错名字设备直接 "ssid find err" 丢弃。city / district 是本项目新增字段。
 *
 * 中文一律走 UTF-8 原样字节，不做 \uXXXX 转义 —— cJSON 能正确解析 UTF-8。
 */
export function buildWifiConfigPayload(
  ssid: string,
  pwd: string,
  city?: string,
  district?: string,
  latitude?: number,
  longitude?: number
): WifiConfigPayload {
  const object: WifiConfig = {
    ssid: String(ssid === null || ssid === undefined ? '' : ssid),
    pwd: String(pwd === null || pwd === undefined ? '' : pwd)
  };

  // 空值就不塞进 JSON，避免设备侧拿到空字符串覆盖掉已有配置
  const c = String(city === null || city === undefined ? '' : city).trim();
  const d = String(district === null || district === undefined ? '' : district).trim();
  if (c) {
    object.city = c;
  }
  if (d) {
    object.district = d;
  }
  if (
    typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
  ) {
    object.latitude = Math.round(latitude * 1000000) / 1000000;
    object.longitude = Math.round(longitude * 1000000) / 1000000;
  }

  const text = JSON.stringify(object);
  const bytes = encodeUtf8(text);
  return {
    text,
    bytes,
    arrayBuffer: toArrayBuffer(bytes),
    object
  };
}

/* ========================================================================== *
 * 四、解析报文（设备 → 手机）
 * ========================================================================== */

/**
 * 从文本里找出所有“括号配平”的 JSON 值，返回解析结果和剩余未完成的尾巴。
 *
 * 为什么需要它：
 *   1) 设备一条 500 字节的 Wi-Fi 列表会被 BLE MTU 切成多个通知分片发上来，
 *      单个分片不是完整 JSON，直接 JSON.parse 必然失败；
 *   2) 反过来，两个通知也可能被系统粘在一次回调里，"}{" 连在一起。
 * 所以这里做流式提取：能解析的先拿走，拼不完整的留着等下一片。
 *
 * 字符串内部的括号和转义引号会被正确跳过（SSID 里带 {}" 也不会解析错）。
 */
export function extractJsonValues(text: string): { values: unknown[]; rest: string } {
  const src = String(text === null || text === undefined ? '' : text);
  const values: unknown[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    if (ch !== '{' && ch !== '[') {
      i++;
      continue;
    }

    const end = findBalancedEnd(src, i);
    if (end < 0) {
      // 从 i 开始是个没结束的 JSON，整段留到下一次分片再拼
      break;
    }

    const slice = src.slice(i, end + 1);
    let parsed: unknown;
    let ok = true;
    try {
      parsed = JSON.parse(slice);
    } catch {
      ok = false;
    }

    if (ok) {
      values.push(parsed);
      i = end + 1;
    } else {
      // 括号配平但内容不是合法 JSON，往后挪一格重新找起点
      i++;
    }
  }

  return { values, rest: src.slice(i) };
}

/** 找到从 start（必须是 { 或 [）开始、括号配平的结束下标；找不到返回 -1 */
export function findBalancedEnd(src: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < src.length; i++) {
    const c = src[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
    } else if (c === '{' || c === '[') {
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** 宽容取字段：设备以后加字段、换字段名都不会把小程序打挂 */
function pick(obj: Record<string, unknown> | null | undefined, names: string[]): unknown {
  if (!obj) {
    return undefined;
  }
  for (const key of names) {
    const v = obj[key];
    if (v !== undefined && v !== null && v !== '') {
      return v;
    }
  }
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 把一条原始 SSID 记录归一化成 WifiEntry。
 *
 * 当前设备示例只发 {"name":"xxx"}，没有 rssi 和加密方式。
 * 但这里把 rssi/sec 也解析出来：以后设备侧想加信号强度和锁图标，
 * 只要在 JSON 里多塞两个字段，小程序不用改就能显示。
 */
export function normalizeWifiEntry(raw: unknown): WifiEntry | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  // 极端情况：设备直接发一个纯字符串
  if (typeof raw === 'string') {
    const name = raw.trim();
    return name ? { ssid: name, rssi: null, sec: null } : null;
  }
  if (!isRecord(raw)) {
    return null;
  }

  const rawName = pick(raw, ['name', 'ssid', 'SSID', 'ssidName', 'wifiName']);
  const ssid = rawName === undefined ? '' : String(rawName).trim();
  if (!ssid) {
    return null;
  }

  const rawRssi = pick(raw, ['rssi', 'RSSI', 'signal', 'level', 'signalStrength']);
  let rssi: number | null = null;
  if (rawRssi !== undefined) {
    const v = typeof rawRssi === 'string' ? parseInt(rawRssi, 10) : Number(rawRssi);
    if (!isNaN(v) && v !== 0) {
      rssi = v > 0 ? v - 100 : v; // 兼容部分模组上报 0~100 的正向强度
    }
  }

  const rawSec = pick(raw, ['sec', 'auth', 'authMode', 'security', 'encrypt', 'encryption']);
  const sec = rawSec === undefined ? null : rawSec;

  return { ssid, rssi, sec };
}

/**
 * 解析设备推送的 Wi-Fi 列表，兼容以下所有形态：
 *   [{"name":"a"},{"name":"b"}]             ← 设备示例的原生格式
 *   {"list":[{"name":"a"}]}                 ← 以后设备包一层
 *   [{"ssid":"a","rssi":-45,"sec":3}]       ← 以后加字段
 *   []                                      ← 扫不到任何 AP 时设备发的是空数组
 */
export function parseWifiList(input: unknown): WifiListResult {
  let value: unknown = input;

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, list: [], empty: false, raw: input };
    }
  }

  if (isRecord(value)) {
    const inner = pick(value, ['list', 'data', 'aps', 'wifiList', 'networks']);
    if (Array.isArray(inner)) {
      value = inner;
    }
  }

  if (!Array.isArray(value)) {
    return { ok: false, list: [], empty: false, raw: input };
  }

  const seen: Record<string, number> = {};
  const list: WifiEntry[] = [];

  for (const rawItem of value) {
    const entry = normalizeWifiEntry(rawItem);
    if (!entry) {
      continue;
    }
    // 同一个 SSID 可能被多个 AP 广播，合并成一条，保留信号最强的那条
    const key = entry.ssid;
    const idx = seen[key];
    if (idx !== undefined) {
      const prev = list[idx];
      if (entry.rssi !== null && (prev.rssi === null || entry.rssi > prev.rssi)) {
        prev.rssi = entry.rssi;
      }
      continue;
    }
    seen[key] = list.length;
    list.push(entry);
  }

  // 有信号强度就按强度排（设备侧本来也排过，这里对组装后的结果再排一次）
  const hasRssi = list.some((x) => x.rssi !== null);
  if (hasRssi) {
    list.sort((a, b) => (b.rssi === null ? -999 : b.rssi) - (a.rssi === null ? -999 : a.rssi));
  }

  return { ok: true, list, empty: list.length === 0, raw: input };
}

/**
 * 解析配网结果 {"state":"success"} / {"state":"fail"}。
 * 宽容：state/status/result/success/code 各种写法都认，附带的原因字段也取出来。
 */
export function parseDeviceState(input: unknown): DeviceStateResult {
  let value: unknown = input;

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { state: 'unknown', reason: '', raw: input };
    }
  }

  if (!isRecord(value)) {
    return { state: 'unknown', reason: '', raw: input };
  }

  const reason = String(pick(value, ['reason', 'msg', 'message', 'error', 'errMsg']) || '');

  const rawState = pick(value, ['state', 'status', 'result', 'ret', 'code']);
  if (rawState !== undefined) {
    const s = String(rawState).trim().toLowerCase();
    if (s === 'success' || s === 'ok' || s === 'true' || s === '1' || s === '0') {
      return { state: 'success', reason, raw: input };
    }
    if (s === 'fail' || s === 'failed' || s === 'error' || s === 'false' || s === '-1') {
      return { state: 'fail', reason, raw: input };
    }
  }

  const boolFlag = pick(value, ['success', 'ok', 'connected']);
  if (boolFlag !== undefined) {
    if (boolFlag === true || boolFlag === 'true' || boolFlag === 1) {
      return { state: 'success', reason, raw: input };
    }
    if (boolFlag === false || boolFlag === 'false' || boolFlag === 0) {
      return { state: 'fail', reason, raw: input };
    }
  }

  return { state: 'unknown', reason, raw: input };
}

/** 收包分发的归类结果 */
export type PayloadKind = 'wifiList' | 'state' | 'unknown';

/**
 * 判断一个已解析的 JSON 值更像 Wi-Fi 列表还是配网结果。
 * 数组 → 列表；带 state/success 的对象 → 结果。
 */
export function classifyPayload(value: unknown): PayloadKind {
  if (Array.isArray(value)) {
    return 'wifiList';
  }
  if (isRecord(value)) {
    if (
      value.state !== undefined ||
      value.status !== undefined ||
      value.success !== undefined ||
      value.result !== undefined ||
      value.connected !== undefined
    ) {
      return 'state';
    }
    if (Array.isArray(value.list) || Array.isArray(value.data) || Array.isArray(value.aps)) {
      return 'wifiList';
    }
  }
  return 'unknown';
}

/* ========================================================================== *
 * 五、广播包解析与设备过滤
 * ========================================================================== */

/** 小端 16 位 */
function u16le(b: Uint8Array, offset: number): number {
  return (b[offset] | (b[offset + 1] << 8)) >>> 0;
}

/** 小端 32 位 */
function u32le(b: Uint8Array, offset: number): number {
  return (
    (b[offset] | (b[offset + 1] << 8) | (b[offset + 2] << 16) | (b[offset + 3] << 24)) >>> 0
  );
}

/** 十六进制左侧补零到指定位数（UUID 显示要固定宽度） */
function padHex(hex: string, width = 4): string {
  const s = String(hex).toUpperCase();
  if (s.length >= width) {
    return s;
  }
  let zeros = '';
  for (let i = s.length; i < width; i++) {
    zeros += '0';
  }
  return zeros + s;
}

/**
 * 解析广播数据（AD 结构：[长度][类型][数据...]，长度包含类型字节）。
 *
 * 设备侧实际放进去的内容：
 *   02 01 06                                      Flags
 *   0A 09 "CS-A1B2C3"                            Local Name
 *   03 16 00 FF                                   Service Data - 16bit UUID = 0xFF00
 *   03 FF A7 06                                   Manufacturer Specific = 芯海 0x06A7
 *
 * 注意 Service Data 的两个字节是 00 FF 而不是 FF 00：设备侧写的是
 *   adv_data[i++] = UUID & 0xFF;   → 0x00
 *   adv_data[i++] = UUID >> 8;     → 0xFF
 * 蓝牙 UUID 按小端传输，所以 00 FF 才代表 0xFF00。这个字节序很容易记反。
 */
export function parseAdvertisData(input: ArrayBuffer | Uint8Array | number[] | null | undefined): AdvertisData {
  const b = toUint8Array(input);
  const out: AdvertisData = {
    flags: null,
    localName: '',
    serviceUuids: [],
    serviceData: [],
    manufacturer: null
  };

  let p = 0;
  while (p + 1 < b.length) {
    const len = b[p];
    if (len === 0) {
      break;
    }
    // 长度字段越界说明广播数据是坏的，直接停下，不要越界读
    if (p + 1 + len > b.length) {
      break;
    }

    const type = b[p + 1];
    const data = b.slice(p + 2, p + 1 + len);

    switch (type) {
      case 0x01:
        out.flags = data.length ? data[0] : null;
        break;
      case 0x08:
      case 0x09:
        out.localName = decodeUtf8(data);
        break;
      case 0x02:
      case 0x03:
        for (let k = 0; k + 1 < data.length; k += 2) {
          out.serviceUuids.push(padHex(u16le(data, k).toString(16)));
        }
        break;
      case 0x04:
      case 0x05:
        for (let k = 0; k + 3 < data.length; k += 4) {
          out.serviceUuids.push(padHex(u32le(data, k).toString(16), 8));
        }
        break;
      case 0x06:
      case 0x07:
        for (let k = 0; k + 15 < data.length; k += 16) {
          out.serviceUuids.push(
            bytesToHex(data.slice(k, k + 16).slice().reverse(), '').replace(
              /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
              '$1-$2-$3-$4-$5'
            )
          );
        }
        break;
      case 0x16: {
        // Service Data - 16 位 UUID
        if (data.length >= 2) {
          const entry: ServiceDataEntry = {
            uuid: padHex(u16le(data, 0).toString(16)),
            data: data.slice(2)
          };
          out.serviceData.push(entry);
        }
        break;
      }
      case 0x20: {
        // Service Data - 32 位 UUID
        if (data.length >= 4) {
          const entry: ServiceDataEntry = {
            uuid: padHex(u32le(data, 0).toString(16), 8),
            data: data.slice(4)
          };
          out.serviceData.push(entry);
        }
        break;
      }
      case 0xff: {
        // 厂商自定义数据
        if (data.length >= 2) {
          const mfr: ManufacturerData = { id: u16le(data, 0), data: data.slice(2) };
          out.manufacturer = mfr;
        }
        break;
      }
      default:
        break;
    }

    p += 1 + len;
  }

  return out;
}

/**
 * 判断扫到的设备是不是我们要配网的设备。
 *
 * 为什么要做多重匹配：不同手机系统给的字段不一样。
 *   - iOS 一般能给到完整的 advertisData 和 localName；
 *   - 部分安卓机型 advertisData 为空或只有一部分；
 *   - advertisServiceUUIDs 只有在广播里用 0x03/0x07 声明服务时才有，
 *     而设备示例用的是 Service Data(0x16)，所以这个字段很可能是空的。
 * 三重条件任一命中即可，最大限度避免“设备明明在广播却扫不出来”。
 */
export function deviceMatchesFilter(device: RawDevice, ble: BleConfig): FilterMatchResult {
  const namePrefixes = ble.deviceNamePrefixes || [];
  const filterMode = ble.filterMode || 'name-or-adv';

  const name = String(device.name || device.localName || '');
  const advertisServiceUUIDs = device.advertisServiceUUIDs || [];

  const parsed = parseAdvertisData(device.advertisData);
  const displayName = name || parsed.localName || '';

  // 条件一：广播名前缀
  let nameMatch = false;
  if (displayName) {
    const upper = displayName.toUpperCase();
    for (const prefix of namePrefixes) {
      const p = String(prefix).toUpperCase();
      if (p && upper.indexOf(p) === 0) {
        nameMatch = true;
        break;
      }
    }
  }

  // 条件二：广播内容里的 Service Data / 厂商 ID / 服务 UUID 列表
  let advMatch = false;
  const wantedServiceData = expandUuid(ble.serviceDataUuid16 || ble.serviceUuid);
  for (const sd of parsed.serviceData) {
    if (uuidEquals(sd.uuid, wantedServiceData)) {
      advMatch = true;
      break;
    }
  }
  if (!advMatch && parsed.manufacturer && parsed.manufacturer.id === (ble.manufacturerId >>> 0)) {
    advMatch = true;
  }
  if (!advMatch) {
    for (const u of parsed.serviceUuids) {
      if (uuidEquals(u, ble.serviceUuid)) {
        advMatch = true;
        break;
      }
    }
  }
  if (!advMatch) {
    for (const u of advertisServiceUUIDs) {
      if (uuidEquals(u, ble.serviceUuid)) {
        advMatch = true;
        break;
      }
    }
  }

  let matched: boolean;
  switch (filterMode) {
    case 'name':
      matched = nameMatch;
      break;
    case 'adv':
      matched = advMatch;
      break;
    case 'name-and-adv':
      matched = nameMatch && advMatch;
      break;
    case 'name-or-adv':
    default:
      matched = nameMatch || advMatch;
      break;
  }

  return { matched, nameMatch, advMatch, displayName, parsed };
}

/* ========================================================================== *
 * 六、展示辅助与校验
 * ========================================================================== */

/**
 * RSSI → 信号格数（0~4）。
 * 阈值是常见经验值：-55 以内算满格，-85 以下基本连不上。
 */
export function rssiToBars(rssi: number | null | undefined): number {
  if (rssi === null || rssi === undefined || isNaN(rssi)) {
    return 0;
  }
  const v = Number(rssi);
  if (v >= -55) return 4;
  if (v >= -65) return 3;
  if (v >= -75) return 2;
  if (v >= -85) return 1;
  return 0;
}

/** 校验结果 */
export interface ValidationResult {
  ok: boolean;
  message: string;
  warning?: string;
}

/** 校验 SSID 是否合法（1~32 字节，UTF-8 计） */
export function validateSsid(ssid: string | null | undefined): ValidationResult {
  const s = String(ssid === null || ssid === undefined ? '' : ssid);
  if (!s) {
    return { ok: false, message: '请输入 Wi-Fi 名称' };
  }
  const bytes = encodeUtf8(s).length;
  if (bytes > 32) {
    return { ok: false, message: 'Wi-Fi 名称过长（最多 32 字节，中文约 10 个字）' };
  }
  return { ok: true, message: '' };
}

/** 校验密码是否合法（WPA2 要求 8~63 个字符；空密码=开放网络） */
export function validatePassword(pwd: string | null | undefined): ValidationResult {
  const s = String(pwd === null || pwd === undefined ? '' : pwd);
  if (!s) {
    return { ok: true, message: '', warning: '密码为空，将按开放网络连接' };
  }
  if (s.length < 8) {
    return { ok: false, message: '密码少于 8 位，路由器通常不接受' };
  }
  if (s.length > 63) {
    return { ok: false, message: '密码超过 63 位，路由器通常不接受' };
  }
  return { ok: true, message: '' };
}

/**
 * 校验一个要下发给设备的字符串是否放得进设备侧缓冲区。
 *
 * 设备侧是固定长度数组（char city_zh[24] / district_zh[24]），而全国确实存在
 * 超长名字，例如最长区名「内蒙古阿拉善高新技术产业开发区」45 字节。
 * 直接下发会让设备侧 snprintf 截断。宁可在手机上先提示用户，也不要让设备跑飞。
 */
export function validateDeviceText(
  value: string | null | undefined,
  label: string,
  maxBytes: number
): ValidationResult & { bytes: number } {
  const s = String(value === null || value === undefined ? '' : value);
  const limit = maxBytes > 0 ? maxBytes : 23;
  const bytes = encodeUtf8(s).length;

  if (!s) {
    return { ok: false, bytes: 0, message: '请选择' + label, warning: '' };
  }
  if (bytes > limit) {
    return {
      ok: false,
      bytes,
      message: `${label}名称过长（${bytes} 字节，设备最多存 ${limit} 字节），请换一个`,
      warning: ''
    };
  }
  if (bytes > limit - 3) {
    return {
      ok: true,
      bytes,
      message: '',
      warning: `${label}名称较长（${bytes} 字节），接近设备上限`
    };
  }
  return { ok: true, bytes, message: '', warning: '' };
}

/**
 * 按 UTF-8 字节数截断字符串，保证不把汉字切成半个。
 *
 * 为什么需要：设备侧 char district_zh[24] 只有 23 字节可用，而全国最长区名
 * 「内蒙古阿拉善高新技术产业开发区」是 45 字节。如果直接拒绝下发，住在那里的
 * 用户就永远配不了网 —— 这不可接受。所以给他一个「截断后下发」的选择，
 * 名字显示不全总比整台设备用不了强。
 */
export function truncateUtf8(
  input: string | null | undefined,
  maxBytes: number
): { text: string; truncated: boolean; bytes: number } {
  const s = String(input === null || input === undefined ? '' : input);
  const limit = maxBytes > 0 ? maxBytes : 0;
  const total = encodeUtf8(s).length;

  if (total <= limit) {
    return { text: s, truncated: false, bytes: total };
  }

  let out = '';
  let used = 0;
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];
    const code = s.charCodeAt(i);
    // 代理对要整体处理，不能只取半个
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        ch = s.slice(i, i + 2);
        i++;
      }
    }
    const len = encodeUtf8(ch).length;
    if (used + len > limit) {
      break;
    }
    out += ch;
    used += len;
  }

  return { text: out, truncated: true, bytes: used };
}
