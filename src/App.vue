<script setup lang="ts">
/**
 * 应用入口
 * ---------------------------------------------------------------------------
 * 这里只放全局生命周期和全局样式引用。
 * 跨页面的配网状态在 src/store/flow.ts，蓝牙连接在 src/ble/index.ts。
 */

import { onLaunch, onShow, onHide, onError } from '@dcloudio/uni-app';
import { config } from './config.ts';
import { resetFlow } from './store/flow.ts';

onLaunch(() => {
  console.log('[BLE-Provisioning] 启动，协议服务 UUID = ' + config.ble.serviceUuid);
  // 冷启动一律从干净状态开始。
  // 以前这一步在首页的「开始配网」按钮里做，首页删掉后挪到这里 ——
  // 否则上一次配网残留的 prefill / 设备信息会串到这一次。
  resetFlow(false);
});

onShow(() => {
  // 从后台切回来时，如果连接已经断了，交给各页面的 onShow 自行判断
});

onHide(() => {
  // 刻意不断开连接：用户可能只是切出去看路由器上的密码，马上就回来
});

onError((err) => {
  console.error('[BLE-Provisioning] 未捕获异常:', err);
});
</script>

<style>
/* 全局样式。uni-app 会把 App.vue 的样式编译进 app.wxss，所有页面生效 */
@import './styles/global.css';
</style>
