/**
 * 本地存储：配网历史记录
 * ---------------------------------------------------------------------------
 * 存什么：
 *   - 配过网的设备名、Wi-Fi 名、城市/区，以及是否成功 —— 用于首页显示「上次配网」
 *     和「再配一次」。
 *
 * 不存什么（默认）：
 *   - Wi-Fi 密码。小程序本地存储是明文的，把用户家里的 Wi-Fi 密码明文落盘
 *     不合适。确实需要「下次不用重输」时，把 config 里的 rememberPassword
 *     改成 true，并自行评估风险 —— 小程序被反编译时 storage 是可以被读出来的。
 */

import { config } from '../config.ts';

export interface HistoryRecord {
  deviceId: string;
  deviceName: string;
  ssid: string;
  city?: string;
  district?: string;
  /** 仅当 config.app.rememberPassword 为 true 时才存在 */
  pwd?: string;
  success: boolean;
  time: number;
}

/** 读写存储。uni 在非 uni 环境（如 Node 单测）里不存在，所以每条都判空 */
function readRaw(): unknown {
  try {
    if (typeof uni === 'undefined') {
      return null;
    }
    return uni.getStorageSync(config.storageKeys.history);
  } catch {
    // 存储损坏时不要影响主流程，直接当没有记录
    return null;
  }
}

function writeRaw(list: HistoryRecord[]): void {
  try {
    if (typeof uni === 'undefined') {
      return;
    }
    uni.setStorageSync(config.storageKeys.history, list);
  } catch {
    // 存储写失败不阻塞配网
  }
}

/** 读取全部记录（按时间倒序，最新的在前） */
export function getHistory(): HistoryRecord[] {
  const raw = readRaw();
  if (Array.isArray(raw)) {
    return raw as HistoryRecord[];
  }
  // 兼容存成字符串的情况
  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as HistoryRecord[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** 最近一次配网记录，没有则返回 null */
export function getLastRecord(): HistoryRecord | null {
  const list = getHistory();
  return list.length ? list[0] : null;
}

/**
 * 写入一条配网记录。
 *
 * 去重规则：同一个设备 + 同一个 SSID 视为同一条，只更新时间并挪到最前面，
 * 否则用户反复重试会把历史撑满。
 */
export function addRecord(record: Partial<HistoryRecord> & { ssid: string }): void {
  if (!record || !record.ssid) {
    return;
  }

  const item: HistoryRecord = {
    deviceId: record.deviceId || '',
    deviceName: record.deviceName || '',
    ssid: record.ssid || '',
    city: record.city || '',
    district: record.district || '',
    success: !!record.success,
    time: Date.now()
  };

  if (config.app.rememberPassword && record.pwd) {
    item.pwd = record.pwd;
  }

  const list = getHistory().filter(
    (r) => !(r.deviceId === item.deviceId && r.ssid === item.ssid)
  );
  list.unshift(item);

  const max = config.app.maxHistory || 5;
  writeRaw(list.slice(0, max));
}

/** 清空历史 */
export function clearHistory(): void {
  try {
    if (typeof uni !== 'undefined') {
      uni.removeStorageSync(config.storageKeys.history);
    }
  } catch {
    // 忽略
  }
}
