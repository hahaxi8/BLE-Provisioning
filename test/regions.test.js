/**
 * 省-市-区数据测试
 * ---------------------------------------------------------------------------
 * 数据是外部来的（脚本生成），最怕的是：某一级出现空数组、直辖市没合并、
 * 索引越界导致选择器空白。这里把这些都钉死。
 *
 * 跑法： node test/run.js
 */

const t = require('./tiny-test');
const regions = require('../src/utils/regions.ts');
const raw = require('../src/data/regions.ts').regions;

module.exports = function () {
  t.suite('省-市-区数据完整性');

  t.ok(!!raw.version, '数据文件带版本号: ' + raw.version);
  t.ok(raw.source.indexOf('Administrative-divisions-of-China') >= 0, '数据来源可追溯');
  t.equal(raw.provinces.length, 34, '34 个省级单位（31 省市区 + 港澳台）');

  let cityCount = 0;
  let districtCount = 0;
  const problems = [];

  raw.provinces.forEach(function (p) {
    if (!p.name) {
      problems.push('存在没有名字的省级条目');
    }
    if (!p.cities || !p.cities.length) {
      problems.push(p.name + ' 下面没有市级数据');
      return;
    }
    p.cities.forEach(function (c) {
      cityCount++;
      if (!c.name) {
        problems.push(p.name + ' 下面存在没有名字的市');
      }
      if (!c.districts || !c.districts.length) {
        problems.push(p.name + '/' + c.name + ' 下面没有区级数据');
      }
    });
  });

  raw.provinces.forEach(function (p) {
    p.cities.forEach(function (c) {
      districtCount += c.districts.length;
    });
  });

  t.equal(problems.length, 0, '没有空层级或空名字' + (problems.length ? ': ' + problems.slice(0, 5).join('; ') : ''));
  t.ok(cityCount > 330, '市级数量合理（实际 ' + cityCount + '）');
  t.ok(districtCount > 2800, '区级数量合理（实际 ' + districtCount + '）');

  t.suite('直辖市规范化（源数据里是伪市级键「市辖区」「县」）');

  ['北京市', '天津市', '上海市', '重庆市'].forEach(function (name) {
    const p = raw.provinces.filter(function (x) {
      return x.name === name;
    })[0];
    t.ok(!!p, '存在 ' + name);
    if (!p) {
      return;
    }
    t.equal(p.cities.length, 1, name + ' 合并成一个市');
    t.equal(p.cities[0].name, name, name + ' 的市名与省名一致（不是「市辖区」）');
    t.ok(
      p.cities[0].districts.every(function (d) {
        return ['市辖区', '县'].indexOf(d) < 0;
      }),
      name + ' 的区列表里没有「市辖区」「县」这种残留'
    );
  });

  t.equal(raw.provinces.filter(function (p) { return p.name === '重庆市'; })[0].cities[0].districts.length, 38,
    '重庆市的 26 个区 + 12 个县已合并为 38 条');

  t.suite('伪市级键「省直辖县级行政区划」的处理');

  const hubei = raw.provinces.filter(function (p) { return p.name === '湖北省'; })[0];
  const hubeiCityNames = hubei.cities.map(function (c) { return c.name; });
  t.ok(
    hubeiCityNames.every(function (n) { return n.indexOf('直辖县级行政区划') < 0; }),
    '不再出现「省直辖县级行政区划」这种行政术语（界面会很难看）'
  );
  t.ok(hubeiCityNames.indexOf('湖北') >= 0, '改用省简称「湖北」占位');
  t.ok(hubeiCityNames.indexOf('武汉市') >= 0, '正常城市不受影响');

  t.suite('港澳台');

  const names = raw.provinces.map(function (p) { return p.name; });
  t.ok(names.indexOf('香港特别行政区') >= 0, '含香港特别行政区');
  t.ok(names.indexOf('澳门特别行政区') >= 0, '含澳门特别行政区');
  t.ok(names.indexOf('台湾省') >= 0, '含台湾省');

  t.suite('选择器取值与索引夹紧');

  t.equal(regions.getProvinceNames().length, 34, 'getProvinceNames 返回 34 项');
  t.equal(regions.getCityNames(0).length, 1, '第 0 项（北京市）只有 1 个市');
  t.equal(regions.getDistrictNames(0, 0).length, 16, '北京市有 16 个区');
  t.deepEqual(regions.getCityNames(999), [], '省索引越界返回空数组而不是崩');
  t.deepEqual(regions.getDistrictNames(0, 999), [], '市索引越界返回空数组');

  const clamped = regions.clampIndexes(999, 999, 999);
  t.equal(clamped.provinceIndex, 33, '省索引夹紧到最大值');
  t.ok(
    clamped.cityIndex >= 0 && clamped.cityIndex < regions.getCityNames(33).length,
    '市索引夹紧到该省的有效范围'
  );

  const switched = regions.clampIndexes(0, 5, 5);
  t.equal(switched.cityIndex, 0, '从多市的省切到只有 1 个市的直辖市时，市索引自动归零');

  t.suite('按名字反查（用于回填上次选择）');

  const found = regions.findByNames('深圳市', '南山区');
  t.ok(found.found, '能反查到「深圳市 / 南山区」');
  const picked = regions.getByIndex(found.provinceIndex, found.cityIndex, found.districtIndex);
  t.equal(picked.city, '深圳市', '反查后取回的市名一致');
  t.equal(picked.district, '南山区', '反查后取回的区名一致');
  t.equal(picked.province, '广东省', '反查后省也对得上');

  const beijing = regions.findByNames('北京市', '朝阳区');
  t.ok(beijing.found, '直辖市也能反查');
  t.equal(regions.getByIndex(beijing.provinceIndex, beijing.cityIndex, beijing.districtIndex).district, '朝阳区', '直辖市区名正确');

  t.ok(!regions.findByNames('不存在的市', '').found, '查不到时 found=false，不抛异常');
  t.deepEqual(regions.findByNames('', ''), { provinceIndex: 0, cityIndex: 0, districtIndex: 0, found: false }, '空输入返回全 0');

  t.suite('关键字搜索');

  const nanhan = regions.search('南山');
  t.ok(nanhan.length > 0, '搜「南山」有结果');
  t.ok(
    nanhan.some(function (x) { return x.city === '深圳市' && x.district === '南山区'; }),
    '结果里包含 深圳市/南山区'
  );
  t.ok(regions.search('深圳').length > 0, '搜市名「深圳」能列出一批区');
  t.deepEqual(regions.search(''), [], '空关键字返回空');
  t.ok(regions.search('某个绝对不存在的区名').length === 0, '搜不到时返回空数组');
  t.ok(regions.search('区').length <= 40, '搜索结果有上限，不会一次渲染几千条');
};
