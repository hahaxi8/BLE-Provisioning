/**
 * 配网流程状态（跨页面共享）
 * ---------------------------------------------------------------------------
 * 配网流程要走 6 个页面（设备 → Wi-Fi → 密码 → 位置 → 结果），用 URL 参数传
 * 中文 SSID 和密码既容易出错也会留在页面栈里，所以放这里。
 *
 * 为什么不用 Pinia：这个规模只有 4 个字段、3 个动作，模块级 reactive 就够，
 * 少一个依赖、少一层心智负担。将来状态变复杂了再换也不难。
 *
 * 本文件刻意不 import ble 客户端 —— 它只存数据，动作由页面调用。
 */

import { reactive } from 'vue';
import type { WifiConfig } from '../ble/types.ts';

/** 选中的设备 */
export interface SelectedDevice {
  deviceId: string;
  name: string;
  rssi: number | null;
  mtu: number;
  chunkSize: number;
}

/** 选中的 Wi-Fi */
export interface WifiChoice {
  ssid: string;
  /** 是不是手动输入的（设备扫不到时的兜底） */
  manual: boolean;
  /** 是不是从历史记录回填的 */
  fromHistory?: boolean;
}

/** 「再配一次」时从历史记录回填的字段 */
export interface Prefill {
  ssid: string;
  city: string;
  district: string;
}

export interface FlowState {
  device: SelectedDevice | null;
  wifi: WifiChoice | null;
  provision: WifiConfig | null;
  prefill: Prefill | null;
}

export const flow = reactive<FlowState>({
  device: null,
  wifi: null,
  provision: null,
  prefill: null
});

/**
 * 重置流程状态。
 * @param keepDevice 重新选 Wi-Fi 时保留已连接的设备，不必重连
 */
export function resetFlow(keepDevice = false): void {
  if (!keepDevice) {
    flow.device = null;
  }
  flow.wifi = null;
  flow.provision = null;
  flow.prefill = null;
}

/** 把当前选择合并进 provision，缺的字段保持原值 */
export function updateProvision(patch: Partial<WifiConfig>): void {
  const current: WifiConfig = flow.provision || {
    ssid: flow.wifi ? flow.wifi.ssid : '',
    pwd: ''
  };
  flow.provision = { ...current, ...patch };
}
