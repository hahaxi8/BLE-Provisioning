/**
 * 工程结构测试（uni-app 版）
 * ---------------------------------------------------------------------------
 * 协议测试保证「想对了」，客户端测试保证「编排对了」，这个文件保证「接对了」。
 *
 * 它专门抓这几类只在运行时才炸、而且很难查的问题：
 *   1. pages.json 里登记的页面缺 .vue 文件 —— 一进就白屏
 *   2. pages/ 下建了页面但忘了登记 —— 点进去直接失败（原生版就踩过这个）
 *   3. 相对 import 忘了写 .ts 后缀 —— Node 直接跑测试时会解析不到
 *   4. 纯逻辑模块里混进了 uni./wx. 调用 —— 会导致 `node test/run.js` 再也跑不起来
 *   5. 平台调用漏在 adapters/ 外面 —— 破坏了「换平台只写适配器」这个架构约定
 *   6. data/regions.ts 结构坏了
 *
 * 跑法： node test/run.js
 */

const fs = require('fs');
const path = require('path');
const t = require('./tiny-test');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

/** 递归收集 SRC 下某扩展名的文件，返回相对 SRC 的路径（用 / 分隔） */
function walk(ext, out, dir) {
  const base = dir || '';
  const result = out || [];
  const abs = path.join(SRC, base);
  if (!fs.existsSync(abs)) {
    return result;
  }
  for (const name of fs.readdirSync(abs)) {
    const rel = base ? base + '/' + name : name;
    const full = path.join(SRC, rel);
    if (fs.statSync(full).isDirectory()) {
      walk(ext, result, rel);
    } else if (name.slice(-ext.length) === ext) {
      result.push(rel);
    }
  }
  return result;
}

/**
 * 去掉注释再检查。
 *
 * 必须**识别字符串状态**，不能用朴素的块注释正则：
 * tsconfig.json 的 paths 里有 "@" 加斜杠加星号这种写法，会被当成块注释开头；
 * include 里还有带通配的 glob 路径，其中的「星号加斜杠」会被当成块注释结尾。
 * 结果就是一大段合法 JSON 被吃掉，JSON.parse 报
 * "Bad control character in string literal" 这种莫名其妙的错。
 *
 * 这些文件里到处都在注释里提 uni.getStorageSync / wx.setBLEMTU，
 * 所以检查前必须把注释去掉 —— 要拦的是**真的调用**，不是提及。
 */
function stripComments(src) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inString) {
      out += c;
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }

    // 行注释
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        i++;
      }
      out += '\n';
      continue;
    }

    // 块注释
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        i++;
      }
      i += 1; // 跳过结尾的 '/'
      continue;
    }

    out += c;
  }

  return out;
}

/** 找出第一个真实的平台调用，返回可读位置 */
function findPlatformCall(src) {
  const lines = stripComments(src).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/\b(uni|wx)\s*\./.test(lines[i])) {
      return '第 ' + (i + 1) + ' 行: ' + lines[i].trim();
    }
  }
  return null;
}

module.exports = function () {
  /* ============================================== pages.json 与页面文件 */
  t.suite('pages.json 与页面文件完整性');

  // uni-app 的 pages.json 允许注释（JSONC），这里用宽松方式解析
  let pagesJson = null;
  t.doesNotThrow(function () {
    pagesJson = JSON.parse(stripComments(read('src/pages.json')));
  }, 'src/pages.json 是合法 JSON');

  const pages = (pagesJson && pagesJson.pages) || [];
  t.equal(pages.length, 5, '登记了 5 个页面');

  pages.forEach(function (p) {
    t.ok(exists('src/' + p.path + '.vue'), p.path + '.vue 存在');
  });

  // 反向检查：pages/ 下有没有「建了但没登记」的页面
  const pageDirs = fs.readdirSync(path.join(SRC, 'pages')).filter(function (n) {
    return fs.statSync(path.join(SRC, 'pages', n)).isDirectory();
  });
  pageDirs.forEach(function (dir) {
    t.ok(
      pages.some(function (p) {
        return p.path === 'pages/' + dir + '/' + dir;
      }),
      'pages/' + dir + ' 已登记进 pages.json'
    );
  });

  // 反向检查之二：源码里跳转的目标必须是登记过的页面。
  //
  // 这条是删页面时踩出来的：删掉 pages/index 之后，result.vue 里还留着
  //   uni.reLaunch({ url: '/pages/index/index' })
  // 编译、类型检查全都不报错，只有用户点「完成」的那一刻才会炸「页面不存在」。
  const registered = {};
  pages.forEach(function (p) {
    registered[p.path] = true;
  });
  const NAV_RE =
    /(?:navigateTo|redirectTo|reLaunch|switchTab)\s*\(\s*\{\s*url\s*:\s*['"]\/([^'"?]+)/g;
  const navFiles = walk('.ts').concat(walk('.vue'));
  let navChecked = 0;
  navFiles.forEach(function (rel) {
    const src = read('src/' + rel);
    let m;
    while ((m = NAV_RE.exec(src)) !== null) {
      navChecked++;
      t.ok(
        !!registered[m[1]],
        'src/' + rel + ' 跳转的 /' + m[1] + ' 已在 pages.json 里登记'
      );
    }
  });
  t.ok(navChecked > 0, '至少检查到一处页面跳转（共 ' + navChecked + ' 处）');

  /* ============================================================ manifest */
  t.suite('manifest.json 配置与 AppID 隐私');

  // src/manifest.json 使用空 AppID 纳入版本管理，真机调试时由开发者本地填写。
  t.ok(
    exists('src/manifest.json'),
    'src/manifest.json 存在（缺失就执行：cp src/manifest.example.json src/manifest.json）'
  );
  t.ok(
    exists('src/manifest.example.json'),
    'src/manifest.example.json 存在（提交进 git 的那份模板）'
  );

  const gitignore = read('.gitignore');
  t.ok(!/^src\/manifest\.json\s*$/m.test(gitignore),
    'src/manifest.json 使用空 AppID 纳入版本管理');

  // 注意：只检查**真正的规则行**，不看注释 —— .gitignore 的说明里就跑着
  // manifest.example.json 这个名字，用 indexOf 会误判。
  const ignoreRules = gitignore
    .split('\n')
    .map(function (line) {
      return line.trim();
    })
    .filter(function (line) {
      return line && line.charAt(0) !== '#';
    });

  t.ok(
    ignoreRules.indexOf('src/manifest.example.json') < 0 &&
      ignoreRules.indexOf('manifest.example.json') < 0 &&
      ignoreRules.indexOf('*.example.json') < 0,
    'manifest.example.json 没有被误加进 .gitignore（模板必须能提交）'
  );
  t.ok(
    ignoreRules.indexOf('dist') >= 0,
    '.gitignore 里忽略了 dist（构建产物不进 git）'
  );

  if (exists('src/manifest.json')) {
    let manifest = null;
    t.doesNotThrow(function () {
      manifest = JSON.parse(stripComments(read('src/manifest.json')));
    }, 'src/manifest.json 是合法 JSON');

    t.equal(manifest.vueVersion, '3', '声明使用 Vue 3');
    t.ok(manifest['mp-weixin'], '有 mp-weixin 段');

    // 这一条是踩过坑才写下的：uni-app 只把 manifest.json[platform] 合并进 app.json，
    // 写在 pages.json 顶层的 permission 会被静默丢掉。
    t.ok(
      manifest['mp-weixin'] && manifest['mp-weixin'].permission,
      'permission 写在 manifest.json 的 mp-weixin 段里（写在 pages.json 顶层会被丢掉）'
    );
    t.ok(
      manifest['mp-weixin'].permission &&
        manifest['mp-weixin'].permission['scope.userLocation'],
      '声明了 scope.userLocation（安卓扫蓝牙需要定位权限）'
    );

    // 这条是踩坑才加的：微信规定 scope.userLocation 的 desc 不能超过 30 个字，
    // 超了真机调试/预览会在上传阶段直接失败，报错误码 80058：
    //   "desc(...) of scope.userLocation exceeds 30, word count: 33"
    // 而且这个错误是在「上传」时抛的，看起来像网络问题，很有迷惑性。
    const desc =
      (manifest['mp-weixin'].permission &&
        manifest['mp-weixin'].permission['scope.userLocation'] &&
        manifest['mp-weixin'].permission['scope.userLocation'].desc) ||
      '';
    const descLen = Array.from(desc).length; // 按码点算，和微信的 word count 一致
    t.ok(
      descLen > 0 && descLen <= 30,
      'scope.userLocation.desc 是 ' + descLen + ' 个字（微信要求 >0 且 ≤30，超了报 80058）'
    );

    // 模板和真配置必须一致：只改一个的话，别人 clone 出来还是旧的超长文案
    if (exists('src/manifest.example.json')) {
      const example = JSON.parse(stripComments(read('src/manifest.example.json')));
      const exampleDesc =
        (example['mp-weixin'].permission &&
          example['mp-weixin'].permission['scope.userLocation'] &&
          example['mp-weixin'].permission['scope.userLocation'].desc) ||
        '';
      t.equal(
        exampleDesc,
        desc,
        'manifest.example.json 的 desc 与 manifest.json 一致'
      );
    }
  }

  /* ============================================ 相对 import 必须带 .ts 后缀 */
  t.suite('相对 import 一律带 .ts 后缀（Node 直接跑测试的前提）');

  const IMPORT_RE = /(?:from\s+|require\(\s*)['"](\.[^'"]+)['"]/g;

  const tsFiles = walk('.ts');
  const vueFiles = walk('.vue');
  t.ok(tsFiles.length > 10, '扫到 ' + tsFiles.length + ' 个 .ts 文件');
  t.equal(vueFiles.length, 6, '扫到 6 个 .vue 文件（App.vue + 5 个页面）');

  tsFiles.concat(vueFiles).forEach(function (rel) {
    const src = read('src/' + rel);
    const dir = path.posix.dirname(rel);
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const spec = m[1];
      // .ts 是为了 Node 能直接跑源码；.vue 是 Vue 单文件组件的正常写法
      t.ok(
        /\.(ts|vue)$/.test(spec),
        'src/' + rel + ' 的 import "' + spec + '" 带显式后缀'
      );

      const joined = path.posix.normalize(path.posix.join(dir, spec));
      t.ok(exists('src/' + joined), 'src/' + rel + ' 的 import "' + spec + '" 能解析');
    }
  });

  /* ======================================= 纯逻辑模块不能碰平台 API */
  t.suite('平台 API 只允许出现在 adapters/ 里');

  // 这些文件是协议与编排的核心，必须保持平台无关：
  // 既为了能在 Node 里单测，也为了以后出 App 端时业务代码一行不用改。
  [
    'ble/protocol.ts',
    'ble/errors.ts',
    'ble/types.ts',
    'ble/client.ts',
    'ble/adapter.ts',
    'config.ts',
    'data/regions.ts',
    'utils/regions.ts'
  ].forEach(function (rel) {
    const hit = findPlatformCall(read('src/' + rel));
    t.ok(hit === null, 'src/' + rel + ' 里没有平台调用' + (hit ? ' → ' + hit : ''));
  });

  // 反过来：存储层确实要用 uni 的存储接口，这是设计上允许的，
  // 但必须做 typeof 判空，否则 Node 里 require 就炸
  t.ok(
    read('src/utils/storage.ts').indexOf('typeof uni') >= 0,
    'src/utils/storage.ts 用了 uni 存储接口，但做了 typeof 判空（Node 里不会炸）'
  );

  /* ==================================================== 省市区数据 */
  t.suite('省市区数据文件');

  t.ok(exists('src/data/regions.ts'), 'src/data/regions.ts 存在');

  let regionData = null;
  t.doesNotThrow(function () {
    regionData = require('../src/data/regions.ts').regions;
  }, 'src/data/regions.ts 可以被 require');

  t.ok(regionData && Array.isArray(regionData.provinces), '导出了 provinces 数组');
  t.ok(!!(regionData && regionData.version), '带版本号 ' + (regionData && regionData.version));
  t.equal(regionData.provinces.length, 34, '34 个省级单位');

  const bytes = fs.statSync(path.join(SRC, 'data', 'regions.ts')).size;
  t.ok(bytes < 300 * 1024, '数据文件 ' + (bytes / 1024).toFixed(1) + 'KB，远小于主包 2MB 限制');

  /* ==================================================== 工程配置 */
  t.suite('工程配置');

  let pkg = null;
  t.doesNotThrow(function () {
    pkg = JSON.parse(read('package.json'));
  }, 'package.json 是合法 JSON');

  ['dev:mp-weixin', 'build:mp-weixin', 'type-check', 'test', 'build:regions', 'verify'].forEach(
    function (name) {
      t.ok(pkg.scripts && pkg.scripts[name], 'scripts.' + name + ' 存在');
    }
  );

  t.ok(
    pkg.dependencies && pkg.dependencies['@dcloudio/uni-mp-weixin'],
    '依赖里有 @dcloudio/uni-mp-weixin'
  );
  t.ok(!pkg.dependencies['@dcloudio/uni-h5'], '没有装用不上的平台依赖（默认只出微信小程序）');

  const tsconfig = JSON.parse(stripComments(read('tsconfig.json')));
  t.equal(
    tsconfig.compilerOptions.allowImportingTsExtensions,
    true,
    'tsconfig 允许 import 带 .ts 后缀'
  );
  t.equal(tsconfig.compilerOptions.noUnusedLocals, true, 'tsconfig 开启了 noUnusedLocals（拦死代码）');

  t.ok(
    read('vite.config.ts').indexOf('CHOKIDAR_USEPOLLING') >= 0,
    'vite.config.ts 里处理了网盘不支持 fs.watch 的问题'
  );

  /* ==================================================== 文档 */
  t.suite('交付文档完整');

  t.ok(exists('README.md'), 'README.md 存在');
  t.ok(exists('docs/device-integration.md'), 'docs/device-integration.md（设备侧接入指南）存在');

  if (exists('docs/device-integration.md')) {
    const guide = read('docs/device-integration.md');
    ['city', 'district', '转义', '分包', 'MTU', 'CCCD', 'deviceTextMaxBytes', 'App 端'].forEach(
      function (kw) {
        t.ok(guide.indexOf(kw) >= 0, '移植文档覆盖了关键点：' + kw);
      }
    );
  }

  if (exists('README.md')) {
    const readme = read('README.md');
    // dist/mp-weixin 是固定的产物目录（脚本里用 UNI_OUTPUT_DIR 钉住的），
    // 文档必须和它一致，否则用户会照着文档去导一个不存在的目录
    ['dist/mp-weixin', 'npm install', 'npm run', 'uni-app'].forEach(function (kw) {
      t.ok(readme.indexOf(kw) >= 0, 'README 覆盖了关键点：' + kw);
    });
    t.ok(
      readme.indexOf('dist/build/mp-weixin') < 0 && readme.indexOf('dist/dev/mp-weixin') < 0,
      'README 里没有旧的产物路径（dist/build、dist/dev）'
    );
  }

  // 产物目录钉住 + 网络盘轮询必须写在 cross-env（进程启动前）。
  // 轮询写在 vite.config.ts 里对 watch 模式太晚 —— 这是实测踩过的坑，用断言锁住，
  // 免得以后有人「顺手清理」掉这两个环境变量。
  ['dev:mp-weixin', 'build:mp-weixin'].forEach(function (name) {
    const cmd = pkg.scripts[name] || '';
    t.ok(
      cmd.indexOf('UNI_OUTPUT_DIR=dist/mp-weixin') >= 0,
      'scripts.' + name + ' 钉住了输出目录 dist/mp-weixin'
    );
    t.ok(
      cmd.indexOf('CHOKIDAR_USEPOLLING=1') >= 0,
      'scripts.' + name + ' 在进程启动前打开了 chokidar 轮询（网络盘必需）'
    );
  });

  /* ============================== 文档里不能出现本机绝对路径 */
  t.suite('文档里没有本机绝对路径（换台机器就失效）');

  // 这条是应明确要求加的：文档里只允许 BLE-Provisioning 的相对路径，
  // 不许出现盘符路径、UNC 网络路径，也不许把旧目录名当路径用。
  [
    { label: 'Windows 盘符路径（如 T:\\...）', re: /[A-Za-z]:\\/ },
    { label: 'UNC 网络路径（\\\\server\\share）', re: /\\\\[A-Za-z0-9._-]+\\/ },
    { label: '旧的工程目录名当路径用', re: /tools\/ble_config/ },
    { label: '指向工程外部的相对路径', re: /\.\.\/\.\.\// }
  ].forEach(function (check) {
    ['README.md', 'docs/device-integration.md'].forEach(function (rel) {
      const hit = read(rel).match(check.re);
      t.ok(!hit, rel + ' 里没有 ' + check.label + (hit ? ' → 命中: ' + hit[0] : ''));
    });
  });

  /* ============================== 文档里不能出现工程私有的东西 */
  t.suite('文档是通用的，不含私有信息');

  // 这个小程序是**通用工具**：换设备只改 src/config.ts。
  // 文档里一旦出现具体芯片型号、外部工程路径、某个 SDK 的文件名，
  // 它看起来就变成「给某某定制的」了 —— 这类信息一律不许进文档。
  [
    'CST85F11',
    'cst85f11',
    'cs_idk',
    'wifi_provisioning_over_ble',
    'ble_cfg_utils',
    'weather_service',
    'display_controller',
    'porting-guide'
  ].forEach(function (word) {
    ['README.md', 'docs/device-integration.md'].forEach(function (rel) {
      t.ok(read(rel).indexOf(word) < 0, rel + ' 里没有私有信息「' + word + '」');
    });
  });
};
