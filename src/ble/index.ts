/**
 * BLE 客户端单例
 * ---------------------------------------------------------------------------
 * 整个小程序共用一个连接（多页面各连一次会把设备连挂），所以这里只实例化一次。
 *
 * 平台适配器在 `adapter.ts` 里按条件编译选择，业务代码和页面只 import 本文件。
 */

import { BleClient } from './client.ts';
import { getAdapter } from './adapter.ts';
import { config } from '../config.ts';

export const ble = new BleClient(getAdapter(), config);

export { BleClient, toScannedDevice, shortDeviceId, sleep, withTimeout } from './client.ts';
export type { BleConnection } from './client.ts';
export * from './protocol.ts';
export { describe as describeError, toPlainText as errorToPlainText } from './errors.ts';
export type * from './types.ts';
