/**
 * 协议层测试
 * ---------------------------------------------------------------------------
 * 这些测试的意义：设备固件还没写，小程序写完了也没东西可连。所以「协议理解对不对」
 * 只能靠测试保证 —— 期望值全部来自 `docs/device-integration.md` 里写死的协议约定，
 * 以及真实空口字节的构造，不是随手编的。
 *
 * 跑法： node test/run.js
 */

const t = require('./tiny-test');
const proto = require('../src/ble/protocol.ts');

/** 协议层要的是 BleConfig 本身，不是整个 settings 对象 */
const BLE = require('../src/config.ts').config.ble;

/** 把字节数组转成十六进制串，方便断言 */
function hex(bytes) {
  return proto.bytesToHex(bytes, ' ');
}

/**
 * 构造设备侧示例真实会发出来的广播包。
 * 按协议约定构造的设备广播包：
 *   flags            02 01 06
 *   local name       0A 09 "CS-A1B2C3"   （"CS-" + MAC 前 3 字节，大写十六进制）
 *   service data     03 16 00 FF          （AD type 0x16 + 16 位 UUID 0xFF00）
 *   manufacturer     03 FF A7 06          （芯海 CHIPSEA_COMPANY_ID = 0x06A7）
 *
 * 注意 Service Data 的两个字节是 00 FF 而不是 FF 00：设备侧写的是
 *   adv_data[i++] = UUID & 0xFF;   → 0x00
 *   adv_data[i++] = UUID >> 8;     → 0xFF
 * 蓝牙 UUID 按小端传输，所以 00 FF 才代表 0xFF00。这个字节序很容易记反。
 */
const DEVICE_ADV = new Uint8Array([
  0x02, 0x01, 0x06,
  0x0a, 0x09, 0x43, 0x53, 0x2d, 0x41, 0x31, 0x42, 0x32, 0x43, 0x33,
  0x03, 0x16, 0x00, 0xff,
  0x03, 0xff, 0xa7, 0x06
]);

module.exports = function () {
  /* ======================================================== UTF-8 编解码 */
  t.suite('UTF-8 编解码');

  t.equal(hex(proto.encodeUtf8('CS-A1B2C3')), '43 53 2D 41 31 42 32 43 33', 'ASCII 逐字节');
  // 「深圳」的 UTF-8 是 E6 B7 B1 E5 9C B3 —— 中文 SSID 必须原样发 UTF-8
  t.equal(hex(proto.encodeUtf8('深圳')), 'E6 B7 B1 E5 9C B3', '中文按 UTF-8 三字节编码');
  t.equal(hex(proto.encodeUtf8('é')), 'C3 A9', '两字节字符');
  t.equal(hex(proto.encodeUtf8('😀')), 'F0 9F 98 80', '四字节 emoji 走代理对');
  t.equal(proto.encodeUtf8('').length, 0, '空串得到空数组');

  t.equal(proto.decodeUtf8(proto.encodeUtf8('深圳市南山区')), '深圳市南山区', '中文往返一致');
  t.equal(proto.decodeUtf8(proto.encodeUtf8('WiFi-5G_测试😀')), 'WiFi-5G_测试😀', '混合内容往返一致');

  // 收到脏数据时不能抛异常，也不能把整包丢掉
  t.doesNotThrow(function () {
    proto.decodeUtf8(new Uint8Array([0xff, 0xfe, 0x41]));
  }, '非法字节不抛异常');
  t.equal(proto.decodeUtf8(new Uint8Array([0xff, 0x41])), '\ufffdA', '非法字节替换为 U+FFFD');

  /* ==================================================== 分片边界处理 */
  t.suite('分片边界（BLE 分片会切断汉字）');

  const shenzhen = proto.encodeUtf8('深圳'); // E6 B7 B1 | E5 9C B3
  t.equal(proto.utf8SafeLength(new Uint8Array([0xe6, 0xb7, 0xb1, 0xe5])), 3, '尾部半个字符时只解码前面完整的');

  const first = proto.decodeUtf8Stream(new Uint8Array([0xe6, 0xb7, 0xb1, 0xe5]));
  t.equal(first.text, '深', '第一片解出「深」');
  t.equal(hex(first.carry), 'E5', '残字节 E5 留到下一片');

  const second = proto.decodeUtf8Stream(proto.concatBytes(first.carry, new Uint8Array([0x9c, 0xb3])));
  t.equal(second.text, '圳', '第二片拼回「圳」');
  t.equal(second.carry.length, 0, '拼完没有残留');

  t.equal(proto.decodeUtf8Stream(shenzhen).text, '深圳', '不分片时一次解完');

  /* ============================================================== 分包 */
  t.suite('分包写入');

  const chunks = proto.chunkBytes(proto.encodeUtf8('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 20);
  t.equal(chunks.length, 2, '36 字节按 20 字节切成 2 片');
  t.equal(chunks[0].length, 20, '第一片 20 字节');
  t.equal(chunks[1].length, 16, '第二片 16 字节');
  t.equal(proto.decodeUtf8(proto.concatBytes(chunks[0], chunks[1])), '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', '拼回来内容一致');
  t.equal(proto.chunkBytes(new Uint8Array([1, 2, 3]), 20).length, 1, '不足一片时只有一片');

  /* ============================================================== UUID */
  t.suite('UUID 归一化');

  t.equal(proto.expandUuid('FF00'), '0000FF00-0000-1000-8000-00805F9B34FB', '16 位补成 128 位');
  t.equal(proto.expandUuid('ff00'), '0000FF00-0000-1000-8000-00805F9B34FB', '小写也认');
  t.equal(proto.expandUuid('0000FF01-0000-1000-8000-00805F9B34FB'), '0000FF01-0000-1000-8000-00805F9B34FB', '本来就是 128 位则原样');
  t.ok(proto.uuidEquals('FF01', '0000FF01-0000-1000-8000-00805F9B34FB'), '配置写 FF01、微信返回 128 位，仍判为相同');
  t.ok(!proto.uuidEquals('FF01', '0000FF02-0000-1000-8000-00805F9B34FB'), '不同 UUID 判为不同');

  /* ======================================================== 配网报文构造 */
  t.suite('配网报文构造（手机 → 设备）');

  const simple = proto.buildWifiConfigPayload('MyWiFi', '12345678');
  t.equal(simple.text, '{"ssid":"MyWiFi","pwd":"12345678"}', '基础字段名必须是 ssid / pwd');
  t.equal(simple.object.city, undefined, '不传城市时 JSON 里没有 city 字段');

  const full = proto.buildWifiConfigPayload('MyWiFi', '12345678', '深圳市', '南山区');
  t.equal(
    full.text,
    '{"ssid":"MyWiFi","pwd":"12345678","city":"深圳市","district":"南山区"}',
    '带城市与区级的完整报文'
  );
  t.ok(full.text.indexOf('\\u') < 0, '中文不做 \\uXXXX 转义，直接发 UTF-8（cJSON 能解析）');
  t.equal(full.bytes.length, proto.encodeUtf8(full.text).length, '字节长度与 UTF-8 编码一致');
  t.ok(full.arrayBuffer instanceof ArrayBuffer, 'arrayBuffer 可用于 writeBLECharacteristicValue');

  const emptyCity = proto.buildWifiConfigPayload('MyWiFi', '12345678', '', '');
  t.equal(emptyCity.text, '{"ssid":"MyWiFi","pwd":"12345678"}', '城市/区级为空则不塞进 JSON');

  const located = proto.buildWifiConfigPayload(
    'MyWiFi', '12345678', '深圳市', '南山区', 22.5331234, 113.9305678
  );
  t.equal(
    located.text,
    '{"ssid":"MyWiFi","pwd":"12345678","city":"深圳市","district":"南山区","latitude":22.533123,"longitude":113.930568}',
    '手机经纬度保留 6 位小数随配网报文发送'
  );

  const openNet = proto.buildWifiConfigPayload('OpenWiFi', '');
  t.equal(openNet.text, '{"ssid":"OpenWiFi","pwd":""}', '开放网络密码发空串');

  // 设备侧 cJSON_Parse 必须能吃得下 —— 这里用 Node 的 JSON.parse 做等价检查
  t.doesNotThrow(function () {
    JSON.parse(full.text);
  }, '报文是合法 JSON');

  /* ================================================ JSON 流式提取（分片粘包） */
  t.suite('JSON 流式提取（收包分片与粘包）');

  const one = proto.extractJsonValues('{"state":"success"}');
  t.equal(one.values.length, 1, '提取出 1 个 JSON');
  t.equal(one.values[0].state, 'success', '内容正确');
  t.equal(one.rest, '', '没有剩余');

  const glued = proto.extractJsonValues('{"state":"success"}{"state":"fail"}');
  t.equal(glued.values.length, 2, '两包粘在一起也能拆成 2 个');
  t.equal(glued.values[1].state, 'fail', '第二个内容正确');

  const partial = proto.extractJsonValues('[{"name":"WiFi-A"},{"name":"Wi');
  t.equal(partial.values.length, 0, '半截报文不派发');
  t.equal(partial.rest, '[{"name":"WiFi-A"},{"name":"Wi', '半截报文完整留到下一片');

  const after = proto.extractJsonValues(partial.rest + 'Fi-B"}]');
  t.equal(after.values.length, 1, '补齐后能解析出来');
  t.equal(after.values[0].length, 2, '两条记录都在');

  // SSID 里真的可能带奇怪字符，括号和引号不能让解析跑偏。
  // 注意下面 \\" 的写法：这是「线上真实字节」的样子 —— 合法 JSON 里带引号的
  // SSID 会被转义成 \" 两个字符，所以 JS 字面量要写成 \\"。
  const tricky = proto.extractJsonValues('[{"name":"a}b\\"c"},{"name":"d"}]');
  t.equal(tricky.values.length, 1, '字符串里的 } 和转义引号不破坏配平');
  t.equal(tricky.values[0][0].name, 'a}b"c', 'SSID 原样解出');
  t.equal(tricky.values[0][1].name, 'd', '后一条也没被吞');

  // 反过来的真实风险：设备侧示例是用 os_snprintf 手工拼 JSON 的，没有转义 SSID，
  // 所以 SSID 里带引号时设备发出来的就是非法 JSON。这里把行为钉死，
  // 免得以后有人以为是手机端解析器写错了。（设备侧修法见 docs/device-integration.md 的 3.3 节）
  const unescaped = proto.extractJsonValues('[{"name":"a}b"c"},{"name":"d"}]');
  t.equal(
    unescaped.values.length,
    0,
    '设备侧未转义引号产生非法 JSON 时，手机端选择不派发（不猜、不吞错数据）'
  );

  t.equal(proto.extractJsonValues('').values.length, 0, '空文本不报错');
  t.equal(proto.extractJsonValues('not json at all').values.length, 0, '非 JSON 文本不报错');

  /* ==================================================== Wi-Fi 列表解析 */
  t.suite('Wi-Fi 列表解析（设备 → 手机）');

  const nativeList = proto.parseWifiList('[{"name":"WiFi-A"},{"name":"WiFi-B"}]');
  t.ok(nativeList.ok, '设备示例格式解析成功');
  t.equal(nativeList.list.length, 2, '解析出 2 个 AP');
  t.equal(nativeList.list[0].ssid, 'WiFi-A', 'SSID 正确');
  t.equal(nativeList.list[0].rssi, null, '示例不带 rssi，解析为空而不是报错');

  const withRssi = proto.parseWifiList([
    { name: '弱', rssi: -80 },
    { name: '强', rssi: -40 },
    { name: '中', rssi: -60 }
  ]);
  t.equal(withRssi.list[0].ssid, '强', '有 rssi 时按信号强度降序（自动适配设备以后加字段）');
  t.equal(withRssi.list[2].ssid, '弱', '最弱的排最后');

  const dedup = proto.parseWifiList([
    { name: 'Same', rssi: -80 },
    { name: 'Same', rssi: -50 },
    { name: 'Other', rssi: -60 }
  ]);
  t.equal(dedup.list.length, 2, '同一 SSID 被多个 AP 广播时合并成一条');
  t.equal(dedup.list[0].ssid, 'Same', '合并后保留最强信号');
  t.equal(dedup.list[0].rssi, -50, '保留的是 -50 而不是 -80');

  t.ok(proto.parseWifiList('[]').ok, '空数组是合法结果（扫不到 AP）');
  t.ok(proto.parseWifiList('[]').empty, '空数组标记为 empty');

  t.equal(proto.parseWifiList('[{"ssid":"别名字段"}]').list[0].ssid, '别名字段', '字段名叫 ssid 也认');
  t.equal(proto.parseWifiList('[{"name":""}]').list.length, 0, '空名字的条目丢弃');
  t.ok(proto.parseWifiList('这不是JSON').ok === false, '非法 JSON 返回 ok=false 而不是抛异常');
  t.equal(
    proto.parseWifiList({ list: [{ name: '被包了一层' }] }).list[0].ssid,
    '被包了一层',
    '以后设备多包一层 {list:[...]} 也能解析'
  );

  /* ==================================================== 配网结果解析 */
  t.suite('配网结果解析（设备 → 手机）');

  t.equal(proto.parseDeviceState('{"state":"success"}').state, 'success', 'success 识别正确');
  t.equal(proto.parseDeviceState('{"state":"fail"}').state, 'fail', 'fail 识别正确');
  t.equal(proto.parseDeviceState({ state: 'SUCCESS' }).state, 'success', '大小写不敏感');
  t.equal(proto.parseDeviceState({ success: true }).state, 'success', '布尔写法也认');
  t.equal(proto.parseDeviceState({ status: 'ok' }).state, 'success', 'status:ok 也认');
  t.equal(proto.parseDeviceState({ state: 'fail', msg: '密码错误' }).reason, '密码错误', '附带原因能取出来');
  t.equal(proto.parseDeviceState('{}').state, 'unknown', '认不出来就是 unknown，不猜');
  t.equal(proto.parseDeviceState('乱码').state, 'unknown', '非法 JSON 不抛异常');

  t.equal(proto.classifyPayload([{ name: 'a' }]), 'wifiList', '数组归类为 Wi-Fi 列表');
  t.equal(proto.classifyPayload({ state: 'success' }), 'state', '带 state 的归类为结果');
  t.equal(proto.classifyPayload({ foo: 1 }), 'unknown', '其它归类为 unknown');

  /* ==================================================== 广播包解析与过滤 */
  t.suite('广播包解析与设备过滤');

  const adv = proto.parseAdvertisData(DEVICE_ADV);
  t.equal(adv.flags, 0x06, 'flags 解析正确');
  t.equal(adv.localName, 'CS-A1B2C3', '广播名解析正确（设备发的是 CS- + MAC 前 3 字节）');
  t.equal(adv.serviceData.length, 1, '解析出 1 条 Service Data');
  t.equal(adv.serviceData[0].uuid, 'FF00', 'Service Data 的 UUID 是 FF00');
  t.equal(adv.manufacturer.id, 0x06a7, '厂商 ID 是芯海 0x06A7（小端 A7 06）');

  const named = proto.deviceMatchesFilter(
    { deviceId: 'AA:BB:CC:DD:EE:FF', name: 'CS-A1B2C3', advertisData: DEVICE_ADV.buffer },
    BLE
  );
  t.ok(named.matched, '广播名带 CS- 前缀 → 命中');
  t.ok(named.nameMatch, '记录为名字命中');

  // 部分安卓机型拿不到 advertisData，必须靠名字也能匹配
  const nameOnly = proto.deviceMatchesFilter(
    { deviceId: 'AA:BB:CC:DD:EE:FF', name: 'CS-A1B2C3', advertisData: null },
    BLE
  );
  t.ok(nameOnly.matched, '只有广播名、没有 advertisData 时仍能命中');

  // 反过来，有些机型名字拿不到，只能靠广播内容
  const advOnly = proto.deviceMatchesFilter(
    { deviceId: 'AA:BB:CC:DD:EE:FF', name: '', advertisData: DEVICE_ADV.buffer },
    BLE
  );
  t.ok(advOnly.matched, '只有广播内容、没有名字时仍能命中');
  t.ok(advOnly.advMatch, '记录为广播内容命中');
  t.equal(advOnly.displayName, 'CS-A1B2C3', '显示名从广播里回填，界面不会显示“未命名”');

  const other = proto.deviceMatchesFilter(
    { deviceId: 'X', name: 'HUAWEI FreeClip', advertisData: new Uint8Array([0x02, 0x01, 0x06]).buffer },
    BLE
  );
  t.ok(!other.matched, '无关设备（耳机）不命中');

  const strict = JSON.parse(JSON.stringify(BLE));
  strict.filterMode = 'name-and-adv';
  t.ok(
    proto.deviceMatchesFilter({ name: 'CS-A1B2C3', advertisData: null }, strict).matched === false,
    "filterMode='name-and-adv' 时，只有名字不算命中"
  );
  t.ok(
    proto.deviceMatchesFilter({ name: 'CS-A1B2C3', advertisData: DEVICE_ADV.buffer }, strict).matched,
    "filterMode='name-and-adv' 时，两者都有才算命中"
  );

  // 长度字段越界的坏广播不能让解析崩掉
  t.doesNotThrow(function () {
    proto.parseAdvertisData(new Uint8Array([0xff, 0x09, 0x01]));
  }, '损坏的广播数据不抛异常');

  /* ============================================================ 展示辅助 */
  t.suite('展示辅助与输入校验');

  t.equal(proto.rssiToBars(-50), 4, '-50 dBm 满格');
  t.equal(proto.rssiToBars(-70), 2, '-70 dBm 两格');
  t.equal(proto.rssiToBars(-90), 0, '-90 dBm 无格');
  t.equal(proto.rssiToBars(null), 0, '没有 rssi 时不报错，显示 0 格');

  t.ok(proto.validateSsid('MyWiFi').ok, '正常 SSID 通过');
  t.ok(!proto.validateSsid('').ok, '空 SSID 不通过');
  t.ok(!proto.validateSsid('一二三四五六七八九十一二').ok, '超过 32 字节的 SSID 不通过');

  t.ok(proto.validatePassword('12345678').ok, '8 位密码通过');
  t.ok(!proto.validatePassword('123').ok, '少于 8 位不通过（路由器不会接受）');
  t.ok(proto.validatePassword('').ok, '空密码按开放网络放行');

  const limit = BLE.deviceTextMaxBytes;
  t.equal(limit, 63, '设备侧城市/区级可用 63 字节（char[64] 留一个 \\0）');
  t.ok(proto.validateDeviceText('深圳市', '城市', limit).ok, '「深圳市」放得进设备缓冲区');
  t.ok(proto.validateDeviceText('黔西南布依族苗族自治州', '城市', limit).ok, '33 字节的市名可以下发');
  t.ok(
    proto.validateDeviceText('内蒙古阿拉善高新技术产业开发区', '区县', limit).ok,
    '45 字节的区名可以下发'
  );
  t.ok(
    !proto.validateDeviceText('内蒙古阿拉善高新技术产业开发区', '区县', limit).message,
    '合法区名不产生错误提示'
  );
  t.ok(proto.validateDeviceText('', '城市', limit).ok === false, '没选城市时不通过');

  /* -------------------------------------------------- 超长名称的安全截断 */
  t.suite('超长名称按 UTF-8 安全截断');

  t.equal(proto.truncateUtf8('深圳市', 23).truncated, false, '没超长时原样返回');
  t.equal(proto.truncateUtf8('深圳市', 23).text, '深圳市', '没超长时内容不变');

  const cut = proto.truncateUtf8('内蒙古阿拉善高新技术产业开发区', 23);
  t.ok(cut.truncated, '45 字节的名称被判定为超长');
  t.equal(cut.text, '内蒙古阿拉善高', '按完整汉字截断（7 字 = 21 字节），不会切出半个字');
  t.equal(proto.encodeUtf8(cut.text).length, 21, '截断结果 21 字节，不超过 23');
  t.equal(proto.decodeUtf8(proto.encodeUtf8(cut.text)), '内蒙古阿拉善高', '截断结果仍是合法 UTF-8');

  const longCity = proto.truncateUtf8('黔西南布依族苗族自治州', 23);
  t.equal(proto.encodeUtf8(longCity.text).length <= 23, true, '33 字节的市名也截到 23 字节以内');
  // 11 个字 × 3 字节 = 33 字节，23/3 向下取整是 7 个字（21 字节），第 8 个字会到 24 字节超限
  t.equal(longCity.text, '黔西南布依族苗', '截断点为完整汉字边界（7 个字 = 21 字节）');
  t.equal(proto.encodeUtf8(longCity.text).length, 21, '截断结果正好 21 字节');

  // 代理对（emoji）不能被切成半个，否则会产生非法 UTF-8
  const emoji = proto.truncateUtf8('😀😀😀😀😀😀😀😀', 23);
  t.equal(proto.encodeUtf8(emoji.text).length, 20, '每个 emoji 4 字节，23 字节上限下只能放下 5 个');
  t.equal(emoji.text, '😀😀😀😀😀', 'emoji 数量正确且没有半个代理项');

  t.equal(proto.truncateUtf8('', 23).text, '', '空串不报错');
  t.equal(proto.truncateUtf8('abc', 0).text, '', '上限为 0 时返回空串');

  /* ============================ 「假失败」识别（真机上踩过的坑） */
  t.suite('「已经是目标状态」的假失败要被识别出来');

  // 微信在蓝牙已经打开时，openBluetoothAdapter 走的是 fail 回调：
  //   { errCode: 10000, errMsg: 'openBluetoothAdapter:fail already opened' }
  // 如果当成错误，整个配网流程会卡死在第一步，而且重试永远失败。
  const errs = require('../src/ble/errors.ts');
  const benign = [
    'openBluetoothAdapter:fail already opened',
    'openBluetoothAdapter:fail Already Opened',
    'startBluetoothDevicesDiscovery:fail already discovering',
    'notifyBLECharacteristicValueChange:fail already notify',
    'closeBLEConnection:fail already closed',
    'stopBluetoothDevicesDiscovery:fail not start',
    'closeBLEConnection:fail not connected'
  ];
  benign.forEach(function (msg) {
    t.ok(errs.isBenignBleError({ errCode: 10000, errMsg: msg }), '识别为假失败：' + msg);
  });

  // 真错误绝不能被吞掉 —— 吞了就等于把问题藏起来
  [
    'openBluetoothAdapter:fail:10001 adapter not available',
    'createBLEConnection:fail:10003 connection fail',
    'getBLEDeviceServices:fail:10004 no service',
    'writeBLECharacteristicValue:fail:10008 system error',
    'startBluetoothDevicesDiscovery:fail:10009 not support'
  ].forEach(function (msg) {
    t.ok(!errs.isBenignBleError({ errCode: 10001, errMsg: msg }), '不误判为假失败：' + msg);
  });

  t.ok(!errs.isBenignBleError(null), 'null 不算假失败');
  t.ok(!errs.isBenignBleError(undefined), 'undefined 不算假失败');
  t.ok(!errs.isBenignBleError({}), '空对象不算假失败');
  t.ok(!errs.isBenignBleError({ errMsg: '' }), '空 errMsg 不算假失败');
  t.ok(errs.isBenignBleError('already opened'), '直接传字符串也能识别');
  t.ok(errs.isBenignBleError(new Error('openBluetoothAdapter:fail already opened')), 'Error 对象也能识别');
};
