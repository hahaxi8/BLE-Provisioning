/**
 * BLE 客户端编排层测试（用假适配器，不需要真设备和真手机）
 * ---------------------------------------------------------------------------
 * 这是改成 uni-app 之后新增的能力，也是这次重构最大的收益之一：
 * 以前 BleManager 直接调 wx.*，没法在 Node 里跑；现在平台调用被关进了适配器，
 * 编排层（client.ts）只认 BleAdapter 接口，于是可以塞一个假适配器进来，
 * 把整条链路在 Node 里完整跑一遍：
 *
 *   - 分包写入：片数、每片大小、拼回来是否和原文一致
 *   - 收包重组：**在每一个可能的字节位置切分**，验证都能拼回原文
 *     （分片边界切断汉字是最容易出乱码的地方，穷举切分点才敢说真的对）
 *   - 粘包：两个 JSON 挤在一次通知里
 *   - 半截报文超时丢弃
 *   - 重新扫描的「关通知 → 开通知」时序
 *   - 断开后连接态要被清干净
 *
 * 设备固件还没做，真机联调要等到移植完成；但上面这些逻辑现在就能验证。
 *
 * 跑法： node test/run.js
 */

const t = require('./tiny-test');
const { BleClient, toScannedDevice } = require('../src/ble/client.ts');
const proto = require('../src/ble/protocol.ts');
const baseConfig = require('../src/config.ts').config;

/** 测试用的配置：把超时压短，免得测试跑得慢 */
function testSettings() {
  const s = JSON.parse(JSON.stringify(baseConfig));
  s.timeouts = {
    openAdapter: 200,
    scan: 150,
    connect: 200,
    discover: 200,
    wifiList: 150,
    provision: 300,
    rxIdle: 250
  };
  s.ble.writeChunkDelayMs = 1;
  return s;
}

/**
 * 假适配器：实现完整的 BleAdapter 接口，把每次调用记进 calls，
 * 并暴露 emitDevice / emitNotify / emitConnection 让测试主动触发回调。
 */
function createFakeAdapter(options) {
  const opts = options || {};
  const calls = [];
  const state = { deviceCb: null, notifyCb: null, connCb: null };

  const adapter = {
    capabilities: {
      platform: 'fake',
      supportsSetMtu: true,
      supportsRssi: true,
      supportsRescan: true
    },

    async openAdapter() {
      calls.push('openAdapter');
      return { opened: true, locationOk: true, needSetting: false };
    },
    async requestLocationPermission() {
      calls.push('requestLocationPermission');
      return { ok: true, needSetting: false };
    },
    async openPermissionSetting() {
      return { granted: true };
    },
    async startScan(onDevice) {
      calls.push('startScan');
      state.deviceCb = onDevice;
    },
    async stopScan() {
      calls.push('stopScan');
    },
    onConnectionStateChange(cb) {
      state.connCb = cb;
      calls.push('onConnectionStateChange');
      return () => {
        state.connCb = null;
        calls.push('offConnectionStateChange');
      };
    },
    async connect(deviceId) {
      calls.push('connect:' + deviceId);
    },
    async discover() {
      calls.push('discover');
      return {
        serviceId: 'svc-uuid',
        writeCharId: 'write-uuid',
        notifyCharId: 'notify-uuid',
        writeType: 'write'
      };
    },
    async negotiateMtu() {
      calls.push('negotiateMtu');
      return opts.mtu === undefined ? 512 : opts.mtu;
    },
    async enableNotify() {
      calls.push('enableNotify');
    },
    async disableNotify() {
      calls.push('disableNotify');
    },
    onNotify(cb) {
      state.notifyCb = cb;
      return () => {
        state.notifyCb = null;
      };
    },
    async writeChunk(deviceId, serviceId, charId, value, writeType) {
      calls.push({ kind: 'write', bytes: value.byteLength, writeType });
    },
    async readRssi() {
      return -42;
    },
    async disconnect(deviceId) {
      calls.push('disconnect:' + deviceId);
    },
    async closeAdapter() {
      calls.push('closeAdapter');
    }
  };

  return {
    adapter,
    calls,
    /** 模拟设备上报：触发扫描回调 */
    emitDevice(raw) {
      if (state.deviceCb) {
        state.deviceCb(raw, { devices: [raw] });
      }
    },
    /** 模拟设备通知：触发收包回调 */
    emitNotify(bytes) {
      if (state.notifyCb) {
        state.notifyCb(proto.toArrayBuffer(bytes));
      }
    },
    /** 模拟连接状态变化 */
    emitConnection(connected) {
      if (state.connCb) {
        state.connCb(connected);
      }
    },
    hasNotifyHandler() {
      return !!state.notifyCb;
    }
  };
}

/** 建一个已经连上、已完成服务发现的客户端 */
async function connectedClient(options) {
  const fake = createFakeAdapter(options);
  const client = new BleClient(fake.adapter, testSettings());
  await client.connect('AA:BB:CC:DD:EE:FF', 'CS-A1B2C3');
  return { client, fake };
}

/** 把写入调用里的字节数取出来 */
function writtenSizes(calls) {
  return calls.filter((c) => c && c.kind === 'write').map((c) => c.bytes);
}

module.exports = async function () {
  /* ==================================================== 连接与 MTU */
  t.suite('连接与 MTU 协商');

  {
    const { client, fake } = await connectedClient();
    t.ok(client.isConnected(), '连接后 isConnected() 为真');
    t.equal(client.connection.mtu, 512, '协商到的 MTU 是 512');
    t.equal(client.connection.chunkSize, 509, '分包大小 = MTU - 3 = 509');
    t.equal(fake.calls[0], 'openAdapter', '第一步是打开适配器');
    t.ok(fake.calls.indexOf('connect:AA:BB:CC:DD:EE:FF') > 0, '调用了连接且传了正确的 deviceId');
    t.ok(fake.calls.indexOf('discover') > 0, '连接后做了服务发现');
    t.ok(fake.calls.indexOf('negotiateMtu') > 0, '发现服务后协商 MTU');
    t.ok(fake.calls.indexOf('enableNotify') < 0, '连接阶段刻意不开通知（开通知会让设备立刻扫 Wi-Fi，会丢列表）');
    await client.close();
  }

  {
    const { client } = await connectedClient({ mtu: 0 });
    t.equal(client.connection.mtu, 0, '拿不到 MTU 时为 0（iOS 常见）');
    t.equal(client.connection.chunkSize, 20, '拿不到 MTU 时按 BLE 规范最小值兜底：每包 20 字节');
    await client.close();
  }

  /* ==================================================== 分包写入 */
  t.suite('配网信息分包写入');

  {
    // 说个容易被忽略的事实：真实配网报文最大也就 260 字节左右
    // （SSID 32 + 密码 63 + 城市 63 + 区县 63 + JSON 结构），
    // 所以安卓协商到 512 时其实**只有一包**。多包路径要靠 iOS 的低 MTU 才会走到。
    // 这里用 64 的 MTU（每包 61 字节）把多包路径逼出来。
    const { client, fake } = await connectedClient({ mtu: 64 });
    const payload = proto.buildWifiConfigPayload(
      'A'.repeat(32),
      'B'.repeat(63),
      'C'.repeat(60),
      'D'.repeat(60)
    );
    t.ok(
      payload.bytes.length > 61,
      '报文 ' + payload.bytes.length + ' 字节，超过单包 61 字节，确实需要分包'
    );

    const res = await client.writeConfig(payload);
    const expectedChunks = Math.ceil(payload.bytes.length / 61);

    t.equal(res.chunkSize, 61, 'MTU 64 → 每包 61 字节（MTU - 3）');
    t.equal(res.chunks, expectedChunks, '分了 ' + expectedChunks + ' 包');

    const sizes = writtenSizes(fake.calls);
    t.equal(sizes.length, expectedChunks, '适配器收到的写入次数与分包数一致');
    t.ok(
      sizes.every((n) => n <= 61),
      '每一包都不超过 MTU-3'
    );
    t.equal(
      sizes.reduce((a, b) => a + b, 0),
      payload.bytes.length,
      '所有分片加起来等于原文字节数（没有丢字节）'
    );
    t.equal(sizes[sizes.length - 1], payload.bytes.length - (expectedChunks - 1) * 61, '最后一包是余数');

    await client.close();
  }

  {
    // 再造一条超长报文，专门验证 509 字节这个分片边界本身
    const { client, fake } = await connectedClient(); // MTU 512 → 每包 509
    const synthetic = { bytes: new Uint8Array(1200) };

    const res = await client.writeConfig(synthetic);
    t.equal(res.chunks, 3, '1200 字节按 509 切片得到 3 包');
    t.deepEqual(writtenSizes(fake.calls), [509, 509, 182], '分片大小是 509 / 509 / 182');
    t.equal(res.bytes, 1200, '返回的字节数正确');

    await client.close();
  }

  {
    const { client, fake } = await connectedClient({ mtu: 0 });
    const payload = proto.buildWifiConfigPayload('MyWiFi', '12345678', '深圳市', '南山区');
    const res = await client.writeConfig(payload);
    t.equal(res.chunkSize, 20, '没有 MTU 时按 20 字节分包');
    t.equal(res.chunks, Math.ceil(payload.bytes.length / 20), '分包数正确');
    t.ok(
      writtenSizes(fake.calls).every((n) => n <= 20),
      '每包都不超过 20 字节'
    );
    await client.close();
  }

  /* ============================================ 收包分片重组（核心） */
  t.suite('收包分片重组：在每一个字节位置切分都要能拼回来');

  const listJson = '[{"name":"我的WiFi-A"},{"name":"WiFi-B"},{"name":"中文名字"}]';
  const listBytes = proto.encodeUtf8(listJson);

  {
    let allOk = true;
    let firstBad = -1;

    // 穷举所有二分切分点。分片边界会切断汉字，这是最容易出乱码的地方，
    // 只测一两个切分点说明不了问题。
    for (let cut = 1; cut < listBytes.length; cut++) {
      const { client } = await connectedClient();
      let received = null;
      client.on('wifiList', (p) => {
        received = p;
      });

      client.handleNotifyChunk(proto.toArrayBuffer(listBytes.slice(0, cut)));
      client.handleNotifyChunk(proto.toArrayBuffer(listBytes.slice(cut)));

      if (!received || !received.ok || received.list.length !== 3) {
        allOk = false;
        firstBad = cut;
        break;
      }
      const names = received.list.map((x) => x.ssid).join(',');
      if (names !== '我的WiFi-A,WiFi-B,中文名字') {
        allOk = false;
        firstBad = cut;
        break;
      }
      await client.close();
    }

    t.ok(allOk, '在全部 ' + (listBytes.length - 1) + ' 个切分点都能正确拼回（含切断汉字的点）' +
      (allOk ? '' : '；第一个失败点: ' + firstBad));
  }

  {
    // 三片
    const { client } = await connectedClient();
    let received = null;
    client.on('wifiList', (p) => {
      received = p;
    });
    const a = Math.floor(listBytes.length / 3);
    const b = Math.floor((listBytes.length * 2) / 3);
    client.handleNotifyChunk(proto.toArrayBuffer(listBytes.slice(0, a)));
    client.handleNotifyChunk(proto.toArrayBuffer(listBytes.slice(a, b)));
    client.handleNotifyChunk(proto.toArrayBuffer(listBytes.slice(b)));
    t.ok(received && received.list.length === 3, '切成三片也能拼回来');
    t.equal(received.list[0].ssid, '我的WiFi-A', '中文 SSID 没有乱码');
    await client.close();
  }

  {
    // 粘包：两条 JSON 挤在一次通知里
    const { client } = await connectedClient();
    const events = [];
    client.on('wifiList', (p) => events.push(['list', p.list.length]));
    client.on('state', (p) => events.push(['state', p.state]));

    const glued = '[{"name":"A"}]' + '{"state":"success"}';
    client.handleNotifyChunk(proto.toArrayBuffer(proto.encodeUtf8(glued)));

    t.equal(events.length, 2, '一条通知里的两个 JSON 都被分派出去');
    t.equal(events[0][0], 'list', '先分派 Wi-Fi 列表');
    t.equal(events[1][1], 'success', '再分派配网结果');
    await client.close();
  }

  {
    // 半截报文：不派发，且空闲超时后必须丢掉，不能污染下一轮
    const { client } = await connectedClient();
    let fired = 0;
    client.on('wifiList', () => {
      fired++;
    });

    client.handleNotifyChunk(proto.toArrayBuffer(proto.encodeUtf8('[{"name":"半截')));
    t.equal(fired, 0, '半截 JSON 不派发');

    await new Promise((resolve) => setTimeout(resolve, 350)); // 超过 rxIdle(250ms)

    client.handleNotifyChunk(proto.toArrayBuffer(proto.encodeUtf8('"}]')));
    t.equal(fired, 0, '超时丢弃后，后续残片不会被拼成一条假数据');
    await client.close();
  }

  /* ==================================================== 事件分发 */
  t.suite('事件分发');

  {
    const { client } = await connectedClient();
    const raw = [];
    client.on('message', (v) => raw.push(v));

    client.handleNotifyChunk(proto.toArrayBuffer(proto.encodeUtf8('{"state":"fail","msg":"密码错误"}')));
    t.equal(raw.length, 1, 'message 事件收到原始报文（排查用）');

    let state = null;
    client.on('state', (p) => {
      state = p;
    });
    client.handleNotifyChunk(proto.toArrayBuffer(proto.encodeUtf8('{"state":"fail","msg":"密码错误"}')));
    t.equal(state.state, 'fail', 'state 事件解析出 fail');
    t.equal(state.reason, '密码错误', '附带原因也带出来了');
    await client.close();
  }

  /* ==================================================== 重新扫描 */
  t.suite('重新扫描（协议里没有重扫命令，靠重写 CCCD 触发）');

  {
    const { client, fake } = await connectedClient();
    t.ok(!client.isNotifyEnabled(), '初始未开通知');

    await client.enableNotify();
    t.ok(client.isNotifyEnabled(), '开通知后标志为真');

    fake.calls.length = 0;
    await client.triggerRescan();
    t.deepEqual(fake.calls, ['disableNotify', 'enableNotify'], '重扫 = 先关通知再开通知（底层写 0x0000 再写 0x0001）');
    t.ok(client.isNotifyEnabled(), '重扫后通知仍是开着的');

    await client.close();
  }

  /* ============================================ 断开与收尾 */
  t.suite('断开与收尾');

  {
    const { client, fake } = await connectedClient();
    await client.enableNotify();

    let disconnected = null;
    client.on('disconnected', (info) => {
      disconnected = info;
    });

    fake.emitConnection(false);

    t.ok(disconnected, '适配器报告断开时发出了 disconnected 事件');
    t.equal(disconnected.deviceId, 'AA:BB:CC:DD:EE:FF', '事件里带上了断开的 deviceId');
    t.ok(!client.isConnected(), '断开后 isConnected() 必须为假（否则页面会以为还能下发）');
    t.ok(!client.isNotifyEnabled(), '断开后通知标志被清掉');

    await client.close();
  }

  {
    const { client, fake } = await connectedClient();
    await client.enableNotify();
    t.ok(fake.hasNotifyHandler(), '开通知后适配器上挂着数据回调');

    await client.close();
    t.ok(!fake.hasNotifyHandler(), 'close() 之后数据回调被摘掉（不会再有回调打进来）');
    t.ok(fake.calls.indexOf('closeAdapter') > 0, 'close() 关闭了适配器');
  }

  /* ==================================================== 扫描归一化 */
  t.suite('扫描结果归一化');

  {
    // 和设备侧源码逐字节一致的广播包：
    //   02 01 06                           Flags
    //   0A 09 "CS-A1B2C3"                 Local Name
    //   03 16 00 FF                        Service Data - 16bit UUID 0xFF00
    //   03 FF A7 06                        Manufacturer = 芯海 0x06A7
    const adv = new Uint8Array([
      0x02, 0x01, 0x06,
      0x0a, 0x09, 0x43, 0x53, 0x2d, 0x41, 0x31, 0x42, 0x32, 0x43, 0x33,
      0x03, 0x16, 0x00, 0xff,
      0x03, 0xff, 0xa7, 0x06
    ]);

    const settings = testSettings();
    const device = toScannedDevice(
      { deviceId: 'AA:BB:CC:DD:EE:FF', name: 'CS-A1B2C3', RSSI: -52, advertisData: adv.buffer },
      settings
    );

    t.ok(device.matched, '目标设备被判定为可配网');
    t.equal(device.name, 'CS-A1B2C3', '展示名取广播名');
    t.equal(device.bars, 4, '-52 dBm 换算成 4 格');
    t.equal(device.rssiText, '-52 dBm', 'RSSI 文案正确');
    t.equal(device.shortId, 'DDEEFF', '短 id 取 deviceId 里十六进制的尾 6 位');

    const other = toScannedDevice(
      { deviceId: 'XX:XX:XX:XX:XX:XX', name: 'HUAWEI FreeClip', RSSI: -70, advertisData: null },
      settings
    );
    t.ok(!other.matched, '无关设备（耳机）不被判定为可配网');
    t.equal(other.bars, 2, '-70 dBm 落在 [-75, -65) 区间，换算成 2 格');

    const unnamed = toScannedDevice({ deviceId: 'AA:BB:CC:DD:EE:FF', advertisData: adv.buffer }, settings);
    t.equal(unnamed.name, 'CS-A1B2C3', '没有名字时从广播内容里回填，界面不会显示“未命名”');
  }
};
