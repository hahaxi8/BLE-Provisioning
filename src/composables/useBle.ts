/**
 * BLE 相关的组合式函数
 * ---------------------------------------------------------------------------
 * 页面的职责边界：**只订阅、不管理生命周期**。
 * 订阅和退订都通过这里，组件卸载时自动清理 —— 忘记退订是这类小程序最常见的
 * 内存泄漏和「消息重复触发」来源。
 *
 * 重要：`useBleEvents` 必须在 `<script setup>` 顶层**同步**调用。
 * 如果把订阅写在 `onLoad` 回调里，`onUnmounted` 就来不及注册，清理永远不会执行。
 */

import { ref, onUnmounted } from 'vue';
import type { Ref } from 'vue';
import { ble } from '../ble/index.ts';
import type { BleConnection, BleEventMap, BleListener } from '../ble/index.ts';

/**
 * 内部用的宽松监听函数类型。
 * 不同类型的事件要放进同一张表，接口边界上不得不做一次转换，转换只发生在本文件里。
 */
type AnyHandler = (payload: never) => void;

/** 事件名 → 处理函数。事件名写错、处理函数形参类型不符都会在编译期报错 */
export type BleEventHandlers = {
  [K in keyof BleEventMap]?: BleListener<K>;
};

/**
 * 订阅一组 BLE 事件，组件卸载时自动退订。
 *
 * 用法：
 *   useBleEvents({
 *     wifiList: handleWifiList,
 *     disconnected: handleDisconnected
 *   });
 */
export function useBleEvents(handlers: BleEventHandlers): void {
  const keys = Object.keys(handlers) as Array<keyof BleEventMap>;
  const active: Array<{ key: keyof BleEventMap; fn: AnyHandler }> = [];

  for (const key of keys) {
    const fn = handlers[key] as unknown as AnyHandler | undefined;
    if (!fn) {
      continue;
    }
    (ble.on as unknown as (k: keyof BleEventMap, f: AnyHandler) => void)(key, fn);
    active.push({ key, fn });
  }

  onUnmounted(() => {
    for (const item of active) {
      (ble.off as unknown as (k: keyof BleEventMap, f?: AnyHandler) => void)(item.key, item.fn);
    }
  });
}

/** 连接状态快照（响应式）。连接、断开、关闭时自动同步 */
export function useBleConnection(): { connection: Ref<BleConnection> } {
  const connection = ref<BleConnection>(ble.connection);

  useBleEvents({
    connected: () => {
      connection.value = ble.connection;
    },
    disconnected: () => {
      connection.value = ble.connection;
    },
    closed: () => {
      connection.value = ble.connection;
    }
  });

  return { connection };
}

/** 平台能力（是否支持协商 MTU、读 RSSI 等），界面据此隐藏/降级功能 */
export function useBleCapabilities() {
  return ble.capabilities;
}
