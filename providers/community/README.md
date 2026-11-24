# Community Providers（社区实验性网盘适配器）

本目录用于存放**仅打包进社区版（`dist/community.zip`）**的实验性网盘适配器（例如依赖浏览器网页会话或非官方 OpenAPI 的网盘，如夸克网盘等）。

> **隔离承诺**：构建脚本 `scripts/build.mjs` 在生成商店正式版 `dist/store.zip` 时，会**完全排除**本目录下的所有代码、权限与 `content_scripts`，确保 Chrome Web Store 与 Edge Add-ons 提审包 100% 仅包含官方 OpenAPI 适配器。

## 接入新社区 Provider 的标准目录结构

```text
providers/community/<provider-id>/
├── provider.json    # 声明式元数据与 Manifest 片段（构建脚本自动发现）
├── provider.js      # 使用 defineProvider(...) 导出统一接口实例
└── content.js       # 页面适配器，调用 window.PanDirectDrawer.mount(...)
```

### `provider.json` 示例

```json
{
  "id": "quark",
  "name": "夸克网盘",
  "tier": "community",
  "enabled": true,
  "description": "社区实验性夸克网盘适配器",
  "entry": "provider.js",
  "exportName": "quarkProvider",
  "manifest": {
    "host_permissions": [
      "https://pan.quark.cn/*",
      "https://drive-pc.quark.cn/*"
    ],
    "content_scripts": [
      {
        "matches": ["https://pan.quark.cn/*"],
        "js": [
          "core/ui/content-drawer.js",
          "providers/community/quark/content.js"
        ],
        "css": ["core/ui/content-drawer.css"],
        "run_at": "document_idle"
      }
    ]
  }
}
```

### 构建验证

新增目录后运行：

```bash
npm run build
```

构建脚本将自动：
1. 在 `dist/store.zip` 中完全忽略该社区适配器；
2. 在 `dist/community.zip` 中自动注入该适配器的静态 ES import、`host_permissions` 与 `content_scripts`。
