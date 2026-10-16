/**
 * 极简测试框架（零依赖）
 * ---------------------------------------------------------------------------
 * 为什么不用 jest / mocha：
 *   1. 这个项目要能在一台干净的 CentOS 上 `node test/run.js` 就跑起来，
 *      不该为了几个断言去装几百个 npm 包；
 *   2. 协议测试是纯函数测试，本来就不需要 mock 框架。
 */

let passed = 0;
let failed = 0;
const failures = [];
let currentSuite = '';

function suite(name) {
  currentSuite = name;
  console.log('\n\x1b[36m▌ ' + name + '\x1b[0m');
}

function record(ok, name, detail) {
  if (ok) {
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } else {
    failed++;
    failures.push({ suite: currentSuite, name: name, detail: detail });
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    if (detail) {
      console.log('      \x1b[31m' + detail.replace(/\n/g, '\n      ') + '\x1b[0m');
    }
  }
}

function ok(cond, name) {
  record(!!cond, name, cond ? '' : '期望为真，实际为 ' + JSON.stringify(cond));
}

function equal(actual, expected, name) {
  const same = actual === expected;
  record(
    same,
    name,
    same ? '' : '期望 ' + JSON.stringify(expected) + '\n实际 ' + JSON.stringify(actual)
  );
}

function deepEqual(actual, expected, name) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  record(a === b, name, a === b ? '' : '期望 ' + b + '\n实际 ' + a);
}

function throws(fn, name) {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
  }
  record(threw, name, threw ? '' : '期望抛异常，但没有');
}

function doesNotThrow(fn, name) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  record(!err, name, err ? '不该抛异常，但抛了: ' + err.message : '');
}

function summary() {
  const total = passed + failed;
  console.log('\n' + '─'.repeat(64));
  if (failed === 0) {
    console.log('\x1b[32m全部通过: ' + passed + '/' + total + '\x1b[0m');
  } else {
    console.log('\x1b[31m失败 ' + failed + ' 个，通过 ' + passed + ' 个，共 ' + total + '\x1b[0m');
    console.log('\n失败清单:');
    failures.forEach(function (f) {
      console.log('  - [' + f.suite + '] ' + f.name);
    });
  }
  console.log('─'.repeat(64));
  return failed === 0;
}

module.exports = {
  suite: suite,
  ok: ok,
  equal: equal,
  deepEqual: deepEqual,
  throws: throws,
  doesNotThrow: doesNotThrow,
  summary: summary
};
