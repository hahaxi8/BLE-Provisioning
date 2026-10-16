#!/usr/bin/env node
/**
 * 生成小程序内置的省-市-区数据文件 src/data/regions.ts
 * ===========================================================================
 * 为什么要有这个脚本：
 *   省市区数据是“外部数据”，不能手抄，也不能靠记忆。手抄一定出错，而且民政部
 *   每年都会调整区划（撤县设区、新设开发区），所以做成可复现的脚本，将来更新
 *   只要重新跑一次即可。
 *
 * 数据来源（民政部口径，业内通用）：
 *   https://github.com/modood/Administrative-divisions-of-China
 *     dist/pca.json       省 → 市 → 区（不含港澳台）
 *     dist/HK-MO-TW.json  香港 / 澳门 / 台湾
 *
 * 用法：
 *   # 方式一：脚本自己联网下载
 *   node scripts/build-regions.js
 *
 *   # 方式二：用本地已下载的文件（内网环境用这个）
 *   node scripts/build-regions.js --pca ./pca.json --hkm ./HK-MO-TW.json
 *
 *   # 输出默认写到 ../src/data/regions.ts（相对脚本自身），可用 --out 指定
 *
 * 数据做了三处规范化，都是为了让“设备只显示 城市 + 区级”这件事不出洋相：
 *   1. 直辖市（北京/天津/上海/重庆）在源数据里市级键是伪名「市辖区」「县」，
 *      这里合并成一个与省同名的市，例如 重庆市 → 市「重庆市」+ 38 个区县。
 *   2. 「省直辖县级行政区划」「自治区直辖县级行政区划」这类伪市级键，
 *      改成省的简称（湖北省 → 「湖北」），否则屏幕上会显示一串行政术语。
 *   3. 名称原样保留，不做「市/区」后缀裁剪 —— 裁剪由设备侧自己做
 *      （按约定，设备侧显示城市时会自己剥掉末尾的「市」）。
 */

const fs = require('fs');
const path = require('path');

const PCA_URL =
  'https://raw.githubusercontent.com/modood/Administrative-divisions-of-China/master/dist/pca.json';
const HKM_URL =
  'https://raw.githubusercontent.com/modood/Administrative-divisions-of-China/master/dist/HK-MO-TW.json';

/** 直辖市：市级只有一个伪键 */
const MUNICIPALITIES = ['北京市', '天津市', '上海市', '重庆市'];

/** 伪市级键：不是真正的城市，是「省直接管县」的占位符 */
const PSEUDO_CITY = /^(省|自治区)直辖县级行政区划$/;

/** 解析命令行参数 */
function parseArgs(argv) {
  const out = { pca: '', hkm: '', out: '' };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--pca' && next) {
      out.pca = next;
      i++;
    } else if (key === '--hkm' && next) {
      out.hkm = next;
      i++;
    } else if (key === '--out' && next) {
      out.out = next;
      i++;
    } else if (key === '--help' || key === '-h') {
      console.log(
        [
          '用法: node scripts/build-regions.js [选项]',
          '  --pca <file>  本地 pca.json 路径（不给则联网下载）',
          '  --hkm <file>  本地 HK-MO-TW.json 路径（不给则联网下载）',
          '  --out <file>  输出路径，默认 src/data/regions.ts',
          '  --help        显示本帮助'
        ].join('\n')
      );
      process.exit(0);
    }
  }
  return out;
}

/** 读取 JSON：优先本地文件，否则联网下载 */
async function loadJson(localPath, url, label) {
  if (localPath) {
    const text = fs.readFileSync(localPath, 'utf8');
    console.log('[INFO] 读取本地 ' + label + ': ' + localPath);
    return JSON.parse(text);
  }

  if (typeof fetch !== 'function') {
    throw new Error(
      '当前 Node 版本没有全局 fetch（需要 Node 18+）。请手动下载 ' +
        url +
        ' 后用 --pca/--hkm 传入。'
    );
  }

  console.log('[INFO] 下载 ' + label + ': ' + url);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('下载 ' + label + ' 失败: HTTP ' + res.status);
  }
  return res.json();
}

/**
 * 省的简称：去掉行政区划后缀。
 * 只在处理伪市级键时用，例如 湖北省 → 湖北。
 */
function provinceShortName(name) {
  const suffixes = ['特别行政区', '维吾尔自治区', '壮族自治区', '回族自治区', '自治区', '省', '市'];
  for (let i = 0; i < suffixes.length; i++) {
    const s = suffixes[i];
    if (name.length > s.length && name.slice(-s.length) === s) {
      return name.slice(0, name.length - s.length);
    }
  }
  return name;
}

/** 去重，保持原顺序 */
function uniq(list) {
  const seen = {};
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (!seen[v]) {
      seen[v] = true;
      out.push(v);
    }
  }
  return out;
}

/** 把一个省（{市: [区...]}）规范化成 { name, cities: [{name, districts}] } */
function normalizeProvince(provinceName, cityMap) {
  const cityNames = Object.keys(cityMap);
  const cities = [];

  if (MUNICIPALITIES.indexOf(provinceName) >= 0) {
    // 直辖市：把「市辖区」「县」等伪市合并到与省同名的市
    let districts = [];
    cityNames.forEach(function (cn) {
      districts = districts.concat(cityMap[cn] || []);
    });
    cities.push({ name: provinceName, districts: uniq(districts) });
    return { name: provinceName, cities: cities };
  }

  const short = provinceShortName(provinceName);
  cityNames.forEach(function (cn) {
    const districts = uniq(cityMap[cn] || []);
    // 「省直辖县级行政区划」→ 用省简称，避免屏幕上出现行政术语
    const displayName = PSEUDO_CITY.test(cn) ? short : cn;
    cities.push({ name: displayName, districts: districts });
  });

  return { name: provinceName, cities: cities };
}

/** 生成 src/data/regions.ts 的源码文本 */
function serialize(provinces, meta) {
  const lines = [];

  lines.push('/**');
  lines.push(' * 全国省-市-区数据（仅名称，不含行政区划编码）');
  lines.push(' * ===========================================================================');
  lines.push(' * 本文件由 scripts/build-regions.js 自动生成，请不要手工修改 ——');
  lines.push(' * 手工改了下次重跑就被覆盖，而且区划调整你也改不全。');
  lines.push(' *');
  lines.push(' * 数据来源：' + meta.source);
  lines.push(' * 数据版本：' + meta.version);
  lines.push(' * 统计：' + meta.provinceCount + ' 个省级 / ' + meta.cityCount + ' 个市级 / ' +
    meta.districtCount + ' 个区级');
  lines.push(' *');
  lines.push(' * 结构：provinces[].cities[].districts[]');
  lines.push(' * 直辖市（北京/天津/上海/重庆）已把「市辖区/县」合并成一个与省同名的市，');
  lines.push(' * 所以三级选择器在直辖市下第二列只有一项，属正常现象。');
  lines.push(' *');
  lines.push(' * 注意：部分名称很长（最长区名「内蒙古阿拉善高新技术产业开发区」= 45 字节），');
  lines.push(' * 超过了设备侧 char district_zh[24] 的容量，下发前会做长度校验与截断，');
lines.push(' * 详见 docs/device-integration.md。');
  lines.push(' */');
  lines.push('');
  lines.push('export interface RegionCity {');
  lines.push('  name: string;');
  lines.push('  districts: string[];');
  lines.push('}');
  lines.push('');
  lines.push('export interface RegionProvince {');
  lines.push('  name: string;');
  lines.push('  cities: RegionCity[];');
  lines.push('}');
  lines.push('');
  lines.push('export interface RegionData {');
  lines.push('  version: string;');
  lines.push('  source: string;');
  lines.push('  provinces: RegionProvince[];');
  lines.push('}');
  lines.push('');
  lines.push('export const regions: RegionData = {');
  lines.push('  version: ' + JSON.stringify(meta.version) + ',');
  lines.push('  source: ' + JSON.stringify(meta.source) + ',');
  lines.push('  provinces: [');

  for (let i = 0; i < provinces.length; i++) {
    const p = provinces[i];
    lines.push('    {');
    lines.push('      name: ' + JSON.stringify(p.name) + ',');
    lines.push('      cities: [');

    for (let j = 0; j < p.cities.length; j++) {
      const c = p.cities[j];
      lines.push(
        '        { name: ' + JSON.stringify(c.name) + ', districts: ' +
          JSON.stringify(c.districts) + ' }' + (j === p.cities.length - 1 ? '' : ',')
      );
    }

    lines.push('      ]');
    lines.push('    }' + (i === provinces.length - 1 ? '' : ','));
  }

  lines.push('  ]');
  lines.push('};');
  lines.push('');
  lines.push('export default regions;');
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);

  const pca = await loadJson(args.pca, PCA_URL, 'pca.json');
  const hkm = await loadJson(args.hkm, HKM_URL, 'HK-MO-TW.json');

  const provinces = [];

  Object.keys(pca).forEach(function (name) {
    provinces.push(normalizeProvince(name, pca[name]));
  });
  Object.keys(hkm).forEach(function (name) {
    provinces.push(normalizeProvince(name, hkm[name]));
  });

  // 统计 + 自检
  let cityCount = 0;
  let districtCount = 0;
  let longestCity = { name: '', bytes: 0 };
  let longestDistrict = { name: '', bytes: 0 };
  const problems = [];

  provinces.forEach(function (p) {
    if (!p.cities.length) {
      problems.push('省级「' + p.name + '」下面没有任何市');
    }
    p.cities.forEach(function (c) {
      cityCount++;
      if (!c.districts.length) {
        problems.push('市级「' + p.name + '/' + c.name + '」下面没有任何区');
      }
      const cb = Buffer.byteLength(c.name, 'utf8');
      if (cb > longestCity.bytes) {
        longestCity = { name: p.name + '/' + c.name, bytes: cb };
      }
      c.districts.forEach(function (d) {
        districtCount++;
        const db = Buffer.byteLength(d, 'utf8');
        if (db > longestDistrict.bytes) {
          longestDistrict = { name: p.name + '/' + c.name + '/' + d, bytes: db };
        }
      });
    });
  });

  if (problems.length) {
    console.error('[ERROR] 数据自检未通过：');
    problems.slice(0, 20).forEach(function (m) {
      console.error('  - ' + m);
    });
    process.exit(1);
  }

  const now = new Date();
  const meta = {
    source: 'modood/Administrative-divisions-of-China (dist/pca.json + dist/HK-MO-TW.json)',
    version:
      now.getUTCFullYear() + '.' + String(now.getUTCMonth() + 1).padStart(2, '0'),
    provinceCount: provinces.length,
    cityCount: cityCount,
    districtCount: districtCount
  };

  const text = serialize(provinces, meta);
  const outPath = args.out
    ? path.resolve(args.out)
    : path.resolve(__dirname, '..', 'src', 'data', 'regions.ts');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // 明确写成 UTF-8 无 BOM，否则微信开发者工具里中文会变乱码
  fs.writeFileSync(outPath, text, { encoding: 'utf8' });

  const bytes = Buffer.byteLength(text, 'utf8');
  console.log('[INFO] 省级 ' + meta.provinceCount + ' / 市级 ' + meta.cityCount +
    ' / 区级 ' + meta.districtCount);
  console.log('[INFO] 最长市名 ' + longestCity.name + ' = ' + longestCity.bytes + ' 字节');
  console.log('[INFO] 最长区名 ' + longestDistrict.name + ' = ' + longestDistrict.bytes + ' 字节');
  console.log('[INFO] 输出 ' + outPath + ' (' + bytes + ' 字节, ' + (bytes / 1024).toFixed(1) + ' KB)');

  if (bytes > 300 * 1024) {
    console.warn('[WARN] 数据文件超过 300KB，请确认小程序主包 2MB 限制是否还够用');
  }
}

main().catch(function (err) {
  console.error('[ERROR] ' + err.message);
  process.exit(1);
});
