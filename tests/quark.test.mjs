import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createBackgroundRuntime } from "../core/background-router.js";
import { baiduProvider } from "../providers/official/baidu/provider.js";
import {
  DEFAULT_QUARK_USER_AGENT,
  isAllowedQuarkDownloadUrl,
  isQuarkDirItem,
  isTrustedLocalAria2Url,
  normalizeQuarkDirId,
  quarkProvider,
  selectQuarkCookiesForUrl,
} from "../providers/community/quark/provider.js";
import { buildEdition } from "../scripts/build.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const POPUP_SENDER = {
  id: "test-ext-id",
  url: "chrome-extension://test-ext-id/popup/popup.html",
};

const DOWNLOADER_SENDER = {
  id: "test-ext-id",
  url: "chrome-extension://test-ext-id/downloader/downloader.html",
};

const QUARK_TAB_SENDER = {
  id: "test-ext-id",
  tab: { url: "https://pan.quark.cn/list#/list/all" },
};

function createMockChrome(initialLocal = {}, mockCookies = []) {
  const localStore = { ...initialLocal };
  const sessionStore = {};
  let dynamicRules = [];
  let sessionRules = [];
  const createdTabs = [];
  const cookieChangeListeners = new Set();

  const mockChrome = {
    runtime: {
      id: "test-ext-id",
      getManifest: () => ({ version: "0.4.0" }),
      getURL: (p) => `chrome-extension://test-ext-id/${p.replace(/^\/+/, "")}`,
    },
    cookies: {
      getAll: async (filter) => {
        if (typeof mockCookies === "function") {
          return mockCookies(filter);
        }
        return [...mockCookies];
      },
      onChanged: {
        addListener: (fn) => cookieChangeListeners.add(fn),
        removeListener: (fn) => cookieChangeListeners.delete(fn),
        emit: (changeInfo) => {
          for (const fn of cookieChangeListeners) fn(changeInfo);
        },
      },
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
      getSessionRules: async () => [...sessionRules],
      updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
        const removeSet = new Set(removeRuleIds);
        sessionRules = sessionRules.filter((r) => !removeSet.has(r.id));
        sessionRules.push(...addRules);
      },
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    tabs: {
      create: async (opts) => {
        createdTabs.push(opts);
        return { id: 100 + createdTabs.length, ...opts };
      },
    },
    windows: {
      create: async () => ({ id: 201, tabs: [{ id: 301 }] }),
      remove: async () => {},
    },
    downloads: {
      download: async () => 1,
    },
  };

  return {
    mockChrome,
    state: {
      localStore,
      createdTabs,
      getDynamicRules: () => dynamicRules,
      getSessionRules: () => sessionRules,
    },
  };
}

test("Quark helpers normalize dir IDs, detect folders, and enforce strict download domain allowlist", () => {
  assert.equal(normalizeQuarkDirId("/"), "0");
  assert.equal(normalizeQuarkDirId(""), "0");
  assert.equal(normalizeQuarkDirId("fid:abc123"), "abc123");
  assert.equal(normalizeQuarkDirId("9f8e7d6c"), "9f8e7d6c");

  assert.equal(isQuarkDirItem({ dir: true, file: false, file_type: 0 }), true);
  assert.equal(isQuarkDirItem({ dir: false, file: true, file_type: 1 }), false);
  assert.equal(isQuarkDirItem({ file: false }), true);
  assert.equal(isQuarkDirItem({ file_type: 0 }), true);

  assert.equal(
    isAllowedQuarkDownloadUrl(
      "https://dl-pc-zb.pds.quark.cn/download/demo.mp4?Expires=123"
    ),
    true
  );
  assert.equal(
    isAllowedQuarkDownloadUrl("https://dl-pc-sz.drive.quark.cn/download/demo.bin"),
    true
  );
  assert.equal(
    isAllowedQuarkDownloadUrl("https://cdn.uc.cn/file/demo.zip"),
    true
  );
  // Web / API hosts on quark.cn and uc.cn must be rejected as download targets
  assert.equal(isAllowedQuarkDownloadUrl("https://pan.quark.cn/account/info"), false);
  assert.equal(isAllowedQuarkDownloadUrl("https://drive-pc.quark.cn/1/clouddrive/file/sort"), false);
  assert.equal(isAllowedQuarkDownloadUrl("https://quark.cn/"), false);
  assert.equal(isAllowedQuarkDownloadUrl("https://www.uc.cn/"), false);
  assert.equal(
    isAllowedQuarkDownloadUrl("https://pds.quark.cn.evil.com/demo.zip"),
    false
  );
  assert.equal(isAllowedQuarkDownloadUrl("https://evil.com/demo.zip"), false);
  assert.equal(isAllowedQuarkDownloadUrl("javascript:alert(1)"), false);
});

test("Quark DNR rules inject client UA for file/download and CDN without disrupting pan.quark.cn web uploads or previews", () => {
  const rules = quarkProvider.getDnrRules(
    { userAgent: DEFAULT_QUARK_USER_AGENT },
    {
      ruleIdBase: 2000,
      resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "media", "other"],
    }
  );

  assert.equal(rules.length, 5);

  const apiDownloadRule = rules.find(
    (r) => r.condition.urlFilter === "||drive-pc.quark.cn/1/clouddrive/file/download"
  );
  assert.ok(apiDownloadRule);
  assert.equal(apiDownloadRule.priority, 2);
  assert.deepEqual(apiDownloadRule.condition.excludedInitiatorDomains, [
    "pan.quark.cn",
    "drive.quark.cn",
  ]);
  const uaHeader = apiDownloadRule.action.requestHeaders.find(
    (h) => h.header === "user-agent"
  );
  assert.ok(uaHeader.value.includes("quark-cloud-drive/"));

  const pdsCdnRule = rules.find((r) => r.condition.urlFilter === "||pds.quark.cn/");
  assert.ok(pdsCdnRule);
  assert.deepEqual(pdsCdnRule.condition.excludedInitiatorDomains, [
    "pan.quark.cn",
    "drive.quark.cn",
  ]);
  assert.deepEqual(pdsCdnRule.condition.requestMethods, ["get", "head"]);
  assert.equal(pdsCdnRule.condition.resourceTypes.includes("main_frame"), false);
  assert.ok(pdsCdnRule.condition.resourceTypes.includes("sub_frame"));
  assert.ok(
    pdsCdnRule.action.requestHeaders.some(
      (h) => h.header === "referer" && h.value === "https://pan.quark.cn/"
    )
  );

  const driveCdnRule = rules.find(
    (r) => r.condition.urlFilter === ".drive.quark.cn/"
  );
  assert.ok(driveCdnRule);
  assert.deepEqual(driveCdnRule.condition.requestDomains, ["drive.quark.cn"]);
  assert.deepEqual(driveCdnRule.condition.excludedInitiatorDomains, [
    "pan.quark.cn",
    "drive.quark.cn",
  ]);
  assert.deepEqual(driveCdnRule.condition.requestMethods, ["get", "head"]);
  assert.equal(driveCdnRule.condition.resourceTypes.includes("main_frame"), false);
  assert.ok(driveCdnRule.condition.resourceTypes.includes("sub_frame"));
});

test("Quark session check updates status on active login and opens pan.quark.cn when logged out", async () => {
  const { mockChrome, state } = createMockChrome({ enabled: true });
  globalThis.chrome = mockChrome;

  const originalFetch = globalThis.fetch;
  let mockLoggedIn = true;

  globalThis.fetch = async (url, init) => {
    assert.equal(init.credentials, "include");
    assert.ok(String(url).startsWith("https://pan.quark.cn/account/info"));
    return {
      ok: true,
      status: 200,
      json: async () =>
        mockLoggedIn
          ? { success: true, data: { nickname: "夸克测试用户" } }
          : { success: false, data: null },
    };
  };

  try {
    const runtime = createBackgroundRuntime([baiduProvider, quarkProvider]);

    const loggedInRes = await runtime.handleMessage(
      {
        type: "PANDIRECT_PROVIDER_AUTH_START",
        provider: "quark",
      },
      POPUP_SENDER
    );
    assert.equal(loggedInRes.ok, true);
    assert.equal(loggedInRes.authResult.loggedIn, true);
    assert.equal(loggedInRes.authResult.nickname, "夸克测试用户");
    assert.equal(state.createdTabs.length, 0);

    mockLoggedIn = false;
    const loggedOutRes = await runtime.handleMessage(
      {
        type: "PANDIRECT_PROVIDER_AUTH_START",
        provider: "quark",
      },
      POPUP_SENDER
    );
    assert.equal(loggedOutRes.ok, true);
    assert.equal(loggedOutRes.authResult.loggedIn, false);
    assert.equal(loggedOutRes.authResult.openedLoginTab, true);
    assert.equal(state.createdTabs.length, 1);
    assert.equal(state.createdTabs[0].url, "https://pan.quark.cn/list#/list/all");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Quark listFiles and listFolderRecursive traverse ID-tree folders via BFS with credentials: include", async () => {
  const { mockChrome } = createMockChrome({ enabled: true });
  globalThis.chrome = mockChrome;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(init.credentials, "include");
    const parsed = new URL(url);

    if (parsed.pathname.endsWith("/file/info")) {
      const fid = parsed.searchParams.get("fid");
      if (fid === "dir_movies") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 200,
            code: 0,
            data: { fid: "dir_movies", file_name: "电影合集", pdir_fid: "0" },
          }),
        };
      }
    }

    if (parsed.pathname.endsWith("/file/sort")) {
      const pdirFid = parsed.searchParams.get("pdir_fid");
      if (pdirFid === "dir_movies") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 200,
            code: 0,
            data: {
              list: [
                {
                  fid: "file_1",
                  file_name: "intro.mp4",
                  size: 1024,
                  dir: false,
                  file: true,
                },
                {
                  fid: "dir_sub",
                  file_name: "字幕",
                  size: 0,
                  dir: true,
                  file: false,
                },
              ],
            },
            metadata: { _total: 2, _size: 100, _page: 1 },
          }),
        };
      }
      if (pdirFid === "dir_sub") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 200,
            code: 0,
            data: {
              list: [
                {
                  fid: "file_2",
                  file_name: "intro.zh.srt",
                  size: 512,
                  dir: false,
                  file: true,
                },
              ],
            },
            metadata: { _total: 1, _size: 100, _page: 1 },
          }),
        };
      }
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const runtime = createBackgroundRuntime([baiduProvider, quarkProvider]);

    const listRes = await runtime.handleMessage(
      {
        type: "PANDIRECT_LIST_FILES",
        provider: "quark",
        dir: "dir_movies",
      },
      QUARK_TAB_SENDER
    );
    assert.equal(listRes.ok, true);
    assert.equal(listRes.providerName, "夸克网盘");
    assert.equal(listRes.displayPath, "/电影合集");
    assert.equal(listRes.parentDir, "0");
    assert.equal(listRes.isRoot, false);
    assert.equal(listRes.files.length, 2);

    const recRes = await runtime.handleMessage(
      {
        type: "PANDIRECT_LIST_FOLDER_RECURSIVE",
        provider: "quark",
        path: "dir_movies",
      },
      DOWNLOADER_SENDER
    );
    assert.equal(recRes.ok, true);
    assert.equal(recRes.folderName, "电影合集");
    assert.equal(recRes.dirsScanned, 2);
    assert.equal(recRes.totalSize, 1536);
    assert.deepEqual(
      recRes.files.map((f) => f.relativePath),
      ["电影合集/intro.mp4", "电影合集/字幕/intro.zh.srt"]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Quark download flow uses credentials: include for preflight/streaming, handles 23018, and passes optional Aria2 headers", async () => {
  const { mockChrome } = createMockChrome({ enabled: true });
  globalThis.chrome = mockChrome;

  const originalFetch = globalThis.fetch;
  let simulate23018 = false;
  let capturedAria2Body = null;
  let preflightCredentials = null;
  let emitRotatedPuus = "";
  let flushCalledCount = 0;

  globalThis.fetch = async (url, init = {}) => {
    const strUrl = String(url);

    if (strUrl.includes("/1/clouddrive/auth/pc/flush")) {
      flushCalledCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 200, code: 0 }),
      };
    }

    if (strUrl.includes("/1/clouddrive/file/download")) {
      assert.equal(init.method, "POST");
      assert.equal(init.credentials, "include");
      if (emitRotatedPuus && globalThis.chrome?.cookies?.onChanged?.emit) {
        globalThis.chrome.cookies.onChanged.emit({
          removed: false,
          cookie: {
            name: "__puus",
            value: emitRotatedPuus,
            domain: ".quark.cn",
          },
        });
      }
      if (simulate23018) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 400, code: 23018, message: "client required" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 200,
          code: 0,
          data: [
            {
              fid: "fid_demo_1",
              file_name: "movie.mkv",
              size: 4096,
              download_url:
                "https://dl-pc-zb.pds.quark.cn/download/movie.mkv?Expires=99999",
            },
          ],
        }),
      };
    }

    if (strUrl.startsWith("https://dl-pc-zb.pds.quark.cn/")) {
      preflightCredentials = init.credentials;
      return {
        ok: true,
        status: 206,
        url: "https://dl-pc-zb.pds.quark.cn/download/movie.mkv?Expires=99999",
        headers: new Headers({
          "content-disposition": "attachment; filename=movie.mkv",
        }),
        body: { cancel: async () => {} },
      };
    }

    if (strUrl === "http://localhost:6800/jsonrpc") {
      capturedAria2Body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", result: "gid_quark_01" }),
      };
    }

    throw new Error(`Unexpected fetch: ${strUrl}`);
  };

  try {
    const runtime = createBackgroundRuntime([baiduProvider, quarkProvider]);

    // 1. Browser iframe download
    const dlRes = await runtime.handleMessage(
      {
        type: "PANDIRECT_DOWNLOAD_ITEMS",
        provider: "quark",
        itemIds: ["fid_demo_1"],
        mode: "browser",
        preferFrameDownload: true,
      },
      QUARK_TAB_SENDER
    );
    assert.equal(dlRes.ok, true);
    assert.equal(dlRes.results[0].ok, true);
    assert.equal(preflightCredentials, "include");
    assert.ok(dlRes.results[0].frameDownloadUrl.includes("dl-pc-zb.pds.quark.cn"));

    // 2. Trusted downloader stream URL returns credentials: include (and never leaks internal cookie hints)
    const streamRes = await runtime.handleMessage(
      {
        type: "PANDIRECT_GET_FILE_STREAM_URL",
        provider: "quark",
        itemId: "fid_demo_1",
      },
      DOWNLOADER_SENDER
    );
    assert.equal(streamRes.ok, true);
    assert.equal(streamRes.credentials, "include");
    assert.equal(streamRes._rotatedPuus, undefined);

    // 3. Aria2 push maps User-Agent & Referer to native Aria2 options and forwards ephemeral cookies
    const { mockChrome: cookieChrome, state: cookieState } = createMockChrome(
      { enabled: true },
      [
        { name: "__puus", value: "live_session_puus", domain: ".quark.cn", path: "/", expirationDate: 2000000000 },
        { name: "__uid", value: "uid_123", domain: ".quark.cn", path: "/", expirationDate: 2000000000 },
      ]
    );
    globalThis.chrome = cookieChrome;
    const autoRuntime = createBackgroundRuntime([baiduProvider, quarkProvider]);

    const autoAriaRes = await autoRuntime.handleMessage(
      {
        type: "PANDIRECT_PUSH_ITEM_TO_ARIA2",
        provider: "quark",
        itemId: "fid_demo_1",
        relativePath: "Movies/movie.mkv",
      },
      DOWNLOADER_SENDER
    );
    assert.equal(autoAriaRes.ok, true);
    assert.equal(autoAriaRes.gid, "gid_quark_01");
    const autoOpts = capturedAria2Body.params[1];
    assert.equal(autoOpts.out, "Movies/movie.mkv");
    assert.ok(autoOpts["user-agent"].includes("quark-cloud-drive/"));
    assert.equal(autoOpts.referer, "https://pan.quark.cn/");
    assert.deepEqual(autoOpts.header, [
      "Cookie: __puus=live_session_puus; __uid=uid_123",
    ]);
    // Must NEVER persist auto-read browser cookies to storage
    assert.equal(cookieState.localStore.providerConfigs?.quark?.aria2Cookie, undefined);

    // 3b. Live __puus Set-Cookie rotation observed during POST /file/download overrides stale cookie jar value
    emitRotatedPuus = "fresh_rotated_puus_999";
    const rotatedRes = await autoRuntime.handleMessage(
      {
        type: "PANDIRECT_PUSH_ITEM_TO_ARIA2",
        provider: "quark",
        itemId: "fid_demo_1",
        relativePath: "Movies/movie.mkv",
      },
      DOWNLOADER_SENDER
    );
    emitRotatedPuus = "";
    assert.equal(rotatedRes.ok, true);
    assert.deepEqual(capturedAria2Body.params[1].header, [
      "Cookie: __puus=fresh_rotated_puus_999; __uid=uid_123",
    ]);

    // 3c. Missing __puus triggers one-shot auth/pc/flush before failing
    let flushedReady = false;
    const { mockChrome: flushChrome } = createMockChrome({ enabled: true }, () => {
      if (flushCalledCount > 0) flushedReady = true;
      return flushedReady
        ? [{ name: "__puus", value: "flushed_puus_ok", domain: ".quark.cn", path: "/" }]
        : [{ name: "__uid", value: "uid_only", domain: ".quark.cn", path: "/" }];
    });
    globalThis.chrome = flushChrome;
    const flushRuntime = createBackgroundRuntime([baiduProvider, quarkProvider]);
    const flushAriaRes = await flushRuntime.handleMessage(
      {
        type: "PANDIRECT_PUSH_ITEM_TO_ARIA2",
        provider: "quark",
        itemId: "fid_demo_1",
      },
      DOWNLOADER_SENDER
    );
    assert.equal(flushAriaRes.ok, true);
    assert.equal(flushCalledCount, 1);
    assert.deepEqual(capturedAria2Body.params[1].header, [
      "Cookie: __puus=flushed_puus_ok",
    ]);

    // 4. Refuse auto-sending browser session cookies to non-local public Aria2 RPC URLs
    globalThis.chrome = cookieChrome;
    await autoRuntime.handleMessage(
      {
        type: "PANDIRECT_SET_CONFIG",
        aria2Url: "https://remote.example.com:6800/jsonrpc",
      },
      POPUP_SENDER
    );
    await assert.rejects(
      () =>
        autoRuntime.handleMessage(
          {
            type: "PANDIRECT_PUSH_ITEM_TO_ARIA2",
            provider: "quark",
            itemId: "fid_demo_1",
          },
          DOWNLOADER_SENDER
        ),
      /安全保护/
    );

    // 5. Local Aria2 URL trust check (rejects .local mDNS & invalid octets) & cookie selector
    assert.equal(isTrustedLocalAria2Url("http://localhost:6800/jsonrpc"), true);
    assert.equal(isTrustedLocalAria2Url("http://127.0.0.1:16800/jsonrpc"), true);
    assert.equal(isTrustedLocalAria2Url("http://192.168.1.10:6800/jsonrpc"), true);
    assert.equal(isTrustedLocalAria2Url("http://nas.local:6800/jsonrpc"), false);
    assert.equal(isTrustedLocalAria2Url("http://10.999.1.1:6800/jsonrpc"), false);
    assert.equal(isTrustedLocalAria2Url("https://evil.example/jsonrpc"), false);

    const selectedHeader = selectQuarkCookiesForUrl({
      nowSec: 1000,
      targetCookies: [
        { name: "__puus", value: "old_root_puus", domain: ".quark.cn", path: "/", expirationDate: 2000 },
        { name: "__puus", value: "newer_drive_puus", domain: ".drive.quark.cn", path: "/", expirationDate: 2500 },
        { name: "expired_key", value: "dead", domain: ".quark.cn", path: "/", expirationDate: 500 },
        { name: "__pus", value: "pus_val", domain: ".quark.cn", path: "/", expirationDate: 3000 },
      ],
      apiCookies: [
        { name: "__puus", value: "api_freshest_puus", domain: "drive-pc.quark.cn", path: "/", expirationDate: 4000 },
        { name: "api_only_noise", value: "ignore_me", domain: "drive-pc.quark.cn", path: "/", expirationDate: 4000 },
      ],
    });
    assert.equal(selectedHeader, "__puus=api_freshest_puus; __pus=pus_val");

    // 5b. Legacy aria2Cookie values in storage are ignored/stripped and never persisted
    globalThis.chrome = cookieChrome;
    await autoRuntime.handleMessage(
      {
        type: "PANDIRECT_SET_CONFIG",
        aria2Url: "http://localhost:6800/jsonrpc",
        provider: "quark",
        providerConfig: { aria2Cookie: "legacy_stale_cookie_value" },
      },
      POPUP_SENDER
    );
    assert.equal(cookieState.localStore.providerConfigs?.quark?.aria2Cookie, undefined);
    const liveAriaRes = await autoRuntime.handleMessage(
      {
        type: "PANDIRECT_PUSH_ITEM_TO_ARIA2",
        provider: "quark",
        itemId: "fid_demo_1",
        relativePath: "Movies/movie.mkv",
      },
      DOWNLOADER_SENDER
    );
    assert.equal(liveAriaRes.ok, true);
    assert.deepEqual(capturedAria2Body.params[1].header, [
      "Cookie: __puus=live_session_puus; __uid=uid_123",
    ]);

    globalThis.chrome = mockChrome;

    // 6. code=23018 returns clear guidance
    simulate23018 = true;
    await assert.rejects(
      () =>
        runtime.handleMessage(
          {
            type: "PANDIRECT_DOWNLOAD_ITEMS",
            provider: "quark",
            itemIds: ["fid_demo_1"],
            mode: "browser",
          },
          QUARK_TAB_SENDER
        ),
      /23018/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Quark content.js parses multi-level SPA hash routes and AntD selected rows accurately", () => {
  const contentScript = fs.readFileSync(
    path.join(REPO_ROOT, "providers", "community", "quark", "content.js"),
    "utf8"
  );

  let mountedAdapter = null;
  const fakeWindow = {
    location: {
      hash: "#/list/all/3b2a1f001122-%E7%94%B5%E5%BD%B1/9c8d7e334455-2025-Sci-Fi?sort=name",
    },
    PanDirectDrawer: {
      mount: (adapter) => {
        mountedAdapter = adapter;
      },
    },
  };

  const fakeRows = [
    {
      getAttribute: (attr) => (attr === "data-row-key" ? "abcdef1234567890" : null),
      dataset: {},
      querySelector: () => ({
        getAttribute: () => "demo.mp4",
        textContent: "demo.mp4",
      }),
    },
  ];
  const fakeDocument = {
    querySelectorAll: () => fakeRows,
  };

  vm.runInNewContext(contentScript, {
    window: fakeWindow,
    document: fakeDocument,
  });

  assert.ok(mountedAdapter);
  assert.equal(mountedAdapter.providerId, "quark");
  assert.equal(mountedAdapter.rootDir, "0");

  // Multi-level nested folder with Chinese + dashes in folder name + query string
  assert.deepEqual(JSON.parse(JSON.stringify(mountedAdapter.getCurrentDir())), {
    dir: "9c8d7e334455",
    displayPath: "/电影/2025-Sci-Fi",
  });

  // Root folder
  fakeWindow.location.hash = "#/list/all";
  assert.deepEqual(JSON.parse(JSON.stringify(mountedAdapter.getCurrentDir())), {
    dir: "0",
    displayPath: "/",
  });

  // Selected AntD table row
  assert.deepEqual(
    JSON.parse(JSON.stringify(mountedAdapter.getSelectedItemsFromDom())),
    {
      ids: ["abcdef1234567890"],
      names: ["demo.mp4"],
    }
  );

  // Verify Quark inlineActions config & idIsFolderPath (menu-only, no top toolbar injection)
  assert.equal(mountedAdapter.idIsFolderPath, true);
  assert.equal(
    typeof mountedAdapter.inlineActions?.resolveRowContextFromTarget,
    "function"
  );
  assert.equal(typeof mountedAdapter.inlineActions?.findMenuAnchors, "function");
  assert.equal(mountedAdapter.inlineActions?.findToolbarAnchors, undefined);

  // Build minimal Quark AntD row + dropdown menu DOM
  const mockRow = {
    nodeType: 1,
    tagName: "TR",
    className: "ant-table-row",
    getAttribute: (k) => (k === "data-row-key" ? "fid_quark_9988" : null),
    dataset: {},
    closest: (sel) => (sel.includes("tr.ant-table-row") ? mockRow : null),
    querySelector: (sel) => {
      if (sel.includes(".filename-text")) {
        return { getAttribute: () => "guide.pdf", textContent: "guide.pdf" };
      }
      return null;
    },
  };

  const mockMoreBtn = {
    nodeType: 1,
    tagName: "SPAN",
    className: "icon-more",
    closest: (sel) => {
      if (sel.includes("more")) return mockMoreBtn;
      if (sel.includes("tr.ant-table-row")) return mockRow;
      return null;
    },
  };

  const rowCtx = mountedAdapter.inlineActions.resolveRowContextFromTarget(mockMoreBtn);
  assert.ok(rowCtx);
  assert.equal(rowCtx.isMoreTrigger, true);
  assert.deepEqual(JSON.parse(JSON.stringify(rowCtx.item)), {
    id: "fid_quark_9988",
    name: "guide.pdf",
    isdir: null,
  });

  const mockDropdownUl = {
    tagName: "UL",
    closest: () => null,
    querySelectorAll: () => [mockMenuRename, mockMenuMove],
  };
  const mockMenuRename = {
    tagName: "LI",
    textContent: "重命名",
    parentElement: mockDropdownUl,
    closest: () => null,
  };
  const mockMenuMove = {
    tagName: "LI",
    textContent: "移动",
    parentElement: mockDropdownUl,
    closest: () => null,
  };

  const mockQuarkDoc = {
    body: { children: [] },
    querySelectorAll: (sel) => {
      if (sel.includes("menuitem")) return [mockMenuRename, mockMenuMove];
      return [];
    },
  };

  const menuAnchors = mountedAdapter.inlineActions.findMenuAnchors(mockQuarkDoc);
  assert.equal(menuAnchors.length, 1);
  assert.equal(menuAnchors[0].anchor, mockMenuRename);
  assert.equal(menuAnchors[0].insertPosition, "beforebegin");
  assert.equal(menuAnchors[0].itemTag, "li");
});

test("Real repo dual-artifact build keeps Quark and cookies 100% out of store.zip and wires them into community.zip", async () => {
  const tempDist = fs.mkdtempSync(path.join(os.tmpdir(), "pandirect-quark-dist-"));
  try {
    const storeRes = buildEdition({
      rootDir: REPO_ROOT,
      distDir: tempDist,
      edition: "store",
    });
    const communityRes = buildEdition({
      rootDir: REPO_ROOT,
      distDir: tempDist,
      edition: "community",
    });

    assert.deepEqual(storeRes.providers, ["official/baidu"]);
    assert.ok(communityRes.providers.includes("official/baidu"));
    assert.ok(communityRes.providers.includes("community/quark"));

    const storeManifest = JSON.parse(
      fs.readFileSync(path.join(storeRes.outDir, "manifest.json"), "utf8")
    );
    assert.equal(storeManifest.permissions.includes("cookies"), false);
    assert.equal(
      storeManifest.host_permissions.some((h) => h.includes("quark")),
      false
    );
    assert.equal(
      storeManifest.content_scripts.some((cs) =>
        cs.matches.some((m) => m.includes("quark"))
      ),
      false
    );

    const storePopupMod = await import(
      pathToFileURL(path.join(storeRes.outDir, "providers", "popup-index.js")).href
    );
    assert.deepEqual(Object.keys(storePopupMod.popupCardRenderers), []);

    const communityManifest = JSON.parse(
      fs.readFileSync(path.join(communityRes.outDir, "manifest.json"), "utf8")
    );
    assert.equal(communityManifest.permissions.includes("cookies"), true);
    assert.ok(communityManifest.host_permissions.includes("*://*.quark.cn/*"));
    assert.ok(
      communityManifest.content_scripts.some((cs) =>
        cs.matches.includes("https://pan.quark.cn/*")
      )
    );

    const communityPopupMod = await import(
      pathToFileURL(
        path.join(communityRes.outDir, "providers", "popup-index.js")
      ).href
    );
    assert.equal(typeof communityPopupMod.popupCardRenderers.quark, "function");
  } finally {
    fs.rmSync(tempDist, { recursive: true, force: true });
  }
});
