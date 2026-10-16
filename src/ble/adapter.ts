/**
 * 适配器注册表
 * ---------------------------------------------------------------------------
 * 整个小程序只认 BleAdapter 接口，不认 uni / wx / plus。
 * 所以：
 *   - 业务代码（client.ts / 页面）完全平台无关；
 *   - 出 App 端时只要再写一个实现同一接口的适配器，业务代码一行不用改；
 *   - 单元测试可以塞一个假适配器进来，把整条配网流程跑一遍（见 test/client.test.js）。
 */

import type { BleAdapter } from './types.ts';
import { createMpWeixinAdapter } from './adapters/mp-weixin.ts';

let instance: BleAdapter | null = null;

/** 当前平台的适配器（懒创建：H5 等不支持蓝牙的平台不会一启动就炸） */
export function getAdapter(): BleAdapter {
  if (!instance) {
    instance = createAdapter();
  }
  return instance;
}

/** 替换适配器。测试注入假实现、以后 App 端切换都走这里 */
export function setAdapter(adapter: BleAdapter): void {
  instance = adapter;
}

/** 清掉缓存的适配器（测试隔离用） */
export function resetAdapter(): void {
  instance = null;
}

function createAdapter(): BleAdapter {
  // #ifdef MP-WEIXIN
  return createMpWeixinAdapter();
  // #endif

  // #ifdef APP-PLUS
  // App 端实现放这里。注意：uni-app 官方**没有** App 端的 BLE 中心设备 API，
  // 需要用原生插件或 plus.android / plus.ios 自己写，
  // 详见 docs/device-integration.md 的「App 端后续方案」。
  // return createAppAdapter();
  // #endif
}
