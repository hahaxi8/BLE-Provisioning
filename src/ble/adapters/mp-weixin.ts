/**
 * 微信小程序（mp-weixin）BLE 适配器
 * ---------------------------------------------------------------------------
 * 本文件是整个项目**唯一**直接调用平台蓝牙 API 的地方。
 * 其它所有代码都通过 BleAdapter 接口访问蓝牙，所以换平台时只需要新写一个
 * 同接口的适配器，业务代码和页面全部不用动。
 *
 * 几个真实平台差异，都在这里吸收掉：
 *
 *   1. uni 覆盖不全：uni.setBLEMTU / getBLEMTU / getBLEDeviceRSSI /
 *      offBluetoothDeviceFound 这些在 @dcloudio/types 里不一定有声明，
 *      运行时也不一定有。所以这里统一走 resolveApi()：
 *      先找 uni.xxx，找不到就退回 wx.xxx，都没有才报错。
 *   2. 服务发现过早：部分安卓机型刚连上就调 getBLEDeviceServices 会返回空列表，
 *      这里做了重试。
 *   3. MTU 差异：安卓能协商到 512，iOS 不给设、通常只有 185，拿不到就返回 0，
 *      由上层按 23 兜底（每包 20 字节）。
 *   4. 残留连接：安卓上如果上一次连接没清干净，直接连会失败，所以连接前先尽力关一次。
 */

import type {
  AdapterCapabilities,
  AdapterOpenResult,
  BleAdapter,
  DiscoveredGatt,
  RawDevice
} from '../types.ts';
import { config } from '../../config.ts';
import { isBenignBleError } from '../errors.ts';
import { uuidEquals } from '../protocol.ts';

/**
 * 微信原生全局对象。
 * 在 mp-weixin 构建产物里一定存在；在其它平台不存在，所以每次访问都要判空。
 * 声明成 unknown-ish 的类型是因为我们要按名字动态取方法。
 */
declare const wx: Record<string, unknown> | undefined;

type ApiFn = (options: Record<string, unknown>) => void;
type ApiBag = Record<string, unknown>;

/** 按名字解析一个平台 API：优先 uni，其次 wx */
function resolveApi(name: string): ApiFn | null {
  const bags: ApiBag[] = [];

  try {
    if (typeof uni !== 'undefined') {
      bags.push(uni as unknown as ApiBag);
    }
  } catch {
    // 非 uni 环境，忽略
  }
  try {
    if (typeof wx !== 'undefined' && wx) {
      bags.push(wx);
    }
  } catch {
    // 非微信环境，忽略
  }

  for (const bag of bags) {
    const fn = bag[name];
    if (typeof fn === 'function') {
      return (fn as ApiFn).bind(bag);
    }
  }
  return null;
}

/** 某个 API 是否存在（不触发调用） */
function canCallApi(name: string): boolean {
  const bags: ApiBag[] = [];
  try {
    if (typeof uni !== 'undefined') {
      bags.push(uni as unknown as ApiBag);
    }
  } catch {
    /* 忽略 */
  }
  try {
    if (typeof wx !== 'undefined' && wx) {
      bags.push(wx);
    }
  } catch {
    /* 忽略 */
  }
  return bags.some((bag) => typeof bag[name] === 'function');
}

/** 把回调式 API 包成 Promise，失败时 reject 原始 { errCode, errMsg } */
function call(name: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const fn = resolveApi(name);
    if (!fn) {
      reject({ errCode: -1, errMsg: `当前平台不支持蓝牙接口 ${name}` });
      return;
    }
    fn({
      ...(options || {}),
      success: (res: unknown) => resolve((res as Record<string, unknown>) || {}),
      fail: (err: unknown) => reject(err || { errCode: -1, errMsg: 'unknown' })
    });
  });
}

/**
 * 有些微信 API 在「已经是目标状态」时也走 fail 回调，例如：
 *
 *   openBluetoothAdapter:fail already opened
 *
 * 这不是错误，但当成错误会让流程卡死在第一步，用户看到的是「蓝牙不可用」，
 * 而且重试永远失败 —— 因为适配器本来就是打开的。（真机上踩过。）
 *
 * 所以这类调用走 callTolerant：假失败按成功处理，真失败照常抛出。
 * 判断逻辑在 errors.ts 的 isBenignBleError（纯函数，有单测）。
 */
async function callTolerant(
  name: string,
  options?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  try {
    return await call(name, options);
  } catch (e) {
    if (isBenignBleError(e)) {
      return { errMsg: 'ok (already in target state)' };
    }
    throw e;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}/** 失败就重试几次，用于「刚连上时服务列表为空」这类时序问题 */
async function retry<T>(fn: () => Promise<T>, times: number, delayMs: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < times - 1) {
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}

/** 取手机平台标识（小写）。新基础库用 getDeviceInfo，老基础库只有 getSystemInfoSync */
function detectPlatform(): string {
  try {
    if (canCallApi('getDeviceInfo')) {
      const info = (uni as unknown as { getDeviceInfo: () => { platform?: string } }).getDeviceInfo();
      if (info && info.platform) {
        return String(info.platform).toLowerCase();
      }
    }
  } catch {
    // 继续用老接口
  }
  try {
    const info = (uni as unknown as { getSystemInfoSync: () => { platform?: string } }).getSystemInfoSync();
    return String(info.platform || '').toLowerCase();
  } catch {
    return 'unknown';
  }
}

/** 安卓专有：系统定位开关是否打开（蓝牙扫描依赖它） */
function isLocationEnabled(platform: string): boolean {
  if (platform !== 'android') {
    return true;
  }
  try {
    const info = (uni as unknown as { getSystemInfoSync: () => { locationEnabled?: boolean } }).getSystemInfoSync();
    if (typeof info.locationEnabled === 'boolean') {
      return info.locationEnabled;
    }
  } catch {
    // 查不到就不拦用户
  }
  return true;
}

class MpWeixinBleAdapter implements BleAdapter {
  private platform = 'unknown';

  readonly capabilities: AdapterCapabilities = {
    platform: 'mp-weixin',
    supportsSetMtu: canCallApi('setBLEMTU'),
    supportsRssi: canCallApi('getBLEDeviceRSSI'),
    supportsRescan: true
  };

  async openAdapter(): Promise<AdapterOpenResult> {
    this.platform = detectPlatform();

    // 蓝牙已经打开时微信会走 fail 回调（already opened），必须容忍，
    // 否则第二次进入小程序就永远卡在这一步
    await callTolerant('openBluetoothAdapter');

    const location = await this.requestLocationPermission();
    return { opened: true, locationOk: location.ok, needSetting: location.needSetting };
  }

  async requestLocationPermission(): Promise<{ ok: boolean; needSetting: boolean }> {
    if (this.platform !== 'android') {
      return { ok: true, needSetting: false };
    }

    let setting: Record<string, unknown>;
    try {
      setting = await call('getSetting');
    } catch {
      return { ok: true, needSetting: false }; // 查不到就不拦
    }

    const auth = (setting.authSetting || {}) as Record<string, boolean | undefined>;
    if (auth['scope.userLocation'] === true) {
      const on = isLocationEnabled(this.platform);
      return { ok: on, needSetting: !on };
    }
    if (auth['scope.userLocation'] === false) {
      // 用户之前拒绝过，authorize 不会再弹窗，只能引导去设置页
      return { ok: false, needSetting: true };
    }

    try {
      await call('authorize', { scope: 'scope.userLocation' });
      const on = isLocationEnabled(this.platform);
      return { ok: on, needSetting: !on };
    } catch {
      return { ok: false, needSetting: true };
    }
  }

  async openPermissionSetting(): Promise<{ granted: boolean }> {
    const res = await call('openSetting');
    const auth = (res.authSetting || {}) as Record<string, boolean | undefined>;
    return { granted: auth['scope.userLocation'] === true };
  }

  async startScan(onDevice: (device: RawDevice, res: { devices: RawDevice[] }) => void): Promise<void> {
    const handler = (res: { devices?: RawDevice[] }): void => {
      const devices = (res && res.devices) || [];
      for (const d of devices) {
        if (d && d.deviceId) {
          onDevice(d, { devices });
        }
      }
    };

    // 页面反复进出时不要把回调叠加起来。上一轮如果没退干净，先摘掉一次。
    this.removeDeviceFoundHandler();

    const on = resolveApi('onBluetoothDeviceFound');
    if (!on) {
      throw { errCode: -1, errMsg: '当前平台不支持 onBluetoothDeviceFound' };
    }
    (on as unknown as (cb: (res: unknown) => void) => void)(handler as (res: unknown) => void);
    this.deviceFoundHandler = handler as (res: unknown) => void;

    // 同样容忍「已经在扫描」（already discovering）
    await callTolerant('startBluetoothDevicesDiscovery', {
      allowDuplicatesKey: config.ble.allowDuplicates
    });
  }

  private deviceFoundHandler: ((res: unknown) => void) | null = null;

  async stopScan(): Promise<void> {
    try {
      await call('stopBluetoothDevicesDiscovery');
    } catch {
      // 已经停了或适配器已关，忽略
    }
    // 不扫了就没必要再收设备回调。顺手摘掉，避免页面反复进出时回调叠加、
    // 同一个设备被上报多次导致列表出现重复项。
    this.removeDeviceFoundHandler();
  }

  private removeDeviceFoundHandler(): void {
    const off = resolveApi('offBluetoothDeviceFound');
    if (off && this.deviceFoundHandler) {
      try {
        (off as unknown as (cb: unknown) => void)(this.deviceFoundHandler);
      } catch {
        // 老基础库没有 off 接口，忽略
      }
      this.deviceFoundHandler = null;
    }
  }

  onConnectionStateChange(cb: (connected: boolean) => void): () => void {
    const handler = (res: { deviceId?: string; connected?: boolean }): void => {
      if (res && typeof res.connected === 'boolean') {
        cb(res.connected);
      }
    };

    const on = resolveApi('onBLEConnectionStateChange');
    if (on) {
      (on as unknown as (cb: (res: unknown) => void) => void)(handler as (res: unknown) => void);
    }
    this.connHandler = handler;

    return () => {
      const off = resolveApi('offBLEConnectionStateChange');
      if (off && this.connHandler) {
        try {
          (off as unknown as (cb: unknown) => void)(this.connHandler);
        } catch {
          /* 老基础库没有 off，忽略 */
        }
      }
      this.connHandler = null;
    };
  }

  private connHandler: ((res: { deviceId?: string; connected?: boolean }) => void) | null = null;

  async connect(deviceId: string): Promise<void> {
    // 安卓上如果残留旧连接，直接连会失败。先尽力清一次，失败无所谓。
    try {
      await call('closeBLEConnection', { deviceId });
      await sleep(120);
    } catch {
      // 没有旧连接，正常
    }

    await call('createBLEConnection', {
      deviceId,
      timeout: config.timeouts.connect
    });
  }

  async discover(deviceId: string): Promise<DiscoveredGatt> {
    // 刚连上时部分安卓机型服务列表为空，重试几次
    const servicesRes = await retry(() => call('getBLEDeviceServices', { deviceId }), 3, 400);

    const services = (servicesRes.services || []) as Array<{ uuid: string }>;
    const target = services.find((s) => uuidEquals(s.uuid, config.ble.serviceUuid));

    if (!target) {
      console.warn(
        '[mp-weixin] 未找到服务 ' + config.ble.serviceUuid + '，设备实际服务: ' +
          services.map((s) => s.uuid).join(', ')
      );
      throw { code: 'SERVICE_NOT_FOUND' };
    }

    const charsRes = await retry(
      () => call('getBLEDeviceCharacteristics', { deviceId, serviceId: target.uuid }),
      3,
      400
    );

    const chars = (charsRes.characteristics || []) as Array<{
      uuid: string;
      properties?: { write?: boolean; writeNoResponse?: boolean; notify?: boolean };
    }>;

    const writeChar = chars.find((c) => uuidEquals(c.uuid, config.ble.writeCharUuid));
    const notifyChar = chars.find((c) => uuidEquals(c.uuid, config.ble.notifyCharUuid));

    if (!writeChar || !notifyChar) {
      console.warn(
        '[mp-weixin] 缺少特征值。写 ' + config.ble.writeCharUuid + ': ' + (writeChar ? '有' : '无') +
          '，通知 ' + config.ble.notifyCharUuid + ': ' + (notifyChar ? '有' : '无')
      );
      throw { code: 'CHARACTERISTIC_NOT_FOUND' };
    }

    // 设备侧写特征声明的是 WRITE_REQ（带响应写），优先用它；
    // 万一以后固件改成无响应写，也自动切过去
    const props = writeChar.properties || {};
    const writeType: 'write' | 'writeNoResponse' = props.write
      ? 'write'
      : props.writeNoResponse
        ? 'writeNoResponse'
        : 'write';

    return {
      serviceId: target.uuid,
      writeCharId: writeChar.uuid,
      notifyCharId: notifyChar.uuid,
      writeType
    };
  }

  async negotiateMtu(deviceId: string, writeType: 'write' | 'writeNoResponse'): Promise<number> {
    if (canCallApi('setBLEMTU')) {
      try {
        const res = await call('setBLEMTU', { deviceId, mtu: config.ble.preferredMtu });
        const mtu = typeof res.mtu === 'number' ? res.mtu : 0;
        if (mtu) {
          return mtu;
        }
      } catch {
        // iOS 不支持 setBLEMTU，正常走到下面的兜底
      }
    }

    if (canCallApi('getBLEMTU')) {
      try {
        const res = await call('getBLEMTU', { deviceId, writeType });
        const mtu = typeof res.mtu === 'number' ? res.mtu : 0;
        if (mtu) {
          return mtu;
        }
      } catch {
        // 同样只在安卓可用
      }
    }

    // 都拿不到（iOS 常见）：返回 0，由上层按 BLE 规范最小 MTU 23 处理
    return 0;
  }

  async enableNotify(deviceId: string, serviceId: string, notifyCharId: string): Promise<void> {
    // 容忍「通知已经打开」：重扫时我们会「先关再开」，时序上有可能撞到
    await callTolerant('notifyBLECharacteristicValueChange', {
      deviceId,
      serviceId,
      characteristicId: notifyCharId,
      state: true
    });
  }

  async disableNotify(deviceId: string, serviceId: string, notifyCharId: string): Promise<void> {
    await call('notifyBLECharacteristicValueChange', {
      deviceId,
      serviceId,
      characteristicId: notifyCharId,
      state: false
    });
  }

  onNotify(cb: (value: ArrayBuffer) => void): () => void {
    const handler = (res: { value?: ArrayBuffer }): void => {
      if (res && res.value) {
        cb(res.value);
      }
    };

    const on = resolveApi('onBLECharacteristicValueChange');
    if (on) {
      (on as unknown as (cb: (res: unknown) => void) => void)(handler as (res: unknown) => void);
    }
    this.notifyHandler = handler;

    return () => {
      const off = resolveApi('offBLECharacteristicValueChange');
      if (off && this.notifyHandler) {
        try {
          (off as unknown as (cb: unknown) => void)(this.notifyHandler);
        } catch {
          /* 忽略 */
        }
      }
      this.notifyHandler = null;
    };
  }

  private notifyHandler: ((res: { value?: ArrayBuffer }) => void) | null = null;

  async writeChunk(
    deviceId: string,
    serviceId: string,
    writeCharId: string,
    value: ArrayBuffer,
    writeType: 'write' | 'writeNoResponse'
  ): Promise<void> {
    await call('writeBLECharacteristicValue', {
      deviceId,
      serviceId,
      characteristicId: writeCharId,
      value,
      writeType
    });
  }

  async readRssi(deviceId: string): Promise<number | null> {
    if (!canCallApi('getBLEDeviceRSSI')) {
      return null;
    }
    try {
      const res = await call('getBLEDeviceRSSI', { deviceId });
      return typeof res.RSSI === 'number' ? res.RSSI : null;
    } catch {
      return null;
    }
  }

  async disconnect(deviceId: string): Promise<void> {
    try {
      await call('closeBLEConnection', { deviceId });
    } catch {
      // 已经断了，忽略
    }
  }

  async closeAdapter(): Promise<void> {
    try {
      await call('closeBluetoothAdapter');
    } catch {
      // 忽略
    }
  }
}

export function createMpWeixinAdapter(): BleAdapter {
  return new MpWeixinBleAdapter();
}
