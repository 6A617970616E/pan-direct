import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  sanitizeSegment,
  sanitizeFilename,
  sanitizeRelativePath,
  normalizeDirectoryPath,
} from "../core/utils.js";
import { createBackgroundRuntime } from "../core/background-router.js";
import {
  baiduProvider,
  isAllowedBaiduDownloadUrl,
} from "../providers/official/baidu/provider.js";
import { buildEdition } from "../scripts/build.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function createMockChrome(initialLocal = {}) {
  const localStore = { ...initialLocal };
  const sessionStore = {};
  let dynamicRules = [];
  let badgeText = "";
  let badgeColor = "";
  const createdTabs = [];
  const createdWindows = [];
  const removedWindows = [];
  const downloads = [];

  const mockChrome = {
    runtime: {
      id: "test-ext-id",
      getManifest: () => ({ version: "0.4.0" }),
      getURL: (p) => `chrome-extension://test-ext-id/${p.replace(/^\/+/, "")}`,
    },
    storage: {
      local: {
        get: async (keys) => {
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) out[k] = localStore[k];
            return out;
          }
          if (keys && typeof keys === "object") {
            const out = {};
            for (const [k, defVal] of Object.entries(keys)) {
              out[k] = localStore[k] !== undefined ? localStore[k] : defVal;
            }
            return out;
          }
          return { ...localStore };
        },
        set: async (obj) => {
          Object.assign(localStore, obj);
        },
      },
      session: {
        get: async (key) => ({ [key]: sessionStore[key] }),
        set: async (obj) => {
          Object.assign(sessionStore, obj);
        },
        remove: async (key) => {
          delete sessionStore[key];
        },
      },
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [...dynamicRules],
      updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
        const removeSet = new Set(removeRuleIds);
        dynamicRules = dynamicRules.filter((r) => !removeSet.has(r.id));
        dynamicRules.push(...addRules);
      },
    },
    action: {
      setBadgeText: async ({ text }) => {
        badgeText = text;
      },
      setBadgeBackgroundColor: async ({ color }) => {
        badgeColor = color;
      },
    },
    tabs: {
      create: async (opts) => {
        createdTabs.push(opts);
        return { id: 100 + createdTabs.length, ...opts };
      },
    },
    windows: {
      create: async (opts) => {
        const win = {
          id: 200 + createdWindows.length + 1,
          tabs: [{ id: 300 + createdWindows.length + 1 }],
          ...opts,
        };
        createdWindows.push(win);
        return win;
      },
      remove: async (id) => {
        removedWindows.push(id);
      },
    },
    downloads: {
      download: async (opts) => {
        downloads.push(opts);
        return downloads.length;
      },
    },
  };

  return {
    mockChrome,
    state: {
      localStore,
      sessionStore,
      getDynamicRules: () => dynamicRules,
      getBadge: () => ({ badgeText, badgeColor }),
      createdTabs,
      createdWindows,
      removedWindows,
      downloads,
    },
  };
}

test("core/utils sanitizes filenames and relative paths safely", () => {
  assert.equal(sanitizeSegment('..bad:file*name?.zip'), "bad_file_name_.zip");
  assert.equal(sanitizeFilename("   "), undefined);
  assert.equal(
    sanitizeRelativePath("Folder/../Sub:Dir/./file<1>.bin"),
    "Folder/Sub_Dir/file_1_.bin"
  );
  assert.equal(normalizeDirectoryPath("/homm3///"), "/homm3");
  assert.equal(normalizeDirectoryPath("relative"), "/");
});

test("Baidu provider enforces strict download domain allowlist", () => {
  assert.equal(
    isAllowedBaiduDownloadUrl("https://d.pcs.baidu.com/file/abc?access_token=1"),
    true
  );
  assert.equal(
    isAllowedBaiduDownloadUrl("https://bjbgp01.baidupcs.com/file/abc"),
    true
  );
  assert.equal(
    isAllowedBaiduDownloadUrl("https://c.pcsdata.baidu.com/file/abc"),
    true
  );
  assert.equal(
    isAllowedBaiduDownloadUrl("https://d.pcs.baidu.com.evil.com/file/abc"),
    false
  );
  assert.equal(isAllowedBaiduDownloadUrl("https://evil.com/file/abc"), false);
  assert.equal(isAllowedBaiduDownloadUrl("javascript:alert(1)"), false);
});

test("Baidu DNR rules match full pcs/baidupcs/pcsdata hosts without hardcoding /rest/2.0/pcs/file", () => {
  const rules = baiduProvider.getDnrRules(
    { userAgent: "pan.baidu.com" },
    {
      ruleIdBase: 1000,
      resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest"],
    }
  );
  assert.equal(rules.length, 3);
  assert.deepEqual(
    rules.map((r) => r.condition.urlFilter),
    ["||pcs.baidu.com/", "||baidupcs.com/", "||pcsdata.baidu.com/"]
  );
  const uaHeader = rules[0].action.requestHeaders.find(
    (h) => h.header === "user-agent"
  );
  assert.deepEqual(uaHeader, {
    header: "user-agent",
    operation: "set",
    value: "pan.baidu.com",
  });
});

test("storage seamlessly migrates v0.3.0 flat Baidu keys and preserves login", async () => {
  const futureExpiry = Date.now() + 86400_000;
  const { mockChrome, state } = createMockChrome({
    enabled: true,
    appKey: "test-app-key",
    accessToken: "test-token-123",
    tokenExpiresAt: futureExpiry,
    userAgent: "pan.baidu.com",
  });
  globalThis.chrome = mockChrome;

  const runtime = createBackgroundRuntime([baiduProvider]);
  await runtime.dnr.syncAllDnrRules();

  const status = await runtime.handleMessage({ type: "PANDIRECT_GET_STATUS" });
  assert.equal(status.ok, true);
  assert.equal(status.appKey, "test-app-key");
  assert.equal(status.tokenValid, true);
  assert.equal(status.activeRuleCount, 3);
  assert.equal(status.providers.length, 1);
  assert.equal(status.providers[0].id, "baidu");
  assert.equal(state.localStore.providerConfigs.baidu.accessToken, "test-token-123");
});

test("Baidu OAuth oob flow uses popup window + tabs.onUpdated and closes popup automatically", async () => {
  const { mockChrome, state } = createMockChrome({ enabled: true });
  globalThis.chrome = mockChrome;

  const runtime = createBackgroundRuntime([baiduProvider]);
  const res = await runtime.handleMessage({
    type: "PANDIRECT_OAUTH_LOGIN",
    provider: "baidu",
    appKey: "my-app-key",
  });
  assert.equal(res.ok, true);
  assert.equal(state.createdWindows.length, 1);

  const authUrl = new URL(state.createdWindows[0].url);
  assert.equal(authUrl.origin, "https://openapi.baidu.com");
  assert.equal(authUrl.searchParams.get("response_type"), "token");
  assert.equal(authUrl.searchParams.get("redirect_uri"), "oob");
  assert.equal(authUrl.searchParams.get("client_id"), "my-app-key");

  const win = state.createdWindows[0];
  const callbackUrl =
    "https://openapi.baidu.com/oauth/2.0/login_success#access_token=fresh-token-xyz&expires_in=2592000";

  await runtime.handleTabUpdated(
    win.tabs[0].id,
    { url: callbackUrl },
    { id: win.tabs[0].id, windowId: win.id, url: callbackUrl }
  );

  assert.deepEqual(state.removedWindows, [win.id]);
  const cfg = await runtime.storage.getProviderConfig("baidu");
  assert.equal(cfg.accessToken, "fresh-token-xyz");
  assert.ok(cfg.tokenExpiresAt > Date.now());
});

test("PANDIRECT_GET_FILE_STREAM_URL enforces strict downloader/ sender origin boundary", async () => {
  const { mockChrome } = createMockChrome({
    enabled: true,
    accessToken: "valid-token",
    tokenExpiresAt: Date.now() + 3600_000,
  });
  globalThis.chrome = mockChrome;

  const runtime = createBackgroundRuntime([baiduProvider]);

  // Untrusted webpage sender
  await assert.rejects(
    () =>
      runtime.handleMessage(
        { type: "PANDIRECT_GET_FILE_STREAM_URL", fsId: "123" },
        { id: "test-ext-id", url: "https://pan.baidu.com/disk/main" }
      ),
    /未授权的调用来源/
  );

  // Wrong extension ID
  await assert.rejects(
    () =>
      runtime.handleMessage(
        { type: "PANDIRECT_GET_FILE_STREAM_URL", fsId: "123" },
        {
          id: "other-ext-id",
          url: "chrome-extension://test-ext-id/downloader/downloader.html",
        }
      ),
    /未授权的调用来源/
  );
});

test("Baidu listFolderRecursive uses BFS over xpan/file?method=list (never listall)", async () => {
  const { mockChrome } = createMockChrome({
    enabled: true,
    accessToken: "valid-token",
    tokenExpiresAt: Date.now() + 3600_000,
  });
  globalThis.chrome = mockChrome;

  const requestedUrls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    const parsed = new URL(url);
    const dir = parsed.searchParams.get("dir");
    if (dir === "/homm3") {
      return {
        ok: true,
        json: async () => ({
          errno: 0,
          list: [
            {
              fs_id: 101,
              server_filename: "readme.txt",
              path: "/homm3/readme.txt",
              size: 128,
              isdir: 0,
            },
            {
              fs_id: 102,
              server_filename: "maps",
              path: "/homm3/maps",
              size: 0,
              isdir: 1,
            },
          ],
        }),
      };
    }
    if (dir === "/homm3/maps") {
      return {
        ok: true,
        json: async () => ({
          errno: 0,
          list: [
            {
              fs_id: 201,
              server_filename: "arena.h3m",
              path: "/homm3/maps/arena.h3m",
              size: 4096,
              isdir: 0,
            },
          ],
        }),
      };
    }
    throw new Error(`Unexpected dir: ${dir}`);
  };

  try {
    const runtime = createBackgroundRuntime([baiduProvider]);
    const res = await runtime.handleMessage({
      type: "PANDIRECT_LIST_FOLDER_RECURSIVE",
      provider: "baidu",
      path: "/homm3",
    });

    assert.equal(res.ok, true);
    assert.equal(res.dirsScanned, 2);
    assert.equal(res.totalSize, 4224);
    assert.deepEqual(
      res.files.map((f) => f.relativePath),
      ["homm3/readme.txt", "homm3/maps/arena.h3m"]
    );
    assert.ok(requestedUrls.every((u) => u.includes("xpan/file")));
    assert.ok(requestedUrls.every((u) => !u.includes("listall")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Dual-artifact build strictly isolates community providers out of store.zip and includes them in community.zip", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pandirect-build-test-"));
  const tempDist = path.join(tempRoot, "dist");

  try {
    // Copy project runtime files + manifest.base.json into temp workspace
    for (const item of [
      "manifest.base.json",
      "background.js",
      "LICENSE",
      "core",
      "popup",
      "downloader",
      "icons",
    ]) {
      fs.cpSync(path.join(REPO_ROOT, item), path.join(tempRoot, item), {
        recursive: true,
      });
    }
    fs.mkdirSync(path.join(tempRoot, "providers"), { recursive: true });
    fs.cpSync(
      path.join(REPO_ROOT, "providers", "base-provider.js"),
      path.join(tempRoot, "providers", "base-provider.js")
    );
    fs.cpSync(
      path.join(REPO_ROOT, "providers", "official"),
      path.join(tempRoot, "providers", "official"),
      { recursive: true }
    );

    // Inject a synthetic community provider to prove strict store/community separation
    const mockCommunityDir = path.join(
      tempRoot,
      "providers",
      "community",
      "mockpan"
    );
    fs.mkdirSync(mockCommunityDir, { recursive: true });
    fs.writeFileSync(
      path.join(mockCommunityDir, "provider.json"),
      JSON.stringify(
        {
          id: "mockpan",
          name: "Mock社区盘",
          tier: "community",
          enabled: true,
          entry: "provider.js",
          exportName: "mockPanProvider",
          manifest: {
            host_permissions: ["https://pan.mock.example/*"],
            content_scripts: [
              {
                matches: ["https://pan.mock.example/*"],
                js: [
                  "core/ui/content-drawer.js",
                  "providers/community/mockpan/content.js",
                ],
                css: ["core/ui/content-drawer.css"],
                run_at: "document_idle",
              },
            ],
          },
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(mockCommunityDir, "provider.js"),
      `import { defineProvider } from "../../base-provider.js";
export const mockPanProvider = defineProvider({
  id: "mockpan",
  name: "Mock社区盘",
  tier: "community",
  isAllowedDownloadUrl: (u) => u.startsWith("https://dl.mock.example/"),
  listFiles: async () => ({ dir: "/", files: [] }),
  listFolderRecursive: async () => ({ folderPath: "/", folderName: "Mock", dirsScanned: 1, truncated: false, files: [], totalSize: 0 }),
  resolveDownloadTargets: async () => [],
  resolveStreamTarget: async () => ({ id: "1", filename: "a.bin", size: 1, url: "https://dl.mock.example/a.bin" }),
});
`
    );
    fs.writeFileSync(
      path.join(mockCommunityDir, "content.js"),
      `// mock community content script\n`
    );

    const storeRes = buildEdition({
      rootDir: tempRoot,
      distDir: tempDist,
      edition: "store",
    });
    const communityRes = buildEdition({
      rootDir: tempRoot,
      distDir: tempDist,
      edition: "community",
    });

    // Verify ZIP files exist and are non-empty
    assert.ok(fs.existsSync(storeRes.zipPath));
    assert.ok(fs.existsSync(communityRes.zipPath));
    assert.ok(storeRes.byteLength > 1000);
    assert.ok(communityRes.byteLength > storeRes.byteLength);

    // Store build must NOT include community provider files, hosts, or imports
    assert.deepEqual(storeRes.providers, ["official/baidu"]);
    assert.equal(
      fs.existsSync(path.join(storeRes.outDir, "providers", "community")),
      false
    );
    const storeManifest = JSON.parse(
      fs.readFileSync(path.join(storeRes.outDir, "manifest.json"), "utf8")
    );
    assert.equal(storeManifest.name, "PanDirect");
    assert.equal(
      storeManifest.host_permissions.includes("https://pan.mock.example/*"),
      false
    );

    const storeProvidersMod = await import(
      pathToFileURL(path.join(storeRes.outDir, "providers", "index.js")).href
    );
    assert.deepEqual(
      storeProvidersMod.providers.map((p) => p.id),
      ["baidu"]
    );

    const storeEditionMod = await import(
      pathToFileURL(path.join(storeRes.outDir, "core", "edition.js")).href
    );
    assert.equal(storeEditionMod.EDITION, "store");

    // Community build MUST include both official and community providers
    assert.deepEqual(communityRes.providers, [
      "official/baidu",
      "community/mockpan",
    ]);
    assert.equal(
      fs.existsSync(
        path.join(communityRes.outDir, "providers", "community", "mockpan", "provider.js")
      ),
      true
    );
    const communityManifest = JSON.parse(
      fs.readFileSync(path.join(communityRes.outDir, "manifest.json"), "utf8")
    );
    assert.equal(communityManifest.name, "PanDirect (Community)");
    assert.equal(
      communityManifest.host_permissions.includes("https://pan.mock.example/*"),
      true
    );

    const communityProvidersMod = await import(
      pathToFileURL(path.join(communityRes.outDir, "providers", "index.js")).href
    );
    assert.deepEqual(
      communityProvidersMod.providers.map((p) => p.id),
      ["baidu", "mockpan"]
    );

    const communityEditionMod = await import(
      pathToFileURL(path.join(communityRes.outDir, "core", "edition.js")).href
    );
    assert.equal(communityEditionMod.EDITION, "community");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
