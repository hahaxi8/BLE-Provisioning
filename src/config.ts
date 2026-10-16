/**
 * 全局集中配置
 * ---------------------------------------------------------------------------
 * 换芯片型号 / 换广播名 / 调超时 / 换主题色，都只改本文件，不要去翻业务代码。
 *
 * 协议约定和字节级对照见 `docs/device-integration.md` —— 设备侧固件是按同一套
 * 约定实现的，改这里的值之前先看那份文档。
 *
 * 注意：本文件刻意**不 import 任何运行时模块** —— 类型定义放在 ble/types.ts，
 * 这里只做 `import type`（编译后完全消失）。所以 Node 能直接跑它和依赖它的测试。
 */

import type { BleConfig, FilterMode } from './ble/types.ts';

// 协议层需要的配置类型定义在 ble/types.ts，这里转出去方便按需引用
export type { BleConfig, FilterMode };

/** 品牌与显示文案 */
export interface AppConfig {
  /** 首页大标题 */
  title: string;
  /** 副标题 */
  subtitle: string;
  /** 主题色（同时用于按钮、进度、成功态） */
  brandColor: string;
  /** 主题色的深色版，用于按钮按下态 */
  brandColorActive: string;
  /** 危险色（失败态） */
  dangerColor: string;
  /** 是否在配网记录里保存 Wi-Fi 密码（默认关闭，见 README 的“安全说明”） */
  rememberPassword: boolean;
  /** 配网记录最多保留条数 */
  maxHistory: number;
}

/** 各类超时（毫秒）。现场 Wi-Fi 环境差时，provision 可以再放宽 */
export interface TimeoutConfig {
  openAdapter: number;
  scan: number;
  connect: number;
  discover: number;
  wifiList: number;
  provision: number;
  /** 收包拼接的空闲超时：超过这么久没有新分片就丢弃半截数据 */
  rxIdle: number;
}

export interface StorageKeys {
  history: string;
}

export interface AppSettings {
  app: AppConfig;
  ble: BleConfig;
  timeouts: TimeoutConfig;
  storageKeys: StorageKeys;
}

export const config: AppSettings = {
  app: {
    title: '设备配网',
    subtitle: '把家里的 Wi-Fi 告诉设备',
    brandColor: '#07C160',
    brandColorActive: '#06AD56',
    dangerColor: '#FA5151',
    rememberPassword: false,
    maxHistory: 5
  },

  ble: {
    serviceUuid: 'FF00',
    writeCharUuid: 'FF01',
    notifyCharUuid: 'FF02',

    deviceNamePrefixes: ['CS-'],

    serviceDataUuid16: 'FF00',
    manufacturerId: 0x06a7,

    filterMode: 'name-or-adv',

    preferredMtu: 512,
    fallbackChunkSize: 20,
    writeChunkDelayMs: 30,
    allowDuplicates: true,

    deviceTextMaxBytes: 63
  },

  timeouts: {
    openAdapter: 10000,
    scan: 15000,
    connect: 15000,
    discover: 10000,
    wifiList: 20000,
    provision: 60000,
    rxIdle: 2500
  },

  storageKeys: {
    history: 'ble_config_history_v1'
  }
};

export default config;
