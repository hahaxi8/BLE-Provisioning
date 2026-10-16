<template>
  <view class="page">
    <!-- 搜索 -->
    <view class="search-box">
      <view class="search-icon" />
      <input
        class="search-input"
        :value="keyword"
        placeholder="搜索城市或区县，如「南山」「深圳」"
        confirm-type="search"
        @input="onKeywordInput"
      />
      <text class="search-clear" v-if="keyword" @click="onClearKeyword">✕</text>
    </view>

    <!-- 搜索结果 -->
    <template v-if="searching">
      <view class="card card-tight" v-if="results.length">
        <view
          class="row"
          v-for="(item, i) in results"
          :key="item.text + i"
          @click="onPickResult(item.city, item.district)"
        >
          <view class="row-main">
            <view class="row-title">{{ item.district }}</view>
            <view class="row-sub">{{ item.province }} · {{ item.city }}</view>
          </view>
          <view class="row-extra">
            <text class="badge" v-if="item.tooLong">名称偏长</text>
            <view class="row-arrow" />
          </view>
        </view>
      </view>
      <view class="card empty-card" v-else>
        <view class="empty-title">没搜到</view>
        <view class="empty-desc">换个关键词试试，或者用下面的三级选择</view>
      </view>
    </template>

    <!-- 三级选择 -->
    <template v-else>
      <view class="section-title">也可以逐级选择</view>
      <picker
        mode="multiSelector"
        :range="pickerRange"
        :value="idx"
        @change="onPickerChange"
        @columnchange="onColumnChange"
      >
        <view class="card card-tight">
          <view class="row">
            <view class="row-main">
              <view class="row-sub">省份</view>
              <view class="row-title">{{ current.province || '请选择' }}</view>
            </view>
          </view>
          <view class="row">
            <view class="row-main">
              <view class="row-sub">城市</view>
              <view class="row-title">{{ current.city || '请选择' }}</view>
            </view>
          </view>
          <view class="row">
            <view class="row-main">
              <view class="row-sub">区县</view>
              <view class="row-title">{{ current.district || '请选择' }}</view>
            </view>
            <view class="row-extra">
              <view class="row-arrow" />
            </view>
          </view>
        </view>
      </picker>
      <view class="picker-tip">点上面的卡片唤出选择器，三列分别对应省 / 市 / 区</view>

      <view class="notice notice-warn" v-if="tooLong">
        <view class="notice-body">
          这个名称超过了设备能存下的长度（{{ limit }} 字节），下发时会被截断，设备屏幕上显示不全。不影响配网。
        </view>
      </view>

      <view class="current-box">
        <view class="current-label">已选择</view>
        <view class="current-value">{{ currentText }}</view>
      </view>

      <button class="btn btn-primary" @click="onConfirm">确定</button>
    </template>

    <view class="data-note" v-if="meta">
      行政区划数据版本 {{ meta.version }}，共 {{ meta.provinceCount }} 个省级单位
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * 选择位置页（省 → 市 → 区）
 * ---------------------------------------------------------------------------
 * 为什么要内置这份数据而不是用手机定位：
 *   用 uni.getLocation 需要申请位置接口权限（要类目审核），还要地图 key，
 *   室内定位还经常把区定错；IP 定位只能到市、拿不到区，而且要配 request 合法域名。
 *   内置省市区数据零依赖、离线可用、用户自己确认过，最不容易出错 ——
 *   代价只是主包里多 65KB。
 *
 * 交互设计：
 *   搜索框放最上面。用户心里想的是「南山区」，不是「广东省 → 深圳市 → 南山区」，
 *   直接搜三个字比滚三级选择器快得多。三级 picker 作为不知道确切名字时的兜底。
 */

import { ref, computed } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { config } from '../../config.ts';
import { validateDeviceText } from '../../ble/index.ts';
import { inputValue, pickerColumn, pickerIndexes } from '../../utils/uni-event.ts';
import * as regions from '../../utils/regions.ts';
import type { RegionPick } from '../../utils/regions.ts';
import { flow, updateProvision } from '../../store/flow.ts';

interface ResultRow extends regions.RegionSearchHit {
  tooLong: boolean;
}

const provinceNames = ref<string[]>([]);
const cityNames = ref<string[]>([]);
const districtNames = ref<string[]>([]);
const idx = ref<number[]>([0, 0, 0]);

const keyword = ref('');
const searching = ref(false);
const results = ref<ResultRow[]>([]);

const current = ref<RegionPick>({ province: '', city: '', district: '' });
const tooLong = ref(false);
const meta = ref<{ version: string; provinceCount: number } | null>(null);

const limit = config.ble.deviceTextMaxBytes;

const pickerRange = computed(() => [provinceNames.value, cityNames.value, districtNames.value]);

const currentText = computed(() =>
  current.value.city + (current.value.district ? ' · ' + current.value.district : '')
);

/** 把当前索引对应的地址同步到界面，并检查是否超长 */
function syncCurrent(pi: number, ci: number, di: number): void {
  const pick = regions.getByIndex(pi, ci, di);
  current.value = pick;
  tooLong.value =
    !validateDeviceText(pick.district, '区县', limit).ok ||
    !validateDeviceText(pick.city, '城市', limit).ok;
}

/** 某一列滚动时，重算它后面的列，并把索引夹回合法范围 */
function onColumnChange(e: Event): void {
  const { column, value } = pickerColumn(e);
  const next = idx.value.slice();
  next[column] = value;

  if (column === 0) {
    cityNames.value = regions.getCityNames(value);
    next[1] = 0;
    districtNames.value = regions.getDistrictNames(value, 0);
    next[2] = 0;
  } else if (column === 1) {
    districtNames.value = regions.getDistrictNames(next[0], value);
    next[2] = 0;
  }

  idx.value = next;
  syncCurrent(next[0], next[1], next[2]);
}

function onPickerChange(e: Event): void {
  const raw = pickerIndexes(e);
  const clamped = regions.clampIndexes(raw[0], raw[1], raw[2]);
  idx.value = [clamped.provinceIndex, clamped.cityIndex, clamped.districtIndex];
  syncCurrent(clamped.provinceIndex, clamped.cityIndex, clamped.districtIndex);
}

function onKeywordInput(e: Event): void {
  const kw = inputValue(e);
  keyword.value = kw;
  searching.value = !!kw;

  if (!kw) {
    results.value = [];
    return;
  }

  results.value = regions.search(kw, 30).map((h) => ({
    ...h,
    tooLong: !validateDeviceText(h.district, '区县', limit).ok
  }));
}

function onClearKeyword(): void {
  keyword.value = '';
  searching.value = false;
  results.value = [];
}

/** 搜索结果直接选用并返回 */
function onPickResult(city: string, district: string): void {
  const found = regions.findByNames(city, district);
  cityNames.value = regions.getCityNames(found.provinceIndex);
  districtNames.value = regions.getDistrictNames(found.provinceIndex, found.cityIndex);
  idx.value = [found.provinceIndex, found.cityIndex, found.districtIndex];
  syncCurrent(found.provinceIndex, found.cityIndex, found.districtIndex);
  apply(city, district);
}

function onConfirm(): void {
  if (!current.value.city) {
    uni.showToast({ title: '请选择城市', icon: 'none' });
    return;
  }
  apply(current.value.city, current.value.district);
}

/** 写回流程状态并返回上一页。超长的不在这里拦，交给密码页统一处理 */
function apply(city: string, district: string): void {
  updateProvision({ city, district: district || '' });
  uni.navigateBack();
}

onLoad(() => {
  provinceNames.value = regions.getProvinceNames();
  meta.value = regions.getMeta();

  // 回填：优先用本轮已选，其次用上次配网记录里的城市
  let start = { provinceIndex: 0, cityIndex: 0, districtIndex: 0 };
  const provision = flow.provision;
  if (provision && provision.city) {
    start = regions.findByNames(provision.city, provision.district);
  }

  cityNames.value = regions.getCityNames(start.provinceIndex);
  districtNames.value = regions.getDistrictNames(start.provinceIndex, start.cityIndex);
  idx.value = [start.provinceIndex, start.cityIndex, start.districtIndex];
  syncCurrent(start.provinceIndex, start.cityIndex, start.districtIndex);

  // 已经选过就直接显示，用户点「确定」即可
  if (provision && provision.city) {
    current.value = {
      province: current.value.province,
      city: provision.city,
      district: provision.district || current.value.district
    };
  }
});
</script>

<style scoped>
.search-box {
  display: flex;
  align-items: center;
  height: 88rpx;
  background: #ffffff;
  border-radius: 44rpx;
  padding: 0 28rpx;
  margin-bottom: 24rpx;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.03);
}

.search-icon {
  width: 24rpx;
  height: 24rpx;
  border: 4rpx solid #b6bcc4;
  border-radius: 50%;
  position: relative;
  flex-shrink: 0;
  margin-right: 18rpx;
}

.search-icon::after {
  content: '';
  position: absolute;
  right: -12rpx;
  bottom: -8rpx;
  width: 14rpx;
  height: 4rpx;
  background: #b6bcc4;
  border-radius: 2rpx;
  transform: rotate(45deg);
}

.search-input {
  flex: 1;
  height: 88rpx;
  font-size: 30rpx;
}

.search-clear {
  width: 44rpx;
  text-align: center;
  color: #b6bcc4;
  font-size: 28rpx;
  flex-shrink: 0;
}

.empty-card {
  text-align: center;
  padding: 80rpx 40rpx;
}

.picker-tip {
  font-size: 24rpx;
  color: #8a9099;
  padding: 0 8rpx 24rpx;
  line-height: 1.6;
}

.current-box {
  background: #ffffff;
  border-radius: 24rpx;
  padding: 28rpx 32rpx;
  margin-bottom: 32rpx;
}

.current-label {
  font-size: 24rpx;
  color: #8a9099;
  margin-bottom: 8rpx;
}

.current-value {
  font-size: 34rpx;
  font-weight: 500;
}

.data-note {
  text-align: center;
  font-size: 22rpx;
  color: #b6bcc4;
  padding: 40rpx 0 8rpx;
}
</style>
