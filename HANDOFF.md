# PanDirect 项目交接文档（HANDOFF）

> 历史完整讨论与调试轨迹：[前期设计与联调对话](conversation://f978482f-0d40-4e6f-ae77-6769aeba2f87)

## 1. 当前状态（v1.0.0，已完成模块化架构重构与双产物打包）

PanDirect 是一个基于 **Chrome / Edge Manifest V3** 的轻量网盘直链下载扩展（纯前端、零后端、零运行时依赖，根目录可直接加载运行，也支持零依赖一键构建商店版与社区版压缩包）。当前能力：

- **国内直连显式 OAuth 隐式授权（`redirect_uri=oob`）**：复用浏览器已登录百度会话，无需配置回调地址，无需代理，点一次确认拿到 30 天有效 `access_token`。
- **单文件浏览器原生直下**：在 `pan.baidu.com` 页面通过官方 `xpan/file` + `xpan/multimedia?method=filemetas` 拿 `dlink`，经 DNR 注入 `User-Agent: pan.baidu.com` 后直接浏览器原生流式下载（已实测非 `/apps/` 根目录文件）。
- **整文件夹流式下载（不打 ZIP、不爆内存）**：通过 `xpan/file?method=list` 队列递归扫描子目录，支持两种落地方式：
  - **浏览器原生目录直写**：独立扩展页 `downloader/downloader.html` 使用 `File System Access API`（`window.showDirectoryPicker`）自动创建嵌套子目录并流式写盘，支持 1~3 并发、跳过同名同大小文件、停止与失败重试（已实测 `/homm3` 整文件夹下载跑通）。
  - **Aria2 / Motrix 批量推送**：保留完整相对路径（`out: 文件夹/子目录/文件`）与 `User-Agent: pan.baidu.com` 推送到本机 RPC。
- **模块化分层与双构建体系**：
  - `core/` 承接通用存储（自动兼容迁移 v0.3.0 旧配置）、DNR 调度、Aria2 RPC、下载引擎、消息路由与可复用悬浮抽屉 UI；
  - `providers/official/` 与 `providers/community/` 通过声明式 `provider.json` + `defineProvider()` 接入；
  - `scripts/build.mjs`（零依赖纯 Node.js）自动生成并严格校验 `dist/store.zip`（绝对不包含社区代码与权限）与 `dist/community.zip`。

---

## 2. 文件结构

```text
.
├── manifest.base.json               # 公共 Manifest 基础模板
├── manifest.json                    # 根目录可直接加载的 Manifest（由 --sync-root 同步）
├── background.js                    # Service Worker 极薄入口（静态导入 providers + initBackground）
├── core/
│   ├── edition.js                   # 构建版本标识（dev / store / community）
│   ├── constants.js                 # 公共常量与 DNR 规则池配置
│   ├── utils.js                     # 文件名/相对路径净化与 URL 工具
│   ├── storage.js                   # 多 Provider 配置读写与 v0.3.0 扁平配置自动迁移
│   ├── provider-registry.js         # Provider 注册表与下载域名匹配
│   ├── dnr.js                       # 多 Provider DNR 规则汇总与 302 CDN 临时规则池
│   ├── aria2.js                     # 通用 Aria2 / Motrix JSON-RPC 客户端
│   ├── downloader-engine.js         # 单文件预检、iframe/原生下载与流式直链引擎
│   ├── background-router.js         # MV3 顶层事件监听与多 Provider 消息路由
│   ├── content-bridge.js            # localhost 网页桥接脚本
│   └── ui/
│       ├── content-drawer.js        # 通用网盘页悬浮抽屉组件（window.PanDirectDrawer.mount）
│       └── content-drawer.css       # 悬浮抽屉样式
├── providers/
│   ├── index.js                     # 静态 ES Provider 汇总（构建时按版本自动生成）
│   ├── popup-index.js               # 静态 ES 弹窗卡片注册（Store 版为空，Community 版含夸克卡片）
│   ├── base-provider.js             # Provider 契约定义与校验（defineProvider）
│   ├── official/
│   │   └── baidu/                   # 百度网盘官方适配器（provider.json + provider.js + content.js）
│   └── community/
│       ├── README.md                # 社区实验性适配器接入规范（仅打入 community.zip）
│       └── quark/                   # 夸克网盘社区适配器（provider.json + provider.js + content.js + popup-card.js）
├── popup/                           # 扩展弹窗（含 Edition 徽章、已启用网盘提示与按版本动态卡片插槽）
├── downloader/                      # 独立文件夹流式下载管理页（支持 ?provider=&label= 与 per-provider credentials）
├── icons/                           # 16 / 48 / 128 PNG 图标
├── scripts/
│   └── build.mjs                    # 零依赖双产物打包与隔离校验脚本（store.zip / community.zip）
├── tests/
│   ├── architecture.test.mjs        # 核心模块、百度适配器与双产物隔离测试
│   └── quark.test.mjs               # 夸克适配器全链路与 Store 零残留隔离测试
├── package.json                     # 脚本入口（npm run build / npm test 零依赖；npm run test:browser 需 Playwright 开发依赖）
├── test-page.html                   # 网页桥接本地测试页（不打入发布包）
├── README.md
├── LICENSE
└── HANDOFF.md
```

---

## 3. 已验证的关键技术坑点（切勿回退）

1. **OAuth 必须用普通弹窗 + `redirect_uri=oob`，不要用 `chrome.identity.launchWebAuthFlow`**
   - `launchWebAuthFlow` 使用隔离 Cookie 会话，会强制用户重输百度账号密码；且 `chromiumapp.org` 回调地址对中国大陆用户不友好、且随本地扩展 ID 变化。
   - 正确做法：`chrome.windows.create({ type: "popup" })` 打开 `https://openapi.baidu.com/oauth/2.0/authorize?response_type=token&redirect_uri=oob&scope=basic,netdisk`，并用顶层 `chrome.tabs.onUpdated` + `chrome.storage.session` 监听 `https://openapi.baidu.com/oauth/2.0/login_success#access_token=...` 自动提取保存并关窗（MV3 Service Worker 休眠唤醒后仍可可靠捕获）。

2. **DNR 规则必须匹配 `||pcs.baidu.com/`，不要写死 `/rest/2.0/pcs/file`**
   - `filemetas` 返回的 `dlink` 路径形如 `https://d.pcs.baidu.com/file/...`，写死 `/rest/2.0/pcs/file` 会漏匹配，导致百度返回 `HTTP 403 {"error_code":31326,"error_msg":"user is not authorized, hitcode:119"}`。
   - 必须覆盖 `||pcs.baidu.com/`、`||baidupcs.com/`、`||pcsdata.baidu.com/`（且 302 预检后动态覆盖最终 CDN 主机），请求头设置 `user-agent: pan.baidu.com` 并移除 `sec-ch-ua*`、`referer`、`origin`。

3. **Chromium 的 `chrome.downloads.download()` 容易绕过 MV3 DNR 改 UA**
   - 直接调用 `chrome.downloads.download()` 可能导致下载失败（`File wasn't available on site`）。
   - 单文件下载：先在 Service Worker 做 1 字节 `Range: bytes=0-0` 预检并解析 302 真实 CDN 链接，再传回悬浮抽屉（`core/ui/content-drawer.js`）用隐藏 `<iframe>` 走标准 Frame 网络栈触发浏览器原生下载（100% 命中 DNR）。
   - 整文件夹下载：在扩展独立标签页 `downloader/downloader.html` 中直接 `fetch()`（拥有 `host_permissions` 无 CORS 且 100% 命中 DNR），配合 `showDirectoryPicker` 流式写盘。

4. **个人应用不要用 `xpan/multimedia?method=listall`（会报 `errno=20020`）**
   - 个人开发者应用默认未开通 `listall` 权限，直接报 `errno=20020`。
   - 正确做法：用基础接口 `xpan/file?method=list` 做队列 BFS 分页递归遍历（实测个人开发态应用可直接读取全盘目录）。

5. **MV3 Service Worker 禁用动态 `import()`**
   - `providers/index.js` 与 `providers/popup-index.js` 必须使用静态 ES `import` 导出当前版本启用的适配器，由 `scripts/build.mjs` 在构建 `store` / `community` 产物时按 `provider.json` 自动生成。

6. **夸克网盘社区版关键要点（仅 `community.zip`，真机已验证单文件直下与本机 Aria2 推送）**
   - 夸克 `POST /1/clouddrive/file/download` 用普通浏览器 UA 会触发 `code=23018`（强制要求桌面客户端），必须由 DNR 为扩展发起的该接口请求与 `||pds.quark.cn/`、`.drive.quark.cn/` 下载节点注入 `quark-cloud-drive/...` 客户端 UA 及 `Referer: https://pan.quark.cn/`。
   - 夸克下载节点（`*.pds.quark.cn` / `*.drive.quark.cn`）依赖 OSS callback 校验浏览器会话 Cookie，因此 1 字节预检与 `downloader.html` 流式 `fetch` 均需按 Provider 声明透传 `credentials: "include"`，且下载节点 DNR 规则**不可**排除 `pan.quark.cn`（以保障页面隐藏 `<iframe>` 命中）。
   - **Aria2 推送与防 412 要点**：
     - `core/aria2.js` 将 `User-Agent` / `Referer` 映射为 Aria2 原生 `user-agent` / `referer` 顶层选项，仅将 `Cookie` 放入 `header` 数组；
     - 在 `resolveDownloadTargets` 请求 `file/download` 期间通过 `chrome.cookies.onChanged` 临时捕获服务端刚轮换的 `__puus`，并严格按下载 URL 作用域选取 Cookie（不混入其它无关 `*.quark.cn` 子域 Cookie），缺失 `__puus` 时自动调用一次 `GET /1/clouddrive/auth/pc/flush` 补发。
   - **权限隔离与零 Cookie 落盘**：仅 `providers/community/quark/provider.json` 声明 `cookies` 权限，仅在推送本机/局域网 Aria2 时内存实时透传（不持久化到 `chrome.storage`、不输出日志、拒绝发送至非本机/局域网地址）；`dist/store.zip` 构建时严格断言绝不含 `cookies` 权限或任何夸克代码。

7. **安全与合规边界**
   - 仓库内**绝不硬编码**任何个人 `AppKey` / `SecretKey` / `access_token`。
   - 商店版 `dist/store.zip` 严格零 `cookies` 权限、绝不静默自动确认 OAuth 或碰 `BDUSS` Cookie；社区版读取 `.quark.cn` Cookie 仅限推送本机/局域网 Aria2 时内存透传，不落盘不上传。
   - 下载域名严格按 Provider 白名单校验，`PANDIRECT_GET_FILE_STREAM_URL` 仅允许来自 `downloader/` 扩展页的调用。

---

## 4. 下一步产品规划（双轨开源路线）

已确定采用 **「单仓库、全部开源、双构建产物」** 路线：

1. **商店正式版（Store Edition → Chrome Web Store + Edge Add-ons）**
   - 仅打包 **100% 官方 OpenAPI** 网盘，权限最小化，稳过商店审核：
     - **百度网盘**（已跑通，后续可尝试提审自有 `PanDirect` 应用免去用户自建 `AppKey`，同时保留 BYOK 兜底）；
     - **123云盘**（官方开发者平台 `https://www.123pan.cn/developer`，文档 `https://123yunpan.yuque.com/org-wiki-123yunpan-muaork/cr6ced`）。
   - 优先同时上架 **Edge Add-ons（免费、中国大陆直连）** 与 **Chrome Web Store（$5）**。
2. **社区版（Community Edition → GitHub Releases）**
   - 在 `providers/community/` 中支持依赖浏览器网页会话的实验性网盘（夸克网盘 `providers/community/quark/` 已真机跑通浏览器直下与本机 Aria2 推送），通过 `npm run build` 分离输出 `dist/store.zip` 与 `dist/community.zip`，`store.zip` 零社区代码与权限残留。
3. **待打磨体验项**
   - ✅ 已完成：重构 `core/` + `providers/official/` + `providers/community/` 双构建打包脚本与自动化测试；
   - ✅ 已完成：夸克网盘社区适配器（已合并入 `main`，单文件浏览器直下、本机 Aria2 零配置自动复用会话已真机验证通过）；
   - ✅ 已完成：中英文隐私政策（`PRIVACY.md`）、商店上架提审指南（`docs/STORE_SUBMISSION.md`）与 `dist/store.zip` 合规加固（去除 `localhost` `content-bridge.js`、补齐 `homepage_url` 与弹窗隐私链接）；
   - ⬜ 待做：准备商店截图与 `300×300`/`440×280` 视觉素材并提交 Edge Add-ons & Chrome Web Store、接入 123云盘官方 Provider、补充「复制直链 / 复制 curl 命令」、弹窗显示百度账号昵称（`xpan/nas?method=uinfo`）。
