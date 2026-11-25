import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  sanitizeSegment,
  sanitizeFilename,
  sanitizeRelativePath,
  normalizeDirectoryPath,
} from "../core/utils.js";
import { buildAria2HeaderOptions } from "../core/aria2.js";
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

test("core/aria2 maps User-Agent and Referer to dedicated Aria2 options without duplicating them in header", () => {
  assert.deepEqual(buildAria2HeaderOptions(["User-Agent: pan.baidu.com"]), {
    "user-agent": "pan.baidu.com",
  });

  assert.deepEqual(
    buildAria2HeaderOptions([
      "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.56",
      "Referer: https://pan.quark.cn/",
      "Cookie: __puus=abc; __uid=1",
    ]),
    {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.56",
      referer: "https://pan.quark.cn/",
      header: ["Cookie: __puus=abc; __uid=1"],
    }
  );
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
      storeManifest.homepage_url,
      "https://github.com/6A617970616E/pan-direct"
    );
    assert.equal(
      storeManifest.host_permissions.includes("https://pan.mock.example/*"),
      false
    );
    assert.equal(
      fs.existsSync(path.join(storeRes.outDir, "core", "content-bridge.js")),
      false
    );
    assert.equal(
      storeManifest.content_scripts.some((cs) =>
        cs.matches.some((m) => m.includes("localhost") || m.includes("127.0.0.1"))
      ),
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

test("PRIVACY.md and Store submission kit exist and accurately document all Store permissions", () => {
  const privacyPath = path.join(REPO_ROOT, "PRIVACY.md");
  const submissionGuidePath = path.join(REPO_ROOT, "docs", "STORE_SUBMISSION.md");
  assert.equal(fs.existsSync(privacyPath), true);
  assert.equal(fs.existsSync(submissionGuidePath), true);

  const privacyText = fs.readFileSync(privacyPath, "utf8");
  for (const required of [
    "declarativeNetRequest",
    "downloads",
    "storage",
    "tabs",
    "Limited Use",
    "chrome.storage.local",
    "PanDirect (Community)",
  ]) {
    assert.ok(
      privacyText.includes(required),
      `PRIVACY.md must document: ${required}`
    );
  }
});

test("core/ui/content-drawer hides floating FAB and open drawer immediately when extension is disabled", async () => {
  const drawerCode = fs.readFileSync(
    path.join(REPO_ROOT, "core", "ui", "content-drawer.js"),
    "utf8"
  );

  function createClassList(initial = []) {
    const set = new Set(initial);
    return {
      add: (cls) => set.add(cls),
      remove: (cls) => set.delete(cls),
      contains: (cls) => set.has(cls),
      toggle: (cls, force) => {
        if (force === undefined) {
          if (set.has(cls)) {
            set.delete(cls);
            return false;
          }
          set.add(cls);
          return true;
        }
        if (force) set.add(cls);
        else set.delete(cls);
        return Boolean(force);
      },
    };
  }

  function createStubEl(initialClasses = []) {
    const classList = createClassList(initialClasses);
    return {
      id: "",
      _className: initialClasses.join(" "),
      get className() {
        return this._className;
      },
      set className(val) {
        this._className = String(val || "");
        for (const c of this._className.split(/\s+/).filter(Boolean)) {
          classList.add(c);
        }
      },
      classList,
      textContent: "",
      title: "",
      innerHTML: "",
      addEventListener: () => {},
      appendChild: () => {},
    };
  }

  const childMap = {
    "#pd-fab": createStubEl(),
    "#pd-drawer": createStubEl(["pd-hidden"]),
    "#pd-close": createStubEl(),
    "#pd-current-path": createStubEl(),
    "#pd-notice": createStubEl(["pd-hidden"]),
    "#pd-list": createStubEl(),
    "#pd-up": createStubEl(["pd-hidden"]),
    "#pd-refresh": createStubEl(),
    "#pd-dl-dir": createStubEl(),
    "#pd-dl-selected": createStubEl(),
  };

  let mountedRoot = null;
  const storageListeners = [];
  const fakeWindow = {};
  const fakeDocument = {
    createElement: () => {
      const el = createStubEl();
      el.querySelector = (sel) => childMap[sel] || null;
      el.querySelectorAll = () => [];
      return el;
    },
    body: {
      appendChild: (el) => {
        mountedRoot = el;
      },
    },
  };
  const fakeChrome = {
    storage: {
      local: {
        get: async () => ({ enabled: false }),
      },
      onChanged: {
        addListener: (fn) => storageListeners.push(fn),
      },
    },
    runtime: {
      sendMessage: (_msg, cb) => cb && cb({ ok: true, enabled: false }),
    },
  };

  vm.runInNewContext(drawerCode, {
    window: fakeWindow,
    document: fakeDocument,
    chrome: fakeChrome,
    setTimeout,
  });

  fakeWindow.PanDirectDrawer.mount({
    providerId: "baidu",
    providerName: "百度网盘",
  });

  // Flush microtask for initEnabledVisibility()
  await new Promise((r) => setTimeout(r, 0));

  // Starts hidden when enabled=false
  assert.ok(mountedRoot);
  assert.equal(mountedRoot.classList.contains("pd-hidden"), true);
  assert.equal(storageListeners.length, 1);

  // Enabling shows floating root
  storageListeners[0]({ enabled: { oldValue: false, newValue: true } }, "local");
  assert.equal(mountedRoot.classList.contains("pd-hidden"), false);

  // Open drawer, then disable -> hides BOTH floating root and open drawer
  childMap["#pd-drawer"].classList.remove("pd-hidden");
  storageListeners[0]({ enabled: { oldValue: true, newValue: false } }, "local");
  assert.equal(mountedRoot.classList.contains("pd-hidden"), true);
  assert.equal(childMap["#pd-drawer"].classList.contains("pd-hidden"), true);
});

test("core/ui/content-drawer injects non-intrusive inline row & toolbar PD buttons, routes clicks, shows toast, and cleans up on OFF", async () => {
  const drawerCode = fs.readFileSync(
    path.join(REPO_ROOT, "core", "ui", "content-drawer.js"),
    "utf8"
  );
  const baiduContentCode = fs.readFileSync(
    path.join(REPO_ROOT, "providers", "official", "baidu", "content.js"),
    "utf8"
  );

  // Compact DOM tree helper supporting selector matching, closest, insertAdjacentElement, remove, events
  function createClassList(el) {
    const getSet = () =>
      new Set(String(el._className || "").split(/\s+/).filter(Boolean));
    const sync = (set) => {
      el._className = Array.from(set).join(" ");
    };
    return {
      add: (...cls) => {
        const s = getSet();
        for (const c of cls) if (c) s.add(c);
        sync(s);
      },
      remove: (...cls) => {
        const s = getSet();
        for (const c of cls) s.delete(c);
        sync(s);
      },
      contains: (c) => getSet().has(c),
      toggle: (c, force) => {
        const s = getSet();
        const shouldHave = force === undefined ? !s.has(c) : Boolean(force);
        if (shouldHave) s.add(c);
        else s.delete(c);
        sync(s);
        return shouldHave;
      },
    };
  }

  function matchesSimple(el, sel) {
    const trimmed = sel.trim();
    if (!trimmed) return false;
    if (trimmed.includes(" ")) {
      const parts = trimmed.split(/\s+/);
      if (!matchesSimple(el, parts[parts.length - 1])) return false;
      let cur = el.parentElement;
      let idx = parts.length - 2;
      while (cur && idx >= 0) {
        if (matchesSimple(cur, parts[idx])) idx--;
        cur = cur.parentElement;
      }
      return idx < 0;
    }

    let rest = trimmed;
    const tagMatch = rest.match(/^[a-zA-Z0-9_-]+/);
    if (tagMatch) {
      if ((el.tagName || "").toLowerCase() !== tagMatch[0].toLowerCase()) {
        return false;
      }
      rest = rest.slice(tagMatch[0].length);
    }

    while (rest.length > 0) {
      if (rest.startsWith("#")) {
        const m = rest.match(/^#([a-zA-Z0-9_-]+)/);
        if (!m || el.id !== m[1]) return false;
        rest = rest.slice(m[0].length);
      } else if (rest.startsWith(".")) {
        const m = rest.match(/^\.([a-zA-Z0-9_-]+)/);
        if (!m || !el.classList.contains(m[1])) return false;
        rest = rest.slice(m[0].length);
      } else if (rest.startsWith("[")) {
        const m = rest.match(
          /^\[([a-zA-Z0-9_:\\-]+)(?:(\*?=)['"]?([^'"\]]*)['"]?)?\]/
        );
        if (!m) return false;
        const attrName = m[1].replace(/\\/g, "");
        const op = m[2];
        const expected = m[3];
        const actual =
          attrName === "class"
            ? el.className
            : el.getAttribute(attrName);
        if (!op) {
          if (actual === null || actual === undefined) return false;
        } else if (op === "=") {
          if (actual !== expected) return false;
        } else if (op === "*=") {
          if (!String(actual || "").includes(expected)) return false;
        }
        rest = rest.slice(m[0].length);
      } else if (rest.startsWith(":checked")) {
        if (!el.checked) return false;
        rest = rest.slice(":checked".length);
      } else {
        return false;
      }
    }
    return true;
  }

  function matchesSelector(el, selectorList) {
    return selectorList
      .split(",")
      .some((part) => matchesSimple(el, part));
  }

  function createEl(tag, { id = "", className = "", attrs = {}, text = "" } = {}) {
    const attrMap = new Map(Object.entries(attrs));
    const listeners = new Map();
    const el = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id,
      _className: className,
      get className() {
        return this._className;
      },
      set className(v) {
        this._className = String(v || "");
      },
      style: {},
      hidden: false,
      checked: false,
      value: attrs.value || "",
      parentElement: null,
      get parentNode() {
        return this.parentElement;
      },
      children: [],
      dataset: {},
      _text: text,
      get textContent() {
        if (this.children.length === 0) return this._text;
        return this._text + this.children.map((c) => c.textContent).join("");
      },
      set textContent(v) {
        this._text = String(v ?? "");
        this.children = [];
      },
      get title() {
        return attrMap.get("title") || "";
      },
      set title(v) {
        attrMap.set("title", String(v ?? ""));
      },
      get isConnected() {
        let cur = this;
        while (cur) {
          if (cur === doc.body) return true;
          cur = cur.parentElement;
        }
        return false;
      },
      get nextElementSibling() {
        if (!this.parentElement) return null;
        const idx = this.parentElement.children.indexOf(this);
        return idx >= 0 ? this.parentElement.children[idx + 1] || null : null;
      },
      get previousElementSibling() {
        if (!this.parentElement) return null;
        const idx = this.parentElement.children.indexOf(this);
        return idx > 0 ? this.parentElement.children[idx - 1] || null : null;
      },
      getAttribute: (k) => (attrMap.has(k) ? attrMap.get(k) : null),
      setAttribute: (k, v) => {
        attrMap.set(k, String(v));
        if (k === "id") el.id = String(v);
        if (k === "class") el._className = String(v);
      },
      appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
      },
      insertAdjacentElement(pos, node) {
        const parent = this.parentElement;
        if (!parent) return null;
        const idx = parent.children.indexOf(this);
        if (idx === -1) return null;
        node.parentElement = parent;
        parent.children.splice(pos === "beforebegin" ? idx : idx + 1, 0, node);
        return node;
      },
      remove() {
        if (!this.parentElement) return;
        const idx = this.parentElement.children.indexOf(this);
        if (idx !== -1) this.parentElement.children.splice(idx, 1);
        this.parentElement = null;
      },
      closest(sel) {
        let cur = this;
        while (cur) {
          if (matchesSelector(cur, sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (node) => {
          for (const c of node.children) {
            if (matchesSelector(c, sel)) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      async trigger(type, event = {}) {
        const fns = listeners.get(type) || [];
        for (const fn of fns) {
          await fn({
            preventDefault: () => {},
            stopPropagation: () => {},
            stopImmediatePropagation: () => {},
            ...event,
          });
        }
      },
    };
    el.classList = createClassList(el);
    return el;
  }

  // Build realistic Baidu /disk/main DOM
  const docListeners = new Map();
  const body = createEl("body");
  const doc = {
    body,
    createElement: (tag) => {
      const el = createEl(tag);
      Object.defineProperty(el, "innerHTML", {
        get: () => el._html || "",
        set: (html) => {
          el._html = String(html || "");
          if (el.id === "pandirect-root") {
            el.children = [];
            const toast = createEl("div", { id: "pd-toast", className: "pd-toast pd-hidden" });
            toast.appendChild(createEl("span", { id: "pd-toast-text" }));
            toast.appendChild(createEl("button", { id: "pd-toast-close", className: "pd-toast-close" }));
            el.appendChild(toast);
            el.appendChild(createEl("button", { id: "pd-fab" }));
            const drawer = createEl("div", { id: "pd-drawer", className: "pd-hidden" });
            drawer.appendChild(createEl("button", { id: "pd-close" }));
            drawer.appendChild(createEl("div", { id: "pd-current-path" }));
            const rBrowser = createEl("input", { attrs: { type: "radio", name: "pd-mode", value: "browser" } });
            rBrowser.checked = true;
            const rAria2 = createEl("input", { attrs: { type: "radio", name: "pd-mode", value: "aria2" } });
            drawer.appendChild(rBrowser);
            drawer.appendChild(rAria2);
            drawer.appendChild(createEl("div", { id: "pd-notice", className: "pd-notice pd-hidden" }));
            drawer.appendChild(createEl("div", { id: "pd-list" }));
            drawer.appendChild(createEl("button", { id: "pd-up", className: "pd-hidden" }));
            drawer.appendChild(createEl("button", { id: "pd-refresh" }));
            drawer.appendChild(createEl("button", { id: "pd-dl-dir" }));
            drawer.appendChild(createEl("button", { id: "pd-dl-selected" }));
            el.appendChild(drawer);
          }
        },
        configurable: true,
      });
      return el;
    },
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    querySelector: (sel) => body.querySelector(sel),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      docListeners.get(type)?.delete(fn);
    },
    emitDocEvent: (type, event) => {
      for (const fn of docListeners.get(type) || []) {
        fn(event);
      }
    },
  };

  // Top header promo buttons that MUST be ignored
  const header = createEl("div", { className: "wp-s-header" });
  header.appendChild(createEl("button", { className: "u-button", text: "下载客户端" }));
  header.appendChild(createEl("button", { className: "u-button", text: "离线下载" }));
  body.appendChild(header);

  // Top selection toolbar with native "下载" button
  const toolbarGroup = createEl("div", { className: "wp-s-agile-tool-bar wp-s-agile-tool-bar__h-group" });
  const toolbarWrap = createEl("div", { className: "wp-s-agile-tool-bar__h-action" });
  const nativeToolbarDl = createEl("button", { className: "u-button", text: "下载" });
  toolbarWrap.appendChild(nativeToolbarDl);
  toolbarGroup.appendChild(toolbarWrap);
  body.appendChild(toolbarGroup);

  // File table with 1 file row (selected) and 1 folder row
  const table = createEl("table");
  const tbody = createEl("tbody");

  const fileRow = createEl("tr", { className: "wp-s-pan-table__body-row selected" });
  const fileTd = createEl("td");
  fileTd.appendChild(
    createEl("a", {
      className: "wp-s-pan-list__file-name-title-text",
      attrs: { title: "F3GOTYCNv2.3.exe" },
      text: "F3GOTYCNv2.3.exe",
    })
  );
  const fileActions = createEl("div", { className: "wp-s-pan-table__body-row-action" });
  fileActions.appendChild(createEl("span", { attrs: { title: "下载" } }));
  const fileMoreBtn = createEl("span", { className: "u-icon-more", attrs: { title: "更多" } });
  fileActions.appendChild(fileMoreBtn);
  fileTd.appendChild(fileActions);
  fileRow.appendChild(fileTd);

  const folderRow = createEl("tr", { className: "wp-s-pan-table__body-row" });
  const folderTd = createEl("td");
  folderTd.appendChild(createEl("span", { className: "u-icon-folder" }));
  folderTd.appendChild(
    createEl("a", {
      className: "wp-s-pan-list__file-name-title-text",
      attrs: { title: "Games" },
      text: "Games",
    })
  );
  const folderActions = createEl("div", { className: "wp-s-pan-table__body-row-action" });
  const folderMoreBtn = createEl("span", { className: "u-icon-more", attrs: { title: "更多" } });
  folderActions.appendChild(folderMoreBtn);
  folderTd.appendChild(folderActions);
  folderRow.appendChild(folderTd);

  tbody.appendChild(fileRow);
  tbody.appendChild(folderRow);
  table.appendChild(tbody);
  body.appendChild(table);

  // Portal three-dots dropdown menu mounted directly under document.body (matching Baidu UI)
  const portalPopover = createEl("div", { className: "u-popover u-popper" });
  const menuList = createEl("div", { className: "u-dropdown-menu" });
  const renameItem = createEl("div", { className: "u-dropdown-menu__item" });
  renameItem.appendChild(createEl("span", { text: "重命名" }));
  const copyItem = createEl("div", { className: "u-dropdown-menu__item" });
  copyItem.appendChild(createEl("span", { text: "复制" }));
  const moveItem = createEl("div", { className: "u-dropdown-menu__item" });
  moveItem.appendChild(createEl("span", { text: "移动" }));
  const exportItem = createEl("div", { className: "u-dropdown-menu__item" });
  exportItem.appendChild(createEl("span", { text: "导出文件目录" }));
  const shareItem = createEl("div", { className: "u-dropdown-menu__item" });
  shareItem.appendChild(createEl("span", { text: "共享" }));
  menuList.appendChild(renameItem);
  menuList.appendChild(copyItem);
  menuList.appendChild(moveItem);
  menuList.appendChild(exportItem);
  menuList.appendChild(shareItem);
  portalPopover.appendChild(menuList);

  const sentMessages = [];
  const storageListeners = [];
  let mutationCb = null;

  class MockMutationObserver {
    constructor(cb) {
      mutationCb = cb;
      this.disconnected = false;
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  }

  const fakeChrome = {
    storage: {
      local: {
        get: async () => ({ enabled: true, downloadMode: "aria2" }),
      },
      onChanged: {
        addListener: (fn) => storageListeners.push(fn),
      },
    },
    runtime: {
      sendMessage: (msg, cb) => {
        sentMessages.push(msg);
        if (msg.type === "PANDIRECT_LIST_FILES") {
          cb({
            ok: true,
            dir: "/Downloads",
            displayPath: "/Downloads",
            files: [
              { id: "777001", fsId: "777001", name: "F3GOTYCNv2.3.exe", isdir: false, size: 1024, path: "/Downloads/F3GOTYCNv2.3.exe" },
              { id: "777002", fsId: "777002", name: "Games", isdir: true, size: 0, path: "/Downloads/Games" },
            ],
          });
          return;
        }
        if (msg.type === "PANDIRECT_DOWNLOAD_ITEMS") {
          cb({ ok: true, results: msg.itemIds.map((id) => ({ ok: true, id })) });
          return;
        }
        if (msg.type === "PANDIRECT_OPEN_FOLDER_DOWNLOADER") {
          cb({ ok: true });
          return;
        }
        cb({ ok: true, enabled: true, downloadMode: "aria2" });
      },
    },
  };

  const fakeWindow = {
    location: { hash: "#/index?category=all&path=%2FDownloads", search: "" },
    addEventListener: () => {},
  };

  const sandbox = {
    window: fakeWindow,
    document: doc,
    chrome: fakeChrome,
    MutationObserver: MockMutationObserver,
    URLSearchParams,
    setTimeout,
    clearTimeout,
  };

  vm.runInNewContext(drawerCode, sandbox);
  vm.runInNewContext(baiduContentCode, sandbox);

  await new Promise((r) => setTimeout(r, 10));

  // 1. Row hover bar and top selection toolbar stay 100% untouched (zero injected buttons)
  assert.equal(fileActions.querySelectorAll(".pd-inline-btn, .pd-inline-menu-item").length, 0);
  assert.equal(body.querySelectorAll(".pd-inline-toolbar-btn").length, 0);
  assert.equal(header.querySelectorAll(".pd-inline-btn").length, 0);

  // 2. Clicking '...' on fileRow mounts portal menu -> injects '直连下载' right above '重命名'
  doc.emitDocEvent("mousedown", { target: fileMoreBtn });
  body.appendChild(portalPopover);
  mutationCb([{ target: body, addedNodes: [portalPopover], removedNodes: [] }]);
  await new Promise((r) => setTimeout(r, 95));

  const menuItems = menuList.querySelectorAll(".pd-inline-menu-item");
  assert.equal(menuItems.length, 1);
  assert.equal(menuItems[0].nextElementSibling, renameItem);
  assert.ok(menuItems[0].innerHTML.includes("直连下载"));
  assert.ok(menuItems[0].title.includes("推送 Aria2"));

  // Repeated mutation does NOT duplicate menu item
  mutationCb([{ target: body, addedNodes: [portalPopover], removedNodes: [] }]);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(menuList.querySelectorAll(".pd-inline-menu-item").length, 1);

  // 3. Brushing mouse over folderRow on the way into the menu MUST NOT hijack activeMenuTarget
  doc.emitDocEvent("mouseover", { target: folderTd });
  await menuItems[0].trigger("click");
  const listCalls = sentMessages.filter((m) => m.type === "PANDIRECT_LIST_FILES");
  const dlCalls = sentMessages.filter((m) => m.type === "PANDIRECT_DOWNLOAD_ITEMS");
  assert.equal(listCalls.length, 1);
  assert.equal(listCalls[0].dir, "/Downloads");
  assert.equal(dlCalls.length, 1);
  assert.deepEqual(Array.from(dlCalls[0].itemIds), ["777001"]);
  assert.equal(dlCalls[0].mode, "aria2");
  const toastEl = body.querySelector("#pd-toast");
  assert.equal(toastEl.classList.contains("pd-hidden"), false);
  assert.ok(body.querySelector("#pd-toast-text").textContent.includes("Aria2"));

  // 4. Clicking '...' on folderRow switches activeMenuTarget on reused portal menu -> opens folder downloader
  doc.emitDocEvent("mousedown", { target: folderMoreBtn });
  await menuItems[0].trigger("click");
  assert.equal(sentMessages.filter((m) => m.type === "PANDIRECT_LIST_FILES").length, 1);
  const folderCalls = sentMessages.filter((m) => m.type === "PANDIRECT_OPEN_FOLDER_DOWNLOADER");
  assert.equal(folderCalls.length, 1);
  assert.equal(folderCalls[0].path, "/Downloads/Games");
  assert.equal(folderCalls[0].mode, "aria2");

  // 5. Clicking drawer "下已勾选" button downloads checked row items
  await body.querySelector("#pd-dl-selected").trigger("click");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sentMessages.filter((m) => m.type === "PANDIRECT_DOWNLOAD_ITEMS").length, 2);

  // 6. Toggling extension OFF removes ALL injected menu items immediately; ON restores them
  storageListeners[0]({ enabled: { oldValue: true, newValue: false } }, "local");
  assert.equal(body.querySelectorAll(".pd-inline-btn, .pd-inline-menu-item").length, 0);
  assert.equal(toastEl.classList.contains("pd-hidden"), true);

  storageListeners[0]({ enabled: { oldValue: false, newValue: true } }, "local");
  assert.equal(menuList.querySelectorAll(".pd-inline-menu-item").length, 1);
  assert.equal(body.querySelectorAll(".pd-inline-toolbar-btn").length, 0);

  // 7. Regression: 2-item 复制/移动 <p>-tag menu in arbitrary class container mid-scaleY(0) transition MUST still inject,
  //    while a horizontal side-by-side 复制/移动 bar MUST NOT inject a menu item
  const compactMenu = createEl("div", { className: "custom-more-box" });
  const copyP = createEl("p", { text: "复制" });
  const moveP = createEl("p", { text: "移动" });
  copyP.getBoundingClientRect = () => ({ left: 520, top: 200, width: 140, height: 0.5 });
  moveP.getBoundingClientRect = () => ({ left: 520, top: 200.5, width: 140, height: 0.5 });
  compactMenu.appendChild(copyP);
  compactMenu.appendChild(moveP);
  body.appendChild(compactMenu);

  const horizontalBar = createEl("div", { className: "custom-horizontal-bar" });
  const hCopy = createEl("span", { text: "复制" });
  const hMove = createEl("span", { text: "移动" });
  hCopy.getBoundingClientRect = () => ({ left: 300, top: 20, width: 56, height: 28 });
  hMove.getBoundingClientRect = () => ({ left: 370, top: 20, width: 56, height: 28 });
  horizontalBar.appendChild(hCopy);
  horizontalBar.appendChild(hMove);
  body.appendChild(horizontalBar);

  mutationCb([{ target: body, addedNodes: [compactMenu, horizontalBar], removedNodes: [] }]);
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(compactMenu.querySelectorAll(".pd-inline-menu-item").length, 1);
  assert.equal(horizontalBar.querySelectorAll(".pd-inline-menu-item").length, 0);

  // 8. Regression: Baidu AgileToolBar overflow dropdown menu nested INSIDE .wp-s-agile-tool-bar__h-group MUST inject
  const agileRowBar = createEl("div", { className: "wp-s-agile-tool-bar" });
  const agileHGroup = createEl("div", { className: "wp-s-agile-tool-bar__h-group" });
  const agileMoreWrap = createEl("div", { className: "wp-s-agile-tool-bar__h-more" });
  const agileDropdown = createEl("div", { className: "wp-s-agile-tool-bar__h-more-menu" });
  const agileRename = createEl("div", { className: "wp-s-agile-tool-bar__h-action", text: "重命名" });
  const agileCopy = createEl("div", { className: "wp-s-agile-tool-bar__h-action", text: "复制" });
  const agileMove = createEl("div", { className: "wp-s-agile-tool-bar__h-action", text: "移动" });
  agileRename.getBoundingClientRect = () => ({ left: 540, top: 260, width: 132, height: 36 });
  agileCopy.getBoundingClientRect = () => ({ left: 540, top: 296, width: 132, height: 36 });
  agileMove.getBoundingClientRect = () => ({ left: 540, top: 332, width: 132, height: 36 });
  agileDropdown.appendChild(agileRename);
  agileDropdown.appendChild(agileCopy);
  agileDropdown.appendChild(agileMove);
  agileMoreWrap.appendChild(agileDropdown);
  agileHGroup.appendChild(agileMoreWrap);
  agileRowBar.appendChild(agileHGroup);
  fileTd.appendChild(agileRowBar);

  mutationCb([{ target: fileTd, addedNodes: [agileRowBar], removedNodes: [] }]);
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(agileDropdown.querySelectorAll(".pd-inline-menu-item").length, 1);

  // Clean up timers cleanly
  storageListeners[0]({ enabled: { oldValue: true, newValue: false } }, "local");
});

