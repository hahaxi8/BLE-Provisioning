<template>
  <view class="page">
    <!-- 已选信息回顾 -->
    <view class="card card-tight">
      <view class="row">
        <view class="row-main">
          <view class="row-sub">设备</view>
          <view class="row-title ellipsis">{{ deviceName || '未知设备' }}</view>
        </view>
      </view>
      <view class="row">
        <view class="row-main">
          <view class="row-sub">Wi-Fi 名称</view>
          <view class="row-title ellipsis">{{ ssid }}</view>
        </view>
        <view class="row-extra">
          <text class="badge" v-if="manualSsid">手动输入</text>
          <text class="badge badge-brand" v-else-if="fromHistory">来自记录</text>
        </view>
      </view>
    </view>

    <!-- 密码 -->
    <view class="card">
      <view class="field-label">Wi-Fi 密码</view>
      <view class="pwd-row">
        <input
          class="pwd-input"
          :value="pwd"
          :password="!showPwd"
          placeholder="请输入密码，开放网络可留空"
          :maxlength="63"
          confirm-type="done"
          @input="onPwdInput"
        />
        <text class="pwd-toggle" @click="showPwd = !showPwd">{{ showPwd ? '隐藏' : '显示' }}</text>
      </view>
      <view class="field-tip text-danger" v-if="pwdTip">{{ pwdTip }}</view>
      <view class="field-tip" v-else>注意区分大小写；密码不会保存在手机上</view>
    </view>

    <!-- 位置 -->
    <view class="card card-tight">
      <view class="row" @click="onOpenRegion">
        <view class="row-main">
          <view class="row-sub">设备所在城市</view>
          <view class="row-title">{{ locationText }}</view>
        </view>
        <view class="row-extra">
          <view class="row-arrow" v-if="city" />
          <text class="badge" v-else>必选</text>
        </view>
      </view>
    </view>
    <view class="location-tip">设备屏幕上会显示这个城市和区县的天气，所以必须选对。</view>

    <view class="flex-fill" />

    <view class="footer-bar">
      <button class="btn btn-primary" :class="{ disabled: submitting }" @click="onConfirm">
        开始配网
      </button>
      <view class="footer-note">下发过程不要离开小程序，也不要把手机拿远</view>
    </view>
  </view>
</template>

<script setup lang="ts">
/**
 * 密码页（同时是「位置」的入口）
 * ---------------------------------------------------------------------------
 * 这是下发前的最后一页，也是唯一做「发送前校验」的地方，校验规则都围绕
 * 设备侧的固定长度缓冲区来设计：
 *   - Wi-Fi 密码：WPA2 要求 8~63 个字符，少于 8 位路由器根本不接受，
 *     但用户可能确实用的是老设备的短密码，所以不是硬拦，而是让用户确认。
 *   - 城市/区级：设备侧 char[24]，只能用 23 字节。全国最长区名是 45 字节，
 *     直接拒绝会把这批用户彻底堵死，所以提供「按字节截断后下发」的选项。
 */

import { ref, computed } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { config } from '../../config.ts';
import { ble, truncateUtf8, validateDeviceText } from '../../ble/index.ts';
import { inputValue } from '../../utils/uni-event.ts';
import { flow, updateProvision } from '../../store/flow.ts';

const deviceName = ref('');
const ssid = ref('');
const manualSsid = ref(false);
const fromHistory = ref(false);

const pwd = ref('');
const showPwd = ref(false);
const pwdTip = ref('');

const submitting = ref(false);

const city = computed(() => (flow.provision && flow.provision.city) || '');
const district = computed(() => (flow.provision && flow.provision.district) || '');

const locationText = computed(() => {
  if (city.value && district.value) return city.value + ' · ' + district.value;
  return city.value || '请选择';
});

function onPwdInput(e: Event): void {
  pwd.value = inputValue(e);
  pwdTip.value = pwd.value && pwd.value.length < 8 ? '密码少于 8 位，大多数路由器不接受' : '';
}

function onOpenRegion(): void {
  uni.navigateTo({ url: '/pages/region/region' });
}

/** 下发前的最后一道关 */
function onConfirm(): void {
  if (submitting.value) return;

  if (!ble.isConnected()) {
    uni.showModal({
      title: '设备已断开',
      content: '和设备之间的连接断开了，需要重新连接一次。',
      showCancel: false,
      success: () => uni.navigateBack()
    });
    return;
  }

  if (!city.value) {
    uni.showToast({ title: '请选择设备所在城市', icon: 'none' });
    return;
  }

  // 密码长度异常时先让用户确认，不硬拦（老设备可能有短密码）
  if (pwd.value && pwd.value.length < 8) {
    uni.showModal({
      title: '密码不足 8 位',
      content: `密码只有 ${pwd.value.length} 位，大多数路由器不会接受。仍要发送吗？`,
      confirmText: '仍然发送',
      cancelText: '改一下',
      success: (res) => {
        if (res.confirm) checkDeviceTextAndSubmit();
      }
    });
    return;
  }

  checkDeviceTextAndSubmit();
}

/** 城市/区级超长时给「截断后下发」的选择，而不是把用户堵死 */
function checkDeviceTextAndSubmit(): void {
  const limit = config.ble.deviceTextMaxBytes;
  const cityCheck = validateDeviceText(city.value, '城市', limit);
  const districtCheck = validateDeviceText(district.value, '区县', limit);

  if (cityCheck.ok && districtCheck.ok) {
    submit(city.value, district.value);
    return;
  }

  const bad = !cityCheck.ok ? cityCheck : districtCheck;
  const badName = !cityCheck.ok ? city.value : district.value;

  if (bad.bytes === 0) {
    uni.showToast({ title: bad.message, icon: 'none' });
    return;
  }

  const cut = truncateUtf8(badName, limit);
  uni.showModal({
    title: '名称太长',
    content:
      `「${badName}」有 ${bad.bytes} 字节，设备最多存 ${limit} 字节。\n\n` +
      `将按「${cut.text}」截断后下发，设备屏幕上会显示不全，但配网可以正常完成。`,
    confirmText: '截断后下发',
    cancelText: '返回修改',
    success: (res) => {
      if (!res.confirm) return;
      const finalCity = cityCheck.ok ? city.value : cut.text;
      const finalDistrict = districtCheck.ok ? district.value : truncateUtf8(district.value, limit).text;
      submit(finalCity, finalDistrict);
    }
  });
}

function submit(finalCity: string, finalDistrict: string): void {
  updateProvision({
    ssid: ssid.value,
    pwd: pwd.value,
    city: finalCity,
    district: finalDistrict
  });
  submitting.value = true;
  uni.navigateTo({
    url: '/pages/result/result',
    complete: () => {
      submitting.value = false;
    }
  });
}

onShow(() => {
  const device = flow.device;
  const wifi = flow.wifi;
  deviceName.value = device ? device.name : '';
  ssid.value = wifi ? wifi.ssid : '';
  manualSsid.value = !!(wifi && wifi.manual);
  fromHistory.value = !!(wifi && wifi.fromHistory);

  const provision = flow.provision;
  if (provision && typeof provision.pwd === 'string' && !pwd.value) {
    pwd.value = provision.pwd;
  }
});
</script>

<style scoped>
.field-label {
  font-size: 26rpx;
  color: #6b7280;
  margin-bottom: 16rpx;
}

.pwd-row {
  display: flex;
  align-items: center;
  background: #f6f7f9;
  border-radius: 16rpx;
  padding: 0 28rpx;
  height: 92rpx;
}

.pwd-input {
  flex: 1;
  height: 92rpx;
  font-size: 30rpx;
}

.pwd-toggle {
  font-size: 26rpx;
  color: #576b95;
  padding-left: 20rpx;
  flex-shrink: 0;
}

.field-tip {
  font-size: 24rpx;
  color: #8a9099;
  margin-top: 16rpx;
  line-height: 1.6;
}

.location-tip {
  font-size: 24rpx;
  color: #8a9099;
  line-height: 1.6;
  padding: 0 8rpx 8rpx;
}

.footer-note {
  text-align: center;
  font-size: 24rpx;
  color: #8a9099;
  margin-top: 20rpx;
}
</style>
