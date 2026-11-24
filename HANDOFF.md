# PanDirect 项目交接文档（HANDOFF）

> 历史完整讨论与调试轨迹：[前期设计与联调对话](conversation://f978482f-0d40-4e6f-ae77-6769aeba2f87)

## 1. 当前状态（v0.3.0，已全链路实测跑通）

PanDirect 是一个基于 **Chrome / Edge Manifest V3** 的轻量网盘直链下载扩展（纯前端、零后端、免构建，直接加载即可运行）。当前百度网盘核心能力已全部实测验证通过：

- **国内直连显式 OAuth 隐式授权（`redirect_uri=oob`）**：复用浏览器已登录百度会话，无需配置回调地址，无需代理，点一次确认拿到 30 天有效 `access_token`。
- **单文件浏览器原生直下**：在 `pan.baidu.com` 页面通过官方 `xpan/file` + `xpan/multimedia?method=filemetas` 拿 `dlink`，经 DNR 注入 `User-Agent: pan.baidu.com` 后直接浏览器原生流式下载（已实测非 `/apps/` 根目录文件）。
- **整文件夹流式下载（不打 ZIP、不爆内存）**：通过 `xpan/file?method=list` 队列递归扫描子目录，支持两种落地方式：
  - **浏览器原生目录直写**：独立扩展页 `downloader/downloader.html` 使用 `File System Access API`（`window.showDirectoryPicker`）自动创建嵌套子目录并流式写盘，支持 1~3 并发、跳过同名同大小文件、停止与失败重试（已实测 `/homm3` 整文件夹下载跑通）。
  - **Aria2 / Motrix 批量推送**：保留完整相对路径（`out: 文件夹/子目录/文件`）与 `User-Agent: pan.baidu.com` 推送到本机 RPC。

---

## 2. 文件结构

```text
.
├── manifest.json          # MV3 配置（DNR + downloads + storage + tabs）
├── background.js          # Service Worker：OAuth oob、DNR 规则、目录递归、filemetas、Aria2 RPC
├── content-pan.js         # 注入 pan.baidu.com 的右下角悬浮抽屉（单文件直下 / 下整夹 / 返回上级）
├── content-pan.css        # 页面抽屉样式
├── content-bridge.js      # localhost 网页桥接脚本（预留给未来配套网站）
├── popup/                 # 扩展弹窗（开关、AppKey + 百度授权、下载模式、Aria2 配置、快捷测试）
├── downloader/            # 独立文件夹流式下载管理页（showDirectoryPicker + Aria2 批量推）
├── icons/                 # 16 / 48 / 128 PNG 图标
├── test-page.html         # 网页桥接本地测试页
├── README.md              # 面向开源用户的 3 分钟上手指南
├── LICENSE                # MIT License
└── HANDOFF.md             # 本文档
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
   - 单文件下载：先在 Service Worker 做 1 字节 `Range: bytes=0-0` 预检并解析 302 真实 CDN 链接，再传回 `content-pan.js` 用隐藏 `<iframe>` 走标准 Frame 网络栈触发浏览器原生下载（100% 命中 DNR）。
   - 整文件夹下载：在扩展独立标签页 `downloader/downloader.html` 中直接 `fetch()`（拥有 `host_permissions` 无 CORS 且 100% 命中 DNR），配合 `showDirectoryPicker` 流式写盘。

4. **个人应用不要用 `xpan/multimedia?method=listall`（会报 `errno=20020`）**
   - 个人开发者应用默认未开通 `listall` 权限，直接报 `errno=20020`。
   - 正确做法：用基础接口 `xpan/file?method=list` 做队列 BFS 分页递归遍历（实测个人开发态应用可直接读取全盘目录）。

5. **安全与合规边界**
   - 仓库内**绝不硬编码**任何个人 `AppKey` / `SecretKey` / `access_token`。
   - **绝不做**后台静默自动确认 OAuth 授权或读取导出 `BDUSS` Cookie。
   - 下载域名严格白名单校验（`*.pcs.baidu.com` / `*.pcsdata.baidu.com` / `*.baidupcs.com`），`PANDIRECT_GET_FILE_STREAM_URL` 仅允许来自 `downloader/` 扩展页的调用。

---

## 4. 下一步产品规划（双轨开源路线）

已确定采用 **「单仓库、全部开源、双构建产物」** 路线：

1. **商店正式版（Store Edition → Chrome Web Store + Edge Add-ons）**
   - 仅打包 **100% 官方 OpenAPI** 网盘，权限最小化，稳过商店审核：
     - **百度网盘**（已跑通，后续可尝试提审自有 `PanDirect` 应用免去用户自建 `AppKey`，同时保留 BYOK 兜底）；
     - **123云盘**（官方开发者平台 `https://www.123pan.cn/developer`，文档 `https://123yunpan.yuque.com/org-wiki-123yunpan-muaork/cr6ced`）。
   - 优先同时上架 **Edge Add-ons（免费、中国大陆直连）** 与 **Chrome Web Store（$5）**。
2. **社区版（Community Edition → GitHub Releases）**
   - 抽离统一的 `providers/` 适配器层后，在 `providers/community/` 中支持依赖浏览器网页会话的实验性网盘（如夸克网盘 `pan.quark.cn` 等），打包脚本分离输出 `store.zip` 与 `community.zip`，不混入商店审核包。
3. **待打磨体验项**
   - 重构 `core/` + `providers/official/` + `providers/community/` 双构建打包脚本；
   - 补充「复制直链 / 复制 curl 命令」、弹窗显示百度账号昵称（`xpan/nas?method=uinfo`）、隐私政策文档（商店提审必需）。
