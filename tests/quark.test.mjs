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
  sanitizeCookieInput,
} from "../providers/community/quark/provider.js";
import { buildEdition } from "../scripts/build.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function createMockChrome(initialLocal = {}, mockCookies = []) {
  const localStore = { ...initialLocal };
  const sessionStore = {};
  let dynamicRules = [];
  const createdTabs = [];

  const mockChrome = {
    runtime: {
      id: "test-ext-id",
      getManifest: () => ({ version: "0.4.0" }),
      getURL: (p) => `chrome-extension://test-ext-id/${p.replace(/^\/+/, "")}`,
    },
    cookies: {
      getAll: async () => [...mockCookies],
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
    isAllowedQuarkDownloadUrl("https://cdn.uc.cn/file/demo.zip"),
    true
  );
  assert.equal(
    isAllowedQuarkDownloadUrl("https://pds.quark.cn.evil.com/demo.zip"),
    false
  );
  assert.equal(isAllowedQuarkDownloadUrl("https://evil.com/demo.zip"), false);
  assert.equal(isAllowedQuarkDownloadUrl("javascript:alert(1)"), false);
});

test("Quark DNR rules inject client UA for file/download and CDN without blocking pan.quark.cn iframe downloads", () => {
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
  assert.equal(pdsCdnRule.condition.excludedInitiatorDomains, undefined);
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
  assert.equal(driveCdnRule.condition.excludedInitiatorDomains, undefined);
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

    const loggedInRes = await runtime.handleMessage({
      type: "PANDIRECT_PROVIDER_AUTH_START",
      provider: "quark",
    });
    assert.equal(loggedInRes.ok, true);
    assert.equal(loggedInRes.authResult.loggedIn, true);
    assert.equal(loggedInRes.authResult.nickname, "夸克测试用户");
    assert.equal(state.createdTabs.length, 0);

    mockLoggedIn = false;
    const loggedOutRes = await runtime.handleMessage({
      type: "PANDIRECT_PROVIDER_AUTH_START",
      provider: "quark",
    });
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

    const listRes = await runtime.handleMessage({
      type: "PANDIRECT_LIST_FILES",
      provider: "quark",
      dir: "dir_movies",
    });
    assert.equal(listRes.ok, true);
    assert.equal(listRes.providerName, "夸克网盘");
    assert.equal(listRes.displayPath, "/电影合集");
    assert.equal(listRes.parentDir, "0");
    assert.equal(listRes.isRoot, false);
    assert.equal(listRes.files.length, 2);

    const recRes = await runtime.handleMessage({
      type: "PANDIRECT_LIST_FOLDER_RECURSIVE",
      provider: "quark",
      path: "dir_movies",
    });
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

  globalThis.fetch = async (url, init = {}) => {
    const strUrl = String(url);

    if (strUrl.includes("/1/clouddrive/file/download")) {
      assert.equal(init.method, "POST");
      assert.equal(init.credentials, "include");
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
    const dlRes = await runtime.handleMessage({
      type: "PANDIRECT_DOWNLOAD_ITEMS",
      provider: "quark",
      itemIds: ["fid_demo_1"],
      mode: "browser",
      preferFrameDownload: true,
    });
    assert.equal(dlRes.ok, true);
    assert.equal(dlRes.results[0].ok, true);
    assert.equal(preflightCredentials, "include");
    assert.ok(dlRes.results[0].frameDownloadUrl.includes("dl-pc-zb.pds.quark.cn"));

    // 2. Trusted downloader stream URL returns credentials: include
    const streamRes = await runtime.handleMessage(
      {
        type: "PANDIRECT_GET_FILE_STREAM_URL",
        provider: "quark",
        itemId: "fid_demo_1",
      },
      {
        id: "test-ext-id",
        url: "chrome-extension://test-ext-id/downloader/downloader.html",
      }
    );
    assert.equal(streamRes.ok, true);
    assert.equal(streamRes.credentials, "include");

    // 3. Aria2 push automatically forwards ephemeral browser session cookies without persisting them
    const { mockChrome: cookieChrome, state: cookieState } = createMockChrome(
      { enabled: true },
      [
        { name: "__puus", value: "live_session_puus" },
        { name: "__uid", value: "uid_123" },
      ]
    );
    globalThis.chrome = cookieChrome;
    const autoRuntime = createBackgroundRuntime([baiduProvider, quarkProvider]);

    const autoAriaRes = await autoRuntime.handleMessage({
      type: "PANDIRECT_PUSH_ITEM_TO_ARIA2",
      provider: "quark",
      itemId: "fid_demo_1",
      relativePath: "Movies/movie.mkv",
    });
    assert.equal(autoAriaRes.ok, true);
    assert.equal(autoAriaRes.gid, "gid_quark_01");
    const autoOpts = capturedAria2Body.params[1];
    assert.equal(autoOpts.out, "Movies/movie.mkv");
    assert.ok(
      autoOpts.header.some(
        (h) => h.startsWith("User-Agent: ") && h.includes("quark-cloud-drive/")
      )
    );
    assert.ok(autoOpts.header.includes("Referer: https://pan.quark.cn/"));
    assert.ok(
      autoOpts.header.includes("Cookie: __puus=live_session_puus; __uid=uid_123")
    );
    // Must NEVER persist auto-read browser cookies to storage
    assert.equal(cookieState.localStore.providerConfigs?.quark?.aria2Cookie, undefined);

    // 4. Refuse auto-sending browser session cookies to non-local public Aria2 RPC URLs
    await autoRuntime.handleMessage({
      type: "PANDIRECT_SET_CONFIG",
      aria2Url: "https://remote.example.com:6800/jsonrpc",
    });
    await assert.rejects(
      () =>
        autoRuntime.handleMessage({
          type: "PANDIRECT_PUSH_ITEM_TO_ARIA2",
          provider: "quark",
          itemId: "fid_demo_1",
        }),
      /安全保护/
    );

    // 5. Manual aria2Cookie override strips accidental "Cookie:" prefix and newlines
    assert.equal(
      sanitizeCookieInput("Cookie: __puus=abc\n; __uid=1 "),
      "__puus=abc ; __uid=1"
    );
    assert.equal(isTrustedLocalAria2Url("http://localhost:6800/jsonrpc"), true);
    assert.equal(isTrustedLocalAria2Url("http://127.0.0.1:16800/jsonrpc"), true);
    assert.equal(isTrustedLocalAria2Url("http://192.168.1.10:6800/jsonrpc"), true);
    assert.equal(isTrustedLocalAria2Url("https://evil.example/jsonrpc"), false);

    globalThis.chrome = mockChrome;
    await runtime.handleMessage({
      type: "PANDIRECT_SET_CONFIG",
      provider: "quark",
      providerConfig: { aria2Cookie: "Cookie: __puus=demo_cookie\n" },
    });
    const ariaRes = await runtime.handleMessage({
      type: "PANDIRECT_PUSH_ITEM_TO_ARIA2",
      provider: "quark",
      itemId: "fid_demo_1",
      relativePath: "Movies/movie.mkv",
    });
    assert.equal(ariaRes.ok, true);
    assert.ok(capturedAria2Body.params[1].header.includes("Cookie: __puus=demo_cookie"));

    // 6. code=23018 returns clear guidance
    simulate23018 = true;
    await assert.rejects(
      () =>
        runtime.handleMessage({
          type: "PANDIRECT_DOWNLOAD_ITEMS",
          provider: "quark",
          itemIds: ["fid_demo_1"],
          mode: "browser",
        }),
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
    assert.deepEqual(communityRes.providers, [
      "official/baidu",
      "community/quark",
    ]);

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
