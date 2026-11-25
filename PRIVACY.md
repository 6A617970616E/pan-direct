# PanDirect 隐私政策 / Privacy Policy

**生效日期 / Effective Date:** 2026-11-24  
**最后更新 / Last Updated:** 2026-11-25  
**适用版本 / Applies To:** PanDirect v0.4.0 及后续版本（含商店正式版 `PanDirect` 与开源社区版 `PanDirect (Community)`）

---

## 一、中文版（隐私政策）

### 1. 核心原则（简明摘要）

**PanDirect 是一款纯本地运行、零后端、无统计追踪的开源浏览器扩展。**

- **不收集、不上传用户数据**：开发者不运营任何后台服务器，不收集任何个人信息、浏览历史、网盘文件列表、下载记录、埋点分析或广告标识符。
- **不出售、不共享数据**：扩展处理的全部认证凭据与配置仅保留在你的本机浏览器中，绝不出售、出租或转让给任何第三方。
- **零远程代码**：扩展不包含任何远程加载的脚本或可执行代码，所有代码完全打包在本地扩展内并公开源码（MIT License）。

### 2. 版本范围说明（商店版 vs. 社区版）

PanDirect 采用单仓库双产物构建，不同发行版本的权限边界严格隔离：

- **商店正式版（`PanDirect`，发布于 Chrome Web Store / Microsoft Edge Add-ons）**：
  - 仅包含基于官方开放平台 OAuth 2.0 与 OpenAPI 的网盘适配器（当前为百度网盘）；
  - **不申请 `cookies` 权限**，仅在 `https://pan.baidu.com/*` 页面注入悬浮下载抽屉脚本。
- **开源社区版（`PanDirect (Community)`，仅发布于 GitHub Releases / 源码构建，不上架浏览器应用商店）**：
  - 额外包含社区实验性适配器（如夸克网盘、迅雷云盘）；
  - 夸克网盘适配器为支持本机或局域网 Aria2 推送额外申请 `cookies` 权限，仅在用户主动触发推送至**本机回环地址或 RFC 1918 局域网 IP（不含易被伪造的 `.local` mDNS 域名）**的 Aria2 时，在内存中实时读取对应网盘会话 Cookie 并透传给目标 Aria2。**PanDirect 扩展自身绝不将 Cookie 持久化到存储、绝不输出日志、绝不发送至任何远程或公网地址**；但请注意：透传给 Aria2 后，若你的 Aria2 开启了会话保存（如 `--save-session`）或 RPC 日志，Aria2 端可能会将其写入本地会话/日志文件；若配置为局域网明文 `http://` 地址，请求头会在该局域网内明文传输（建议优先使用本机 `127.0.0.1` / `localhost` 或受信局域网内的 `https://`）；
  - 迅雷云盘适配器仅将已登录 `pan.xunlei.com` 页面中的会话令牌临时同步至内存级 `chrome.storage.session`（关闭浏览器自动清除，绝不写入磁盘 `chrome.storage.local`，绝不上传至任何第三方）。

### 3. 本地处理与存储的数据

#### 3.1 存储在 `chrome.storage.local` 中的数据（仅限当前浏览器本地，不同步至云端）
为了维持扩展正常工作，以下用户主动输入或授权产生的数据仅保存在你本机浏览器的 `chrome.storage.local` 中：

- 你在百度网盘开放平台自行创建的 `AppKey`；
- 你在百度官方授权页显式点击确认后获得的 OAuth 2.0 `access_token` 及过期时间戳；
- 扩展基础偏好设置：规则总开关状态、默认下载方式（浏览器直下 / Aria2）、自定义下载 `User-Agent`；
- 可选的本地 Aria2 / Motrix RPC 地址与 RPC 密钥（仅在你使用 Aria2 推送功能时填写）。

#### 3.2 存储在 `chrome.storage.session` 中的临时数据（关闭浏览器自动清除）
- 发起百度 OAuth 弹窗授权时的临时窗口 ID（`pendingBaiduOAuth`），仅用于匹配官方回调页并在授权完成后自动关闭授权窗口。

#### 3.3 仅在内存中瞬时处理的数据（不落盘）
- 你主动浏览目录或点击下载时，扩展直接从官方网盘 API 获取的目录/文件元数据与临时下载直链，仅用于展示文件列表与发起本地下载，不会上传或持久化存储。
- 按百度网盘开放平台协议要求，百度下载直链（`dlink`）需在查询参数中附带 `access_token`：浏览器原生下载会先完成 302 预检跳转到最终 CDN 节点；使用 Aria2 推送模式时，含 `access_token` 的直链将发往你配置的本地 Aria2，若 Aria2 开启 `--save-session` 或日志功能，Aria2 端可能会在本地记录该下载 URL。

### 4. 网络通信范围

**商店正式版（`PanDirect`）仅会向以下端点发起网络请求：**

1. **百度官方开放平台与授权接口**（`openapi.baidu.com`、`pan.baidu.com`）：用于完成你主动触发的 OAuth 2.0 显式授权、读取网盘目录与获取文件临时下载链接；
2. **百度官方下载 CDN 节点**（`*.pcs.baidu.com`、`*.pcsdata.baidu.com`、`*.baidupcs.com`）：用于执行 1 字节下载预检与下载你主动选择的文件；
3. **你本机的 Aria2 / Motrix RPC 服务**（`http://localhost/*`、`http://127.0.0.1/*`）：仅在你主动点击「测试连接」或以 Aria2 模式推送下载任务时，将下载链接与必要请求头发送至你指定的本地 RPC 地址。

扩展**不会**向开发者服务器或任何第三方统计、广告、中转代理服务器发送任何请求。

### 5. 浏览器权限说明（商店正式版）

| 权限 | 用途说明 |
| --- | --- |
| `declarativeNetRequest` | 仅对百度网盘官方下载主机（`pcs.baidu.com` / `baidupcs.com` / `pcsdata.baidu.com` 及 302 解析后的最终下载主机）设置官方开放平台文档要求的 `User-Agent` 请求头，使浏览器原生下载可正常进行。 |
| `downloads` | 当用户在弹窗中粘贴直链发起下载时，调用浏览器原生下载管理器保存文件。 |
| `storage` | 在本机 `chrome.storage.local` / `chrome.storage.session` 保存用户配置、自行填写的 `AppKey` 与 OAuth `access_token`。 |
| `tabs` | 监听你主动打开的百度官方 OAuth 授权窗口完成回调以自动提取 `access_token` 并关闭窗口；以及打开扩展内置的整文件夹流式下载页面（`downloader/downloader.html`）。不读取、不记录你的常规浏览历史。 |
| `host_permissions` (`*://*.baidu.com/*`, `*://*.baidupcs.com/*`) | 调用百度网盘官方 OpenAPI、在 `https://pan.baidu.com/*` 显示下载抽屉、以及通过 DNR 和内置文件夹下载页拉取百度下载节点数据。 |
| `host_permissions` (`http://localhost/*`, `http://127.0.0.1/*`) | 仅在用户主动配置并使用本地 Aria2 / Motrix 时，向本机 RPC 发送下载任务与连通性测试请求（商店版不在 `localhost` 注入任何网页脚本）。 |

### 6. 数据控制与删除

你对本机存储的所有数据拥有完全控制权：

- **清除授权**：随时在扩展弹窗中点击 **「清除授权」**，立即删除本地保存的 OAuth `access_token` 与过期时间；
- **完全删除**：卸载 PanDirect 扩展后，浏览器会自动清除全部 `chrome.storage.local` 本地数据；
- **撤销平台授权**：你也可以随时在百度账号/百度网盘开放平台管理页面撤销对应应用的授权。

### 7. 合规声明与联系方式

PanDirect 对从浏览器 API 获取的所有用户数据的使用严格遵守 [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)（包括 **Limited Use（限制使用）** 要求）及 Microsoft Edge Add-ons 开发者政策。

如对本隐私政策有任何疑问、建议或安全反馈，请通过 GitHub 仓库联系维护者：

- **项目主页**：https://github.com/6A617970616E/pan-direct
- **问题反馈 / 隐私联系**：https://github.com/6A617970616E/pan-direct/issues

---

## II. English Version (Privacy Policy)

### 1. Summary

**PanDirect is a local-only, zero-backend, open-source browser extension with no analytics or tracking.**

- **No Data Collection by the Developer:** We do not operate any backend servers and do not collect, transmit, or store any personal data, browsing history, cloud file listings, download history, telemetry, or analytics.
- **No Data Sale or Sharing:** All user credentials and preferences remain strictly inside your local browser profile. We never sell, rent, or transfer user data to third parties.
- **No Remotely Hosted Code:** All executable code is bundled locally within the extension package and publicly auditable under the MIT License.

### 2. Edition Scope (Store Edition vs. Community Edition)

PanDirect is built from a single open-source repository into two isolated editions:

- **Store Edition (`PanDirect`, distributed on Chrome Web Store and Microsoft Edge Add-ons):**
  - Includes only official OpenAPI cloud drive adapters (currently Baidu Netdisk via official OAuth 2.0 and OpenAPI).
  - Does **not** request the `cookies` permission and injects content scripts **only** on `https://pan.baidu.com/*`.
- **Community Edition (`PanDirect (Community)`, distributed exclusively via GitHub Releases / source builds, not on web stores):**
  - Includes optional community experimental adapters (such as Quark Netdisk and Xunlei Cloud Drive).
  - The Quark adapter requests the `cookies` permission solely to read active session cookies in memory on demand when forwarding downloads to the user's **trusted loopback or RFC 1918 private LAN IP Aria2 RPC** (`localhost`, `127.0.0.1`, `::1`, or RFC 1918 private IPs; `.local` mDNS hostnames are rejected). **PanDirect itself never persists cookies to storage, never logs them, and never transmits them to public/remote endpoints.** Note that once forwarded, your Aria2 daemon itself may write request headers to disk if `--save-session` or RPC logging is enabled, and plain `http://` to a LAN IP transmits headers unencrypted over that local network (prefer loopback `127.0.0.1` / `localhost` or `https://` on trusted LANs).
  - The Xunlei adapter syncs active `pan.xunlei.com` session tokens strictly into ephemeral in-memory `chrome.storage.session` (cleared on browser close; never persisted to `chrome.storage.local` and never transmitted to third parties).

### 3. Data Handled Locally

#### 3.1 Local Extension Storage (`chrome.storage.local`)
Stored strictly on your local device (never written to `chrome.storage.sync` and never sent to any developer server):

- Your own Baidu Open Platform `AppKey` (BYOK);
- Your Baidu OAuth 2.0 `access_token` and expiration timestamp (obtained only after you explicitly approve authorization in Baidu's official OAuth popup);
- Extension preferences: enabled toggle, default download mode (`browser` or `aria2`), download `User-Agent` setting;
- Optional local Aria2 / Motrix RPC URL and RPC secret (only if you choose to configure Aria2).

#### 3.2 Ephemeral Session Storage (`chrome.storage.session`)
- Temporary OAuth popup window ID (`pendingBaiduOAuth`), used solely to detect the official OAuth completion redirect and automatically close the popup window. Automatically cleared when the browser session ends.

#### 3.3 Ephemeral In-Memory Processing (Not Persisted)
- File listings, directory metadata, and temporary signed download URLs retrieved directly from official cloud drive APIs upon your explicit action to display the file drawer and perform downloads.
- Per Baidu Open Platform protocol, Baidu `dlink` URLs require `access_token` in the query string: native browser downloads resolve the 302 redirect to the signed CDN node first, whereas Aria2 push sends the `dlink` URL directly to your configured local Aria2 daemon (which may save the URL locally if Aria2 `--save-session` or RPC logging is enabled).

### 4. Network Endpoints

**The Store Edition (`PanDirect`) communicates exclusively with:**

1. **Official Baidu OAuth & OpenAPI endpoints** (`openapi.baidu.com`, `pan.baidu.com`) — solely for user-initiated OAuth authorization, file browsing, and download link resolution;
2. **Official Baidu PCS download CDN hosts** (`*.pcs.baidu.com`, `*.pcsdata.baidu.com`, `*.baidupcs.com`) — solely for 1-byte Range preflight checks and downloading user-selected files;
3. **User's local Aria2 / Motrix RPC daemon** (`http://localhost/*`, `http://127.0.0.1/*`) — solely when the user explicitly clicks "Test Connection" or pushes a download task in Aria2 mode.

No requests are ever sent to developer servers, analytics providers, or third-party relays.

### 5. Permissions Explanation (Store Edition)

| Permission | Purpose |
| --- | --- |
| `declarativeNetRequest` | Sets the `User-Agent` header required by Baidu Open Platform documentation exclusively on Baidu PCS download hosts (`pcs.baidu.com`, `baidupcs.com`, `pcsdata.baidu.com`, and 302-resolved CDN download hosts) so native browser downloads succeed. |
| `downloads` | Initiates native browser file downloads when the user pastes a direct download URL in the extension popup. |
| `storage` | Persists user settings, user-provided `AppKey`, and OAuth `access_token` locally in `chrome.storage.local` (and temporary OAuth popup state in `chrome.storage.session`). |
| `tabs` | Listens for the official Baidu OAuth `oob` completion URL in the popup window opened by the user to extract the OAuth token and close the popup automatically, and opens the extension's built-in folder streaming downloader page (`downloader/downloader.html`). General browsing history is never read or recorded. |
| `host_permissions` (`*://*.baidu.com/*`, `*://*.baidupcs.com/*`) | Calls official Baidu Netdisk OpenAPI endpoints, renders the download drawer on `https://pan.baidu.com/*`, and performs DNR header injection and folder streaming fetches from Baidu download CDN hosts. |
| `host_permissions` (`http://localhost/*`, `http://127.0.0.1/*`) | Communicates with the user's optional local Aria2 / Motrix JSON-RPC daemon when explicitly triggered by the user. No content scripts are injected on `localhost` in the Store Edition. |

### 6. User Control & Data Deletion

- **Clear Authorization:** Click **"清除授权" (Clear Authorization)** in the extension popup at any time to immediately erase your stored OAuth token.
- **Complete Removal:** Uninstalling PanDirect automatically removes all data stored in `chrome.storage.local`.
- **Revoke Platform Access:** You may also revoke application access at any time from your Baidu Netdisk / Baidu account authorization settings.

### 7. Chrome Web Store Limited Use & Compliance

PanDirect's handling of information received from browser APIs adheres strictly to the **Chrome Web Store User Data Policy**, including the **Limited Use** requirements, and the **Microsoft Edge Add-ons Developer Policies**:

- User data is processed solely to provide the user-facing cloud file browsing and downloading features explicitly requested by the user;
- User data is never transferred to third parties (other than direct API calls to the user's own cloud drive provider or the user's local Aria2 daemon);
- User data is never used for personalized advertising, profiling, or determining creditworthiness.

### 8. Changes & Contact

If this Privacy Policy is updated, the revised version and updated date will be published at this URL. For privacy questions, security reports, or support:

- **Source Repository:** https://github.com/6A617970616E/pan-direct
- **Issues & Contact:** https://github.com/6A617970616E/pan-direct/issues
