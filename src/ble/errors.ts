/**
 * 蓝牙错误码 → 用户能看懂的中文（纯函数，零依赖）
 * ---------------------------------------------------------------------------
 * 平台接口失败时只会给一个 errCode 和一句英文 errMsg，直接把 errMsg 弹给
 * 用户等于没提示。这里把常见的码翻译成「发生了什么 + 该怎么办」。
 *
 * 错误码来源：微信官方文档《蓝牙错误码》
 * https://developers.weixin.qq.com/miniprogram/dev/framework/device/bluetooth.html
 *
 * 本文件不 import 任何运行时模块，Node 能直接跑单测。
 */

import type { ErrorInfo } from './types.ts';

interface ErrorEntry {
  title: string;
  message: string;
  advice: string[];
}

/** 微信蓝牙错误码表 */
export const CODE_TABLE: Record<number, ErrorEntry> = {
  0: { title: '成功', message: '', advice: [] },
  10000: {
    title: '蓝牙没打开',
    message: '手机蓝牙未开启，或者小程序还没初始化蓝牙。',
    advice: ['请在系统设置里打开蓝牙', '如果已经打开了，返回上一页重试一次']
  },
  10001: {
    title: '蓝牙不可用',
    message: '当前手机蓝牙适配器不可用，可能是飞行模式或系统蓝牙异常。',
    advice: ['检查是否开了飞行模式', '关闭再打开一次系统蓝牙', '重启微信后重试']
  },
  10002: {
    title: '没找到设备',
    message: '没有找到指定的蓝牙设备，设备可能已经断电或走出范围了。',
    advice: ['确认设备已通电且指示灯在闪', '让手机靠近设备（1 米内）', '重新扫描一次']
  },
  10003: {
    title: '连接失败',
    message: '和设备建立连接失败。',
    advice: [
      '让手机靠近设备再试',
      '设备可能已被别人连上了，等一会儿或给设备重新上电',
      '关掉手机蓝牙再打开，重试'
    ]
  },
  10004: {
    title: '没找到蓝牙服务',
    message: '连上了设备，但设备上没有找到配网服务（0xFF00）。',
    advice: ['确认烧录的固件带 BLE 配网功能', '设备可能不是配网模式，给设备重新上电']
  },
  10005: {
    title: '没找到蓝牙特征值',
    message: '设备上的配网服务不完整，缺少写特征（0xFF01）或通知特征（0xFF02）。',
    advice: ['这是固件问题，请把日志发给开发确认服务定义']
  },
  10006: {
    title: '连接已断开',
    message: '和设备之间的连接断开了。',
    advice: ['让手机离设备近一点', '重新连接一次']
  },
  10007: {
    title: '特征值不支持该操作',
    message: '对该特征值的读/写/订阅方式不对。',
    advice: ['这是固件问题，请核对写特征是否支持带响应写（WRITE_REQ）']
  },
  10008: {
    title: '系统异常',
    message: '手机系统上报了一个蓝牙异常。',
    advice: ['关掉手机蓝牙再打开', '重启微信后重试', '换个手机试试，排除机型兼容问题']
  },
  10009: {
    title: '系统版本过低',
    message: '安卓系统版本低于 4.3，不支持 BLE。',
    advice: ['换一台安卓 4.3 以上或 iOS 的手机']
  },
  10012: {
    title: '连接超时',
    message: '连接设备超时了。',
    advice: ['让手机靠近设备', '设备可能正忙，等几秒重试']
  },
  10013: {
    title: '设备标识无效',
    message: '设备 deviceId 为空或格式不对。',
    advice: ['重新扫描并点击设备连接，不要使用历史记录里的设备']
  }
};

/** 自定义（非平台返回）的错误场景 */
export const CUSTOM_TABLE: Record<string, ErrorEntry> = {
  ADAPTER_CLOSED: {
    title: '蓝牙已关闭',
    message: '小程序还没能打开手机蓝牙。',
    advice: ['请确认手机蓝牙已开启', '部分安卓机型需要同时打开定位开关']
  },
  LOCATION_DENIED: {
    title: '定位权限被拒绝',
    message: '安卓系统要求：想扫描蓝牙设备，必须允许微信使用定位权限。',
    advice: [
      '点右上角「···」→ 设置 → 允许使用位置信息',
      '或在手机系统设置里给微信开定位权限'
    ]
  },
  TIMEOUT_SCAN: {
    title: '没扫描到设备',
    message: '扫描时间内没有发现可配网的设备。',
    advice: [
      '确认设备已通电，且还没配过网（配过网的设备不会再广播）',
      '让手机靠近设备，最好 1 米以内',
      '设备可能已被别的手机连着，先断开那个连接',
      '给设备断电重新上电，再扫描一次'
    ]
  },
  TIMEOUT_WIFI_LIST: {
    title: '设备没有回 Wi-Fi 列表',
    message: '连上设备了，但设备没有在预期时间内把 Wi-Fi 列表发过来。',
    advice: [
      '设备可能在忙或扫描失败，点「重新扫描」再试一次',
      '断开重连一次',
      '确认固件里 Wi-Fi 扫描功能正常'
    ]
  },
  TIMEOUT_PROVISION: {
    title: '配网超时',
    message: '设备迟迟没有回报配网结果。',
    advice: [
      '设备可能还在连路由器，再等一会儿',
      '确认 Wi-Fi 密码没输错',
      '路由器如果开了 5G 优先或 MAC 过滤，请先关掉试试',
      '重新配网一次'
    ]
  },
  SERVICE_NOT_FOUND: {
    title: '设备不支持配网',
    message: '连上了，但设备上没有配网服务（0xFF00）。',
    advice: ['确认烧录的固件带 BLE 配网功能', '设备可能不是配网模式']
  },
  CHARACTERISTIC_NOT_FOUND: {
    title: '设备配网服务不完整',
    message: '找到了配网服务，但缺少写特征（0xFF01）或通知特征（0xFF02）。',
    advice: ['这是固件问题，请核对 GATT 服务定义']
  },
  BAD_JSON: {
    title: '设备返回的数据看不懂',
    message: '设备发过来的数据不是合法的 JSON，无法解析。',
    advice: [
      '确认设备固件里拼 JSON 时对 SSID 做了转义（热点名里带引号会导致这个问题）',
      '展开「原始报文」看看设备到底发了什么'
    ]
  }
};

/** 把任意错误输入归一化 */
function pickCode(err: Record<string, unknown> | number | null | undefined): number | undefined {
  if (err === null || err === undefined) {
    return undefined;
  }
  if (typeof err === 'number') {
    return err;
  }
  const v = err.errCode !== undefined ? err.errCode : err.code;
  return typeof v === 'number' ? v : undefined;
}

/** 取出原始错误文本（errMsg 优先，兼容字符串和 Error） */
function rawMessage(err: unknown): string {
  if (typeof err === 'string') {
    return err;
  }
  if (err && typeof err === 'object') {
    const e = err as { errMsg?: unknown; message?: unknown };
    if (typeof e.errMsg === 'string') {
      return e.errMsg;
    }
    if (typeof e.message === 'string') {
      return e.message;
    }
  }
  return '';
}

/**
 * 微信有一批「失败」回调，其实表示**已经是目标状态**，不是错误。最典型的是：
 *
 *   openBluetoothAdapter:fail already opened
 *
 * 蓝牙明明开着、适配器也初始化好了，但调用照样走 fail 回调。如果当成失败，
 * 流程会卡死在第一步，用户看到的是「蓝牙不可用」——而且重试永远失败，
 * 因为适配器本来就是打开的。（真机上踩过。）
 *
 * ⚠️ 只在**明确知道"失败 = 已经是我们想要的状态"**的调用上用它，
 * 不要当成通用的错误过滤器，否则会把真正的问题吞掉。
 */
const BENIGN_PATTERNS: RegExp[] = [
  /already\s*open/i, // 适配器 / 连接已打开
  /already\s*discover/i, // 已经在扫描
  /already\s*(notif|subscrib)/i, // 通知已经打开
  /already\s*clos/i, // 已经断开
  /not\s*(start|discover)/i, // 停止扫描时：本来就没在扫
  /not\s*connect/i // 断开时：本来就没连
];

/**
 * 判断一个失败是否是「已经是目标状态」这种假失败。
 * 纯函数，不依赖任何平台 API，可以直接单测。
 */
export function isBenignBleError(err: unknown): boolean {
  const msg = rawMessage(err);
  return msg !== '' && BENIGN_PATTERNS.some((re) => re.test(msg));
}

/**
 * 把任意错误输入归一化成 ErrorInfo。
 *
 * 接受三种输入：
 *   - 平台 API 的失败对象：{ errCode: 10003, errMsg: '...' }
 *   - 纯数字错误码：10003
 *   - 自定义场景的字符串键：'TIMEOUT_SCAN'
 */
export function describe(err: unknown): ErrorInfo {
  if (err === null || err === undefined) {
    return { code: -1, title: '未知错误', message: '', advice: [], raw: err };
  }

  // 自定义场景
  if (typeof err === 'string') {
    const custom = CUSTOM_TABLE[err];
    if (custom) {
      return {
        code: err,
        title: custom.title,
        message: custom.message,
        advice: custom.advice.slice(),
        raw: err
      };
    }
    return { code: err, title: '出错了', message: err, advice: [], raw: err };
  }

  if (typeof err === 'number') {
    const entry = CODE_TABLE[err];
    if (entry) {
      return { code: err, title: entry.title, message: entry.message, advice: entry.advice.slice(), raw: err };
    }
    return { code: err, title: '出错了', message: '', advice: [], raw: err };
  }

  const record = err as Record<string, unknown>;
  const code = pickCode(record);

  if (code !== undefined) {
    const entry = CODE_TABLE[code];
    if (entry) {
      return {
        code,
        title: entry.title,
        message: entry.message,
        advice: entry.advice.slice(),
        raw: err
      };
    }
  }

  // 兜底：把原始 errMsg 也带上，方便现场排查
  const rawMsg = String(record.errMsg || record.message || '');
  return {
    code: code === undefined ? -1 : code,
    title: '出错了',
    message: rawMsg || '蓝牙操作失败，请重试。',
    advice: ['重试一次', '关掉手机蓝牙再打开', '重启微信后重试'],
    raw: err
  };
}

/** 把 describe() 的结果拼成一段可以直接放进界面的多行文本 */
export function toPlainText(info: ErrorInfo): string {
  const lines: string[] = [];
  if (info.title) {
    lines.push(info.title);
  }
  if (info.message) {
    lines.push(info.message);
  }
  if (info.advice && info.advice.length) {
    lines.push('');
    lines.push('可以这样处理：');
    info.advice.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  }
  return lines.join('\n');
}
