/**
 * 省-市-区数据访问层
 * ---------------------------------------------------------------------------
 * 真正的数据在 src/data/regions.ts（65KB，由 scripts/build-regions.js 生成）。
 *
 * 这里把「省/市/区三个平行数组的取值、按名字反查、关键字搜索」都收口在一起，
 * 页面里不直接碰数据结构，将来换数据源只改这个文件。
 *
 * 关于懒加载：Vite 会把静态 import 的 65KB 打进主包（小程序主包上限 2MB，
 * 完全够用）。uni-app 编译到小程序端时动态 import() 支持并不一致，所以这里
 * 刻意用静态 import，换来的是行为可预期。
 */

import { regions as rawRegions } from '../data/regions.ts';
import type { RegionData } from '../data/regions.ts';

/** 一条完整的地址 */
export interface RegionPick {
  province: string;
  city: string;
  district: string;
}

/** 选择器索引 */
export interface RegionIndexes {
  provinceIndex: number;
  cityIndex: number;
  districtIndex: number;
}

/** 元信息：版本、来源、条目数 */
export function getMeta(): { version: string; source: string; provinceCount: number } {
  return {
    version: rawRegions.version,
    source: rawRegions.source,
    provinceCount: rawRegions.provinces.length
  };
}

/** 整个数据集（只读用途，例如自检） */
export function getRaw(): RegionData {
  return rawRegions;
}

/** 所有省级名称，用作 picker 第一列 */
export function getProvinceNames(): string[] {
  return rawRegions.provinces.map((p) => p.name);
}

/** 指定省下面的市级名称，用作 picker 第二列 */
export function getCityNames(provinceIndex: number): string[] {
  const p = rawRegions.provinces[provinceIndex];
  return p ? p.cities.map((c) => c.name) : [];
}

/** 指定省 + 市下面的区级名称，用作 picker 第三列 */
export function getDistrictNames(provinceIndex: number, cityIndex: number): string[] {
  const p = rawRegions.provinces[provinceIndex];
  if (!p) {
    return [];
  }
  const c = p.cities[cityIndex];
  return c ? c.districts : [];
}

/** 按索引取出完整的一条地址；任何一级越界都返回空串 */
export function getByIndex(
  provinceIndex: number,
  cityIndex: number,
  districtIndex: number
): RegionPick {
  const provinces = rawRegions.provinces;
  const p = provinces[provinceIndex];
  if (!p) {
    return { province: '', city: '', district: '' };
  }
  const c = p.cities[cityIndex];
  if (!c) {
    return { province: p.name, city: '', district: '' };
  }
  return { province: p.name, city: c.name, district: c.districts[districtIndex] || '' };
}

/**
 * 把三个索引修正到合法范围。
 * 用户切换省或市时，原来的市/区索引会越界，必须夹紧，否则 picker 会显示空白。
 */
export function clampIndexes(
  provinceIndex: number,
  cityIndex: number,
  districtIndex: number
): RegionIndexes {
  const provinces = rawRegions.provinces;
  const pi = Math.min(Math.max(Math.floor(provinceIndex) || 0, 0), provinces.length - 1);
  const cityCount = provinces[pi] ? provinces[pi].cities.length : 0;
  const ci = Math.min(Math.max(Math.floor(cityIndex) || 0, 0), Math.max(cityCount - 1, 0));
  const districtCount =
    provinces[pi] && provinces[pi].cities[ci] ? provinces[pi].cities[ci].districts.length : 0;
  const di = Math.min(Math.max(Math.floor(districtIndex) || 0, 0), Math.max(districtCount - 1, 0));
  return { provinceIndex: pi, cityIndex: ci, districtIndex: di };
}

/**
 * 按名字反查一条地址。
 *
 * 用途：把上次配网记录里存的城市/区名还原成 picker 的索引，
 * 这样用户第二次配网时选择器直接停在上次的位置，不用再从头翻。
 */
export function findByNames(
  cityName: string | null | undefined,
  districtName?: string | null
): RegionIndexes & { found: boolean } {
  const provinces = rawRegions.provinces;
  const wantCity = String(cityName === null || cityName === undefined ? '' : cityName).trim();
  const wantDistrict = String(
    districtName === null || districtName === undefined ? '' : districtName
  ).trim();

  if (!wantCity) {
    return { provinceIndex: 0, cityIndex: 0, districtIndex: 0, found: false };
  }

  for (let pi = 0; pi < provinces.length; pi++) {
    const cities = provinces[pi].cities;
    for (let ci = 0; ci < cities.length; ci++) {
      if (cities[ci].name !== wantCity) {
        continue;
      }
      let di = 0;
      if (wantDistrict) {
        const idx = cities[ci].districts.indexOf(wantDistrict);
        if (idx >= 0) {
          di = idx;
        }
      }
      return { provinceIndex: pi, cityIndex: ci, districtIndex: di, found: true };
    }
  }

  return { provinceIndex: 0, cityIndex: 0, districtIndex: 0, found: false };
}

/** 搜索结果条目 */
export interface RegionSearchHit extends RegionPick {
  /** 展示文案：市 · 区 */
  text: string;
}

/**
 * 关键字搜索（城市名或区名包含关键字）。
 *
 * 3400 条数据全量扫一遍在手机上大约几毫秒，用户每输一个字就搜一次完全够用，
 * 不需要建索引。结果按「区名越短越常见」排序。
 */
export function search(keyword: string | null | undefined, limit = 40): RegionSearchHit[] {
  const kw = String(keyword === null || keyword === undefined ? '' : keyword).trim();
  if (!kw) {
    return [];
  }

  const provinces = rawRegions.provinces;
  const hits: RegionSearchHit[] = [];
  const cap = limit * 4;

  for (const p of provinces) {
    for (const c of p.cities) {
      // 命中市名：把这个市下面前若干个区作为候选列出来
      if (c.name.indexOf(kw) >= 0) {
        for (const d of c.districts) {
          hits.push({ province: p.name, city: c.name, district: d, text: c.name + ' · ' + d });
          if (hits.length >= cap) {
            break;
          }
        }
      }

      for (const d of c.districts) {
        if (d.indexOf(kw) >= 0) {
          hits.push({ province: p.name, city: c.name, district: d, text: c.name + ' · ' + d });
        }
        if (hits.length >= cap) {
          break;
        }
      }
      if (hits.length >= cap) {
        break;
      }
    }
    if (hits.length >= cap) {
      break;
    }
  }

  hits.sort((a, b) => a.district.length - b.district.length);
  return hits.slice(0, limit);
}
