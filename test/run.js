#!/usr/bin/env node
/**
 * 测试入口
 * ---------------------------------------------------------------------------
 * 跑法（以下命令都在 BLE-Provisioning 目录下执行）：
 *   node test/run.js          （或者 npm test）
 *
 * 退出码：0 = 全部通过，1 = 有失败（可直接接进 CI）。
 *
 * 为什么这个项目必须有测试：
 *   设备固件还没写，小程序写完了也没设备可连。协议理解一旦有偏差（字段名、
 *   中文编码、分包重组），要等到固件做出来才暴露，那时候返工最贵。
 *
 * 四个测试文件的分工：
 *   protocol.test.js   协议对不对 —— 报文格式、UTF-8、分片重组、广播解析
 *   client.test.js     编排对不对 —— 用假适配器把整条配网链路跑一遍
 *   regions.test.js    数据对不对 —— 三级区划完整性、直辖市、索引夹紧
 *   structure.test.js  接得对不对 —— 页面文件、import 路径、平台隔离、工程配置
 *
 * 注意：测试直接 require .ts 源码，不需要先编译 —— Node 22.6+ 原生支持
 * TypeScript 的类型剥离（本机是 Node 26）。这也是为什么源码里的相对 import
 * 都强制带 .ts 后缀：Node 的 ESM 解析器要求显式扩展名。
 */

const t = require('./tiny-test');

(async function main() {
  console.log('BLE 配网小程序（uni-app + Vue 3 + TypeScript）— 测试开始');
  console.log('='.repeat(64));

  await require('./protocol.test')();
  await require('./client.test')();
  await require('./regions.test')();
  require('./structure.test')();

  const ok = t.summary();
  process.exit(ok ? 0 : 1);
})().catch(function (err) {
  console.error('\n[FATAL] 测试运行器自身出错：');
  console.error(err);
  process.exit(1);
});
