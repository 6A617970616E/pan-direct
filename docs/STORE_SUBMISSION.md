# PanDirect 商店正式版上架准备清单（Edge Add-ons & Chrome Web Store）

本指南整理了提审 **Microsoft Edge Add-ons**（免费、国内直连）与 **Chrome Web Store**（\$5 一次性注册费）所需的安装包、隐私声明文案、权限理由、审核测试说明与素材规格，全部可直接复制填写。

---

## 1. 构建与校验商店安装包

**务必上传 `dist/store.zip`，切勿上传仓库根目录或 `dist/community.zip`！**

```bash
npm run build:store
npm test
```

检查清单：
- [ ] 上传文件：`dist/store.zip`
- [ ] `dist/store/manifest.json` 权限仅含：`declarativeNetRequest`、`downloads`、`storage`、`tabs`（**不含 `cookies`**）
- [ ] `dist/store/manifest.json` 仅在 `https://pan.baidu.com/*` 注入内容脚本（**不含 `localhost` 脚本与任何社区适配器**）
- [ ] 隐私政策公开链接可访问：`https://github.com/6A617970616E/pan-direct/blob/main/PRIVACY.md`

---

## 2. 商店通用基础信息（Listing Metadata）

- **名称 / Name:** `PanDirect`
- **分类 / Category:** 效率工具 / Productivity
- **主页 / Website URL:** `https://github.com/6A617970616E/pan-direct`
- **支持页 / Support URL:** `https://github.com/6A617970616E/pan-direct/issues`
- **隐私政策 URL / Privacy Policy URL:** `https://github.com/6A617970616E/pan-direct/blob/main/PRIVACY.md`
- **语言 / Languages:** 简体中文 (`zh_CN`)（可选补充 `en`）

### 简短描述（Short Description，≤ 132 字符）
- **中文：**
  `轻量网盘直下助手：基于网盘开放平台官方 OAuth 与 OpenAPI，支持单文件与整文件夹浏览器原生直下及本地 Aria2 推送。`
- **English:**
  `Lightweight cloud drive download helper using official OpenAPI & OAuth for native browser single-file, folder streaming, and local Aria2 downloads.`

### 详细描述（Detailed Description，可直接复制）

#### 中文版
```text
PanDirect 是一款纯本地运行、零后端、开源透明的轻量网盘直下助手（Manifest V3）。

基于百度网盘开放平台官方 OAuth 2.0 与 OpenAPI，让你无需安装重型官方桌面客户端，即可在浏览器中便捷管理并下载自己的网盘文件：

核心功能：
• 官方 OAuth 显式授权（BYOK 自有 AppKey）：使用你自己在百度网盘开放平台创建的 AppKey，所有授权与 Token 仅保存在本机浏览器 chrome.storage.local，不经过任何第三方服务器。
• 单文件浏览器原生直下：在 pan.baidu.com 页面右侧呼出「PanDirect 直下」悬浮抽屉，自动通过 Manifest V3 declarativeNetRequest 注入开放平台文档要求的下载请求头，一键启动浏览器原生下载。
• 整文件夹流式写盘（不打 ZIP、不爆内存）：通过浏览器原生 File System Access API 选定本地目录后，自动递归扫描并重建完整嵌套子目录结构，支持 1~3 并发、跳过同名同大小文件、随时停止与失败重试。
• 本地 Aria2 / Motrix 批量推送：可选将单文件或整文件夹（保留相对子目录路径）直接推送至本机 Aria2 / Motrix RPC 队列。

隐私与合规承诺：
• 纯本地运行，零开发者后台，无统计埋点、无广告、无远程加载代码。
• 严格遵守网盘开放平台规则，不包含任何破解会员或绕过账号限速功能，下载速度由你自身网盘账号权限决定。
• 开源地址与完整隐私政策见 GitHub 仓库。
```

#### English Version
```text
PanDirect is a lightweight, local-only, zero-backend, open-source (MIT) Manifest V3 extension for downloading files from your own cloud drive via official OpenAPI and OAuth 2.0—without installing a heavy desktop client.

Key Features:
• Official Explicit OAuth 2.0 (Bring Your Own AppKey): Uses your own Baidu Netdisk Open Platform AppKey. Your AppKey and OAuth access token stay strictly in local browser storage (chrome.storage.local) and are never sent to developer servers.
• Native Single-File Browser Download: Open the "PanDirect" floating drawer on pan.baidu.com to browse files and trigger native browser downloads with required OpenAPI download headers applied automatically via Manifest V3 declarativeNetRequest.
• Streaming Folder Download (No ZIP, Low Memory): Uses the browser's File System Access API to write entire nested folders directly to a chosen local directory with configurable concurrency (1–3), skip-existing support, stop, and retry.
• Optional Local Aria2 / Motrix Push: Push single files or full folder trees (preserving subdirectory paths) directly to your local Aria2 / Motrix JSON-RPC daemon.

Privacy & Compliance:
• 100% local execution with zero analytics, zero ads, and zero remotely hosted code.
• Uses official OpenAPI endpoints only; does not bypass platform account limits or membership restrictions.
```

---

## 3. Chrome Web Store「隐私权做法 / Privacy Practices」填写模板

### Single Purpose Description（单一用途说明）
```text
Allows users to browse and download their own cloud drive files and folders directly in the browser or via their local Aria2 daemon using official cloud drive OpenAPI and OAuth 2.0.
```

### Permission Justifications（逐项权限理由，直接粘贴）

- **`declarativeNetRequest`**
  ```text
  Required to set the User-Agent request header ("pan.baidu.com") mandated by Baidu Netdisk Open Platform documentation exclusively on Baidu PCS download hosts (pcs.baidu.com, baidupcs.com, pcsdata.baidu.com, and 302-resolved CDN hosts) so native browser downloads succeed.
  ```
- **`downloads`**
  ```text
  Required to initiate native browser file downloads via chrome.downloads.download() when the user pastes an authorized direct download URL into the extension popup.
  ```
- **`storage`**
  ```text
  Required to store user preferences (enabled switch, download mode, User-Agent, optional local Aria2 RPC settings) and the user's own Baidu Open Platform AppKey and OAuth access_token locally in chrome.storage.local, plus ephemeral OAuth popup window tracking in chrome.storage.session.
  ```
- **`tabs`**
  ```text
  Required to detect when the user completes explicit Baidu OAuth 2.0 authorization in the popup window (openapi.baidu.com/oauth/2.0/login_success) so the extension can capture the returned access_token and close the popup automatically, and to open the extension's built-in folder streaming downloader page (downloader/downloader.html). General browsing history is never read or stored.
  ```
- **`host_permissions` (`*://*.baidu.com/*`, `*://*.baidupcs.com/*`, `http://localhost/*`, `http://127.0.0.1/*`)**
  ```text
  *://*.baidu.com/* and *://*.baidupcs.com/* are required to call official Baidu Netdisk OAuth and OpenAPI endpoints, inject the download drawer UI on https://pan.baidu.com/*, apply declarativeNetRequest headers on download CDN hosts, and stream folder files in the extension downloader page. http://localhost/* and http://127.0.0.1/* are required solely so the extension service worker can send optional JSON-RPC download requests to the user's local Aria2 or Motrix daemon when explicitly configured and triggered by the user.
  ```
- **Are you using remote code?（是否使用远程代码）**
  - 选择：**No, I am not using remote code**（全量脚本均打包在本地 ZIP 中，无外部 CDN / `eval`）。

### Data Usage Disclosures（数据使用披露勾选建议）

> ⚠️ Chrome Web Store 与 Edge Add-ons 要求**商店面板勾选必须与 `PRIVACY.md` 和代码完全一致**。
> 由于扩展在**本机浏览器内**处理用户显式授权的 OAuth `access_token`（`Authentication information`）及可选本地 Aria2 密钥，虽然**不会上传给开发者或任何第三方**，但按照审核口径，请如实勾选并配合 Limited Use 承诺：

- **勾选类别**：
  - `[x] Authentication information`（身份验证信息：仅本机存储用户自己的 Baidu `AppKey`、OAuth `access_token` 及可选本地 Aria2 RPC 密钥，仅用于向百度官方 OpenAPI 与本机 Aria2 鉴权，绝不发送至开发者或第三方）。
  - 其余全部保持未勾选（不收集 PII、健康、财务、位置、网页浏览历史、用户活动、通信内容、网站内容）。
- **认证承诺（三项必勾）**：
  - `[x]` I do not sell or transfer user data to third parties, outside of the approved use cases
  - `[x]` I do not use or transfer user data for purposes that are unrelated to my item's single purpose
  - `[x]` I do not use or transfer user data to determine creditworthiness or for lending purposes

---

## 4. 审核测试说明（Certification / Reviewer Testing Notes）

在 **Edge Partner Center（测试说明）** 与 **Chrome Web Store（Test instructions）** 中填入以下说明，能极大减少审核反复问询：

```text
PanDirect is a Bring-Your-Own-Key (BYOK) local browser extension for Baidu Netdisk Open Platform (official OAuth 2.0 + OpenAPI). It has no developer backend or pre-bundled account credentials.

How to inspect & test:
1. Click the PanDirect toolbar icon to open the popup:
   - Toggle the header switch ON/OFF to verify dynamic declarativeNetRequest rules update (badge switches ON/OFF and rule count updates between 3 and 0).
   - Switch between "浏览器原生直下" (Browser direct download) and "推送到 Aria2" (Local Aria2 RPC), and test local Aria2 connectivity if an Aria2 daemon is running on localhost:6800.
2. Full end-to-end download flow (requires a Baidu Netdisk account + free personal Baidu Open Platform AppKey from https://pan.baidu.com/union/):
   - Paste an AppKey into the popup and click "百度授权" to open Baidu's official OAuth 2.0 oob consent popup (openapi.baidu.com).
   - After user confirmation, the popup closes automatically and stores the OAuth access_token locally in chrome.storage.local only.
   - Visit https://pan.baidu.com/disk/main and click the bottom-right "PanDirect 直下" floating button to browse files, download a single file, or open the folder streaming downloader tab.
3. No cookies permission is requested in this Store build, and no data is ever transmitted to any developer server. Source code and privacy policy are public at https://github.com/6A617970616E/pan-direct.
```

---

## 5. 上架视觉素材清单

| 素材 | 尺寸要求 | 状态 |
| --- | --- | --- |
| 扩展图标（Chrome / 包内） | `16×16` / `48×48` / `128×128` RGBA PNG | ✅ 已就绪：`icons/icon16.png`、`icons/icon48.png`、`icons/icon128.png`（矢量源稿 `assets/store/icon.svg`） |
| Edge Add-ons 商店图标 | `300×300` RGBA PNG | ✅ 已就绪：`assets/store/edge-icon-300.png` |
| Chrome Web Store 小型宣传图 | `440×280` RGB PNG（无透明通道） | ✅ 已就绪：`assets/store/promo-440x280.png` |
| 商店功能截图（至少 1 张，建议 3 张） | `1280×800` PNG（无透明通道） | ⬜ 上架前实机截取：① 扩展弹窗设置页 ② 百度网盘页悬浮抽屉 ③ 整文件夹流式下载进度页（注意遮挡个人文件名 / AppKey） |

---

## 6. 上架提交流程建议

1. **优先提审 Microsoft Edge Add-ons**：
   - 登录 [Microsoft Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview)（免费注册，国内直连）；
   - 新建扩展 → 上传 `dist/store.zip` → 按第 2~4 节填写属性、隐私政策 URL 与测试说明 → 提交审核（通常 3~7 天）。
2. **同步提审 Chrome Web Store**：
   - 登录 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)（一次性 \$5 注册费）；
   - Add new item → 上传同一个 `dist/store.zip` → 按第 2~4 节填写 Store listing、Privacy practices、Test instructions → 提交审核（新账号首次通常 3~7 天）。
3. **社区版发布（GitHub Releases）**：
   - 运行 `npm run build` 同时产出 `dist/store.zip` 与 `dist/community.zip`，在 GitHub Releases 同时附上两份压缩包及说明（商店版零 `cookies` 权限，社区版含夸克网盘）。
