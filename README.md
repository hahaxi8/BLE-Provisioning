# BLE 蓝牙配网小程序（uni-app + Vue 3 + TypeScript）

> BLE 配网工具：手机通过蓝牙把 **Wi-Fi 名称 / 密码 / 城市 / 区县**发给设备，设备据此连接路由器。
> 设备侧按 [docs/device-integration.md](docs/device-integration.md)里的协议实现即可。

|          |                                                                                |
| -------- | ------------------------------------------------------------------------------ |
| 技术栈   | uni-app + Vue 3 + TypeScript（Vite 构建）                                      |
| 构建目标 | 微信小程序（`mp-weixin`）                                                    |
| 后续规划 | 以后要出 App 端，BLE 已按适配器接口分层，只需补一个适配器（见移植文档第 7 节） |
| 测试     | 300+ 断言，`node test/run.js` 直接跑 TypeScript 源码，零额外依赖             |

---

## 快速开始

```bash
# 以下命令都在 BLE-Provisioning 目录下执行

# 1) 装依赖（第一次约 10 分钟，555 个包）
npm install

# 2) 构建微信小程序
npm run build:mp-weixin      # 产物：dist/mp-weixin

# 或者开发模式（改代码自动重编译）
npm run dev:mp-weixin        # 产物同样是 dist/mp-weixin
```

> **`dev:mp-weixin` 和 `build:mp-weixin` 输出到同一个目录** `dist/mp-weixin`
> （脚本里用 `UNI_OUTPUT_DIR` 固定住了）。所以不存在「导入了 A 目录、构建却写到 B 目录」
> 这种坑。两者区别只是 dev 带 sourcemap 不压缩、build 压缩过。

### AppID

真机调试前，把`src/manifest.example.json` 、`project.config.example.json` 改成`src/manifest.json`、`project.config.json`，将 `mp-weixin.appid` 填为自己的 AppID
（微信公众平台 → 开发管理 → 开发设置）。

不填的话构建时会默认成 `touristappid`（游客模式）：微信开发者工具能打开，
但**真机预览受限**。

> **别填错文件**：构建真正读的是 `src/manifest.json` 的 `mp-weixin.appid`。
> 微信开发者工具会在工程根目录另外生成 `project.config.json`，里面也有一个
> `appid` 字段，但 **uni-app 构建不读它** —— 填在那里，构建产物里仍然是
> `touristappid`，真机预览会失败。

> **重要**：微信开发者工具**不支持蓝牙调试** —— BLE 接口在工具里跑不起来，
> 必须用手机扫码真机预览。而真机预览需要 AppID。
> BLE 接口**不需要**特殊类目申请，个人主体的小程序也能用。

### 真机调试

点工具栏「预览」，用手机微信扫码。手机上要：

- 打开蓝牙
- **安卓还要打开定位开关**（系统规定：能扫蓝牙就等于能定位，所以扫描必须有定位权限）
- 允许微信使用位置信息（小程序会主动申请并给出引导）

---

## 目录结构

```
BLE-Provisioning/                  ← 工程根目录（不是小程序根目录）
├── package.json                   依赖与脚本
├── vite.config.ts                 Vite 配置（含网盘构建的兼容处理）
├── tsconfig.json                  TypeScript 配置
│
├── src/                           ← 小程序源码，构建产物从这里出
│   ├── main.ts / App.vue          入口
│   ├── pages.json                 页面注册与全局窗口样式
│   ├── manifest.json              各平台配置（AppID、权限声明在这）
│   │
│   ├── config.ts                  ★ 所有可调参数集中在这（UUID、广播名、超时、主题色）
│   ├── styles/global.css          全局样式（App.vue 用 @import 引入）
│   │
│   ├── ble/                       ★ BLE 分层，这是本工程的核心设计
│   │   ├── types.ts               领域类型 + BleAdapter 接口 + 事件表
│   │   ├── protocol.ts            协议编解码（纯函数、零依赖，可单测）
│   │   ├── errors.ts              错误码 → 中文人话（纯函数、零依赖）
│   │   ├── client.ts              连接编排（平台无关，只认 BleAdapter）
│   │   ├── adapter.ts             适配器注册表（按平台条件编译）
│   │   ├── adapters/
│   │   │   └── mp-weixin.ts       ★ 全工程唯一调 uni/wx 的地方
│   │   └── index.ts               单例导出
│   │
│   ├── composables/useBle.ts      页面订阅 BLE 事件的组合式函数（自动退订）
│   ├── store/flow.ts              跨页面配网流程状态（reactive，不引 Pinia）
│   ├── utils/
│   │   ├── regions.ts             省市区数据访问（取值、反查、搜索）
│   │   ├── storage.ts             配网历史记录
│   │   └── uni-event.ts           uni 事件对象取值（绕开 vue-tsc 的类型错配）
│   ├── data/regions.ts            ⚙ 自动生成：34 省 / 366 市 / 3439 区（65KB）
│   │
│   └── pages/
│       ├── scan/scan.vue          1. 第一页：自检蓝牙/定位 → 自动扫设备
│       ├── wifi/wifi.vue          2. Wi-Fi 列表（设备推送 + 手输兜底）
│       ├── password/password.vue  3. 密码 + 位置入口
│       ├── region/region.vue      4. 选城市（搜索 + 三级选择器）
│       └── result/result.vue      5. 配网结果
│
├── scripts/build-regions.js       ⚙ 生成 src/data/regions.ts（区划更新时重跑）
├── test/                          测试（直接测 TS 源码，不需要编译）
└── docs/device-integration.md     ★ 设备侧接入指南（协议 + 11 个坑 + App 端方案）
```

★ = 核心文件　⚙ = 自动生成 / 工具脚本

---

## 配网流程

```
① 打开小程序   自动开蓝牙 + 申请定位权限 → 自动开始扫描（**不需要点任何按钮**）
② 选择设备     扫到广播名 CS-xxxxxx 的设备 → 连接
③ 选择 Wi-Fi   设备自己扫到的列表 → 选一个（或手动输入 SSID）
④ 填写信息     输密码 + 选城市/区县
⑤ 配网结果     下发 → 等设备回报 → 成功/失败
```

几个刻意的设计，都对应真实会踩的坑：

| 设计                                     | 为什么                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Wi-Fi 列表由**设备**扫，不是手机扫 | `wx.getWifiList` 在 **iOS 上完全不支持**，安卓还要定位权限+GPS。用手机扫会让 iOS 用户直接配不了网。 |
| **先订阅事件，再打开通知**         | 设备侧「写 CCCD = 01 00」这个动作本身就是「去扫 Wi-Fi」的命令，列表几秒后就推上来了。顺序反了就会丢消息。   |
| 手输 SSID 兜底                           | 隐藏 SSID 的热点扫不到；设备扫描能力有限时也能救急。                                                        |
| 「重新扫描」用关通知→开通知实现         | 协议里没有独立的重新扫描命令，设备只在 CCCD 被写 `0x0001` 时扫一次。                                      |
| 结果页才下发，不是密码页                 | 收结果的人必须先订阅好，否则设备回报的 success/fail 会丢。                                                  |
| 收到 success 后忽略断开事件              | 设备配网成功后**会主动断开蓝牙**（固件里配网成功就 deinit 了），这是正常现象。                        |
| 按 MTU 分包写 + 串行 + 间隔              | iOS 不能指定 MTU（通常 185），安卓能协商到 512，兜底 20 字节。而且 iOS 上连续快速写会报 system error。      |
| 页面订阅统一走 `useBleEvents()`        | 它在组件卸载时自动退订。忘记退订是这类小程序最常见的「消息重复触发」来源。                                  |

协议细节和字节级对照表见 [docs/device-integration.md](docs/device-integration.md#1-协议速查表)。

---

## 常用配置

全部集中在 **`src/config.ts`**，改配置不用翻业务代码。

```ts
// 换成您自己的广播名前缀（设备侧改了这里必须同步改，否则扫不到设备）
deviceNamePrefixes: ['CS-'],

// 协议 UUID（默认就是示例里的值）
serviceUuid:    'FF00',
writeCharUuid:  'FF01',   // 手机 → 设备
notifyCharUuid: 'FF02',   // 设备 → 手机

// 设备过滤策略：'name-or-adv'(默认) | 'name' | 'adv' | 'name-and-adv'
filterMode: 'name-or-adv',

// 设备侧城市/区县缓冲区的可用字节数
// 设备侧是 char[64]，预留一个字符串结束符
deviceTextMaxBytes: 63,

// 超时（现场 Wi-Fi 环境差时把 provision 再放宽）
timeouts: { scan: 15000, wifiList: 20000, provision: 60000, ... },

// 主题
app: { title: '设备配网', brandColor: '#07C160', ... }
```

| 想改什么         | 改哪里                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------- |
| 小程序名称       | `src/pages.json` 各页的 `navigationBarTitleText` + `src/manifest.json` 的 `name` |
| 主题色           | `src/config.ts` 的 `app.brandColor`，以及 `src/styles/global.css` 里的 `#07c160` |
| 设备广播名       | `src/config.ts` 的 `deviceNamePrefixes`                                              |
| 超时时间         | `src/config.ts` 的 `timeouts`                                                        |
| 设备侧缓冲区大小 | `src/config.ts` 的 `ble.deviceTextMaxBytes`                                          |
| 小程序 AppID     | `src/manifest.json` 的 `mp-weixin.appid`                                             |
| 安卓定位权限文案 | `src/manifest.json` 的 `mp-weixin.permission`                                        |

> **坑**：`permission` 必须写在 `manifest.json` 的 `mp-weixin` 段里，写在
> `pages.json` 顶层会被 uni-app 静默丢掉（不报错，就是没生效）。
> 这条已经写成断言了，改动时测试会拦住。

---

## 测试

```bash
node test/run.js      # 或 npm test
npm run type-check    # vue-tsc 类型检查
npm run verify        # 上面两个一起跑
```

**不需要先 `npm install`，也不需要编译** —— Node 22.6+ 原生支持 TypeScript
类型剥离（本机是 Node 26），测试直接 require `.ts` 源码。
这也是源码里相对 import 都强制带 `.ts` 后缀的原因：Node 的 ESM 解析器要求显式扩展名。

四个测试文件的分工：

| 文件                  | 保证什么                                                  |
| --------------------- | --------------------------------------------------------- |
| `protocol.test.js`  | 协议对不对 —— 报文格式、UTF-8、分片重组、广播解析       |
| `client.test.js`    | 编排对不对 —— 用假适配器把整条配网链路跑一遍            |
| `regions.test.js`   | 数据对不对 —— 三级区划完整性、直辖市、索引夹紧          |
| `structure.test.js` | 接得对不对 —— 页面文件、import 路径、平台隔离、工程配置 |

其中几条值得单独说：

- **收包分片穷举所有切分点**。设备一条 JSON 会被 MTU 切成多片，边界可能正好切断
  一个汉字。测试遍历**每一个可能的字节位置**切一刀，验证都能拼回原文 ——
  只测一两个点说明不了问题。
- **粘包**：两个 JSON 挤在一次通知里要能拆开；半截报文超时后必须丢掉，
  不能和下一轮配网的数据串在一起。
- **广播包按设备侧源码逐字节构造**，包括最容易记反的字节序：
  设备发的是 `00 FF` 而不是 `FF 00`（`adv_data[i++] = UUID & 0xFF` 在前）。
- **平台隔离**：`client.ts` / `protocol.ts` / `config.ts` 里出现 `uni.` 或 `wx.`
  就报错。

---

## 更新省市区数据

`src/data/regions.ts` 是**自动生成**的，不要去手改。

```bash
npm run build:regions
# 或内网环境先手动下载再喂给脚本：
node scripts/build-regions.js --pca ./pca.json --hkm ./HK-MO-TW.json
```

数据源是 [modood/Administrative-divisions-of-China](https://github.com/modood/Administrative-divisions-of-China)
（民政部口径）。脚本会自动做三处规范化，并做完整性自检（有空的省/市/区就报错退出）：

1. **直辖市**：源数据里北京/上海/天津只有伪市级键「市辖区」，重庆拆成「市辖区」+「县」。
   脚本合并成一个与省同名的市（重庆 → 1 个市 38 个区县）。
2. **伪市级键**：「省直辖县级行政区划」这种行政术语不适合显示在设备屏幕上，
   改成省简称（湖北省 → 「湖北」）。
3. **名称不裁剪**：下发全称带「市」「区」，裁剪由设备侧自己做（它的
   `normalize_city_name()` 只剥「市」）。

---

## 安全说明

**默认不保存 Wi-Fi 密码。** 小程序本地存储是明文的，把用户家里的 Wi-Fi 密码
落盘不合适（小程序被反编译时 storage 是可以读出来的）。

只保存了配网历史（设备名、Wi-Fi 名、城市/区县、时间），用于扫描页底部的
「上次配网」和「用同样配置再配一次」，那里也有「清空记录」。

确实需要「下次不用重输密码」时，把 `src/config.ts` 的 `app.rememberPassword`
改成 `true`，并自行评估风险。

位置信息是**用户自己选的**，不调用定位接口，所以：

- 不需要申请位置接口权限（那要类目审核，个人号基本批不下来）
- 不需要地图 key
- 不需要在小程序后台配 request 合法域名
- 离线可用

---

## 已知限制

1. **必须真机调试**。微信开发者工具不支持 BLE，工具里打开就会卡在蓝牙自检
   （提示「当前平台不支持蓝牙接口」）。
2. **源码不能直接导入微信开发者工具**，必须先 `npm run build:mp-weixin`。
   这是 uni-app 的固有代价（换来的是 Vue 组件化、TS 类型安全、以后能出 App）。
3. **iOS 刷新扫描设备的 RSSI 频率低**。安卓开了 `allowDuplicatesKey` 能实时刷，
   iOS 会合并上报，列表更新慢一些，属系统行为。
4. **设备侧推送的 Wi-Fi 列表没有信号强度和加密方式**（示例源码只取了 SSID 名字）。
   小程序已做好兼容：设备以后在 JSON 里加上 `rssi` 和 `sec`，界面自动显示信号格
   和「加密/开放」标签，**小程序不用改**。
5. **超长区县名会被截断**。全国最长区名「内蒙古阿拉善高新技术产业开发区」45 字节，
   设备侧使用 `char[64]`。小程序会在超过 63 字节时让用户确认后按字节边界截断下发，
   设备屏幕上会显示不全。把设备侧缓冲区改大后，同步改 `deviceTextMaxBytes`。
6. **主包里有 65KB 的区划数据**。小程序主包限制 2MB，完全够用；
   如果您的工程主包已经很满，可以把它挪进分包。

---

## 常见问题

**Q：在开发者工具里一打开就提示「当前平台不支持蓝牙接口」？**
A：正常。微信开发者工具不支持蓝牙，必须用真机调试或预览。

**Q：导入后提示「在项目根目录未找到 app.json」？**
A：说明**没导到构建产物**。`app.json` 是编译出来的，只存在于 `dist/mp-weixin/` 里，
源码目录下永远不会有。两种解法：导入 `BLE-Provisioning/dist/mp-weixin`；
或者导入工程根目录 `BLE-Provisioning`（那里配了 `miniprogramRoot` 指向构建产物）。
先运行 `npm run build:mp-weixin`，确认 `dist/mp-weixin/app.json` 已生成。
如果确认导对了还报错，把项目**关掉重新打开**一次，让开发者工具重新读配置。

**Q：手机上搜不到设备？**
A：按顺序检查：① 设备是否通电且处于配网模式；② **设备是否已经配过网**（配过网的
设备不会再广播，需要断电重新上电）；③ 安卓是否开了定位开关、是否授权了定位权限；
④ 广播名前缀是否和设备一致（`src/config.ts` 的 `deviceNamePrefixes`）。
小程序扫描超时后会给一份排查清单。

**Q：卡在「正在让设备扫描 Wi-Fi」直到超时？**
A：设备没在收到 CCCD 写入后开始扫描。看 [docs/device-integration.md](docs/device-integration.md) 的 3.5 节。

**Q：Wi-Fi 列表页显示「设备返回的数据看不懂」？**
A：设备侧拼 JSON 没转义 SSID，遇到含引号的热点名会产生非法 JSON。
见 [docs/device-integration.md](docs/device-integration.md) 的 3.3 节。页面底部
「查看设备原始报文」能直接看到设备到底发了什么。

**Q：以后要出 App 端要做什么？**
A：写一个实现 `BleAdapter` 接口的适配器放 `src/ble/adapters/app.ts`，
在 `src/ble/adapter.ts` 的 `#ifdef APP-PLUS` 分支返回它。但要注意
**uni-app 的 App 端没有官方 BLE 接口**，需要原生插件或 plus API，
详见 [docs/device-integration.md](docs/device-integration.md) 第 7 节。

**Q：想给别的设备用（换广播名 / UUID / 超时）？**
A：只改 `src/config.ts`。协议层、编排层和界面都不用动。
