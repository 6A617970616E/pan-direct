# PanDirect · 轻量百度网盘浏览器直下扩展（MV3）

**PanDirect** 是一款纯本地运行、免后端、零第三方依赖的 Chrome / Edge（Manifest V3）开源扩展。基于百度网盘开放平台官方 OAuth 与 OpenAPI，让你脱离官方重型客户端，直接在浏览器中下载单文件或整个文件夹（保留完整子目录结构），或一键推送至本地 Aria2 / Motrix。

## 核心特性

* **纯本地、零后端、开源透明**：不内置任何第三方 `AppKey` 或账号池，不经过任何中转服务器，`access_token` 仅保存在你自己的浏览器本地 `chrome.storage.local`。
* **国内直连显式 OAuth 授权（`redirect_uri=oob`）**：复用浏览器已登录的百度会话，全程直连 `openapi.baidu.com`，**无需代理、无需配置 OAuth 回调页地址**，点一次确认即可获得约 30 天有效期的授权。
* **浏览器原生直下大文件**：通过 Manifest V3 `declarativeNetRequest` 自动将 `*.pcs.baidu.com` 与 `*.baidupcs.com` 下载请求的 `User-Agent` 重写为 `pan.baidu.com`，绕过网页端无法修改 UA 导致的 403 限制。
* **整文件夹流式下载（不打包 ZIP、不爆内存）**：
  * **浏览器模式**：打开扩展内置下载页，使用 Chrome 原生 `File System Access API` 选定本地目录后，自动递归创建嵌套子文件夹并流式管道写盘；支持并发数调节、跳过本地同名同大小文件（断点续传）、停止与失败重试。
  * **Aria2 模式**：自动带上完整相对路径（`out: 文件夹/子目录/文件名`）批量推送给本地 Aria2 / Motrix，自动创建子目录并排队下载。

---

## 3 分钟快速上手

### 第 1 步：加载扩展
1. **推荐**：前往 [GitHub Releases](https://github.com/6A617970616E/pan-direct/releases) 下载对应版本的压缩包并解压（商店正式版 `store.zip` 仅含官方百度网盘适配器；社区版 `community.zip` 额外包含夸克、迅雷适配器；两个发行包均已剔除开发脚本与多余权限）。
   - 如果从源码构建，可运行 `npm run build` 后加载 `dist/community/`（或 `dist/store/`）；直接加载仓库根目录的 `manifest.json` 也可用于本地开发调试（默认已关闭 `localhost` 桥接脚本注入）。
2. 打开 Chrome 访问 `chrome://extensions/`（Edge 访问 `edge://extensions/`）。
3. 打开右上角 **「开发者模式」** → 点击 **「加载已解压的扩展程序」** → 选择解压后的目录。

### 第 2 步：免费获取你自己的 `AppKey`
1. 打开 [百度网盘开放平台](https://pan.baidu.com/union/)，登录你的百度账号并完成个人开发者认证。
2. 点击「创建应用」：
   * **应用类别**：软件
   * **应用分类**：工具效率
   * **应用名称**：`PanDirect`（或任意名称）
   * **应用描述**：`个人浏览器效率扩展工具，调用百度网盘开放平台 OAuth 授权、文件列表浏览与文件下载能力，用于在浏览器中管理与下载本人网盘内的个人文档与学习资料。`
3. 创建完成后，进入应用详情页复制 **`AppKey`**（**切勿泄露 `SecretKey` 和 `SignKey`，本扩展也不需要它们**；使用内置 `oob` 流程，无需在「安全设置」里额外配置回调地址）。

### 第 3 步：一键授权并开始下载
1. 确保当前浏览器已登录 [百度网盘网页版](https://pan.baidu.com/disk/main)。
2. 点击工具栏中的 **PanDirect** 图标，粘贴 `AppKey` 并点击 **「百度授权」** → 在弹出的百度官方授权窗口点确认即可（确认后窗口会自动关闭）。
3. 回到 `https://pan.baidu.com/disk/main`，点击右下角蓝色的 **「PanDirect 直下」** 悬浮按钮：
   * **单个文件**：点击右侧 **「直下」**，或勾选多个文件后点击 **「下已勾选」**。
   * **整个文件夹**：点击文件夹右侧 **「下整夹」** 或顶部 **「下当前目录」**，在打开的文件夹下载器中选择本地保存目录（或点击「全部推送到 Aria2」）。

---

## 架构与双产物打包（Store / Community）

本项目采用 `core/` + `providers/official/` + `providers/community/` 分层架构，扩展运行时与构建脚本零第三方 npm 依赖（仅浏览器集成测试使用 Playwright 作为开发依赖）：

- **商店正式版（`dist/store.zip`）**：仅包含 100% 官方 OpenAPI 适配器（百度网盘），最小权限集（无 `cookies` 权限、无 `localhost` 网页脚本注入），用于上架 Microsoft Edge Add-ons 与 Chrome Web Store；提审指南见 [docs/STORE_SUBMISSION.md](./docs/STORE_SUBMISSION.md)。
- **社区版（`dist/community.zip`）**：额外包含社区实验性适配器（夸克网盘、迅雷云盘，支持浏览器直下、整文件夹写盘与本机 Aria2 零配置自动复用会话，同样不含 `localhost` 桥接脚本），仅通过 GitHub Releases / 源码构建分发。
- **直接开发加载**：仓库根目录自带已同步的 `manifest.json`（默认不注入 `localhost` 桥接脚本，如需本地联调 `test-page.html` 可使用 `node scripts/build.mjs --sync-root --no-dist --with-dev-bridge` 并在扩展存储中手动开启 `devBridgeEnabled`）。
- **双产物构建与自动发版**（Node.js >= 18）：
  ```bash
  npm run build                       # 同时产出 dist/store.zip 与 dist/community.zip
  npm run build:store                 # 仅打包商店正式版（严格排除 providers/community/ 与对应权限）
  npm run build:community             # 打包社区版（包含官方 + 社区实验性适配器）
  npm run sync-root                   # 根据 provider.json 同步根目录 manifest.json 与 providers/index.js
  npm run version:check               # 校验 package.json / manifest / popup 版本号一致性
  npm run version:bump -- 0.4.1       # 一键同步版本号（支持 patch / minor / major / X.Y.Z）
  npm test                            # 运行单元测试与双产物隔离校验（零依赖）
  npm run test:browser                # 在真实 Chromium 中跑 DNR 规则场景矩阵（需先 npm install && npx playwright install chromium）
  ```
  - 推送 `vX.Y.Z` 标签（如 `git tag v0.4.1 && git push origin main --tags`）或在 GitHub Actions 手动运行 `Release` 工作流，将自动测试、打包并发布 `pan-direct-store-vX.Y.Z.zip`、`pan-direct-community-vX.Y.Z.zip` 与 `SHA256SUMS.txt` 至 GitHub Releases。

---

## 隐私与合规声明

* **隐私政策**：请阅读完整的中英文隐私政策 [PRIVACY.md](./PRIVACY.md)（纯本地运行、零开发者后台、无埋点统计、不上传任何用户数据）。
* 本项目商店正式版仅调用网盘开放平台公开文档接口（OAuth 2.0、`xpan/file`、`xpan/multimedia`），**不包含任何解除非会员限速、破解会员或账号池共享功能**，下载速度由用户自身网盘账号权限决定。
* 开源协议：[MIT License](./LICENSE)。
