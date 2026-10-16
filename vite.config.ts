import { defineConfig } from 'vite';
import uni from '@dcloudio/vite-plugin-uni';

/**
 * 关于下面这两行环境变量：绕开「网络盘不支持 fs.watch」这个坑。
 *
 * SMB / 网络盘（UNC 或映射盘）不支持 Node 原生的 fs.watch。uni-app 编译时会创建
 * chokidar 的 watcher，于是直接挂掉：
 *
 *   Error: UNKNOWN: unknown error, watch
 *     errno: -4094, syscall: 'watch'
 *     at chokidar/index.js:647
 *
 * 打开 chokidar 的轮询模式（CHOKIDAR_USEPOLLING=1）就能绕开。
 *
 * 但**时机很关键**，这是我实测踩过的：
 *   - 一次性构建（npx uni build）时，本文件在 watcher 创建之前被加载，写在这里有效；
 *   - watch 模式（uni -p mp-weixin）时，watcher 在加载本文件**之前**就建好了，
 *     写在这里**来不及**，仍然会崩。
 * 所以可靠的做法是在**进程启动前**就设好 —— 见 package.json 里两个脚本的
 * cross-env CHOKIDAR_USEPOLLING=1（已验证 watch 模式能稳定跑住）。
 *
 * 这里保留一份只是为了让不走 npm 脚本的直接调用（如 `npx uni build`）也能用。
 * 把工程拷到本地磁盘、想省一点 CPU 的话，启动前设 CHOKIDAR_USEPOLLING=0 关掉即可。
 */
if (process.env.CHOKIDAR_USEPOLLING === undefined) {
  process.env.CHOKIDAR_USEPOLLING = '1';
}
if (process.env.CHOKIDAR_INTERVAL === undefined) {
  process.env.CHOKIDAR_INTERVAL = '1000';
}

export default defineConfig({
  plugins: [uni()]
});
