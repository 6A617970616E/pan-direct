import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createBackgroundRuntime } from "../core/background-router.js";
import { baiduProvider } from "../providers/official/baidu/provider.js";
import { quarkProvider } from "../providers/community/quark/provider.js";
import {
  xunleiProvider,
  DEFAULT_XUNLEI_USER_AGENT,
  XUNLEI_SESSION_STORAGE_KEY,
  XUNLEI_READ_SESSION_MESSAGE,
  normalizeXunleiDirId,
  isXunleiDirItem,
  isAllowedXunleiDownloadUrl,
  sanitizeXunleiSession,
  extractXunleiDownloadLink,
  formatXunleiApiError,
} from "../providers/community/xunlei/provider.js";
import { buildEdition } from "../scripts/build.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const POPUP_SENDER = {
  id: "test-ext-id",
  url: "chrome-extension://test-ext-id/popup/popup.html",
};

const DOWNLOADER_SENDER = {
  id: "test-ext-id",
  url: "chrome-extension://test-ext-id/downloader/downloader.html",
};

const XUNLEI_TAB_SENDER = {
  id: "test-ext-id",
  tab: { url: "https://pan.xunlei.com/?path=%2F" },
};

function createChromeMock({ openTabs = [], tabSessionResponses = {} } = {}) {
  const localStore = {};
  const sessionStore = {};
  let dynamicRules = [];
  let sessionRules = [];
  const createdTabs = [];
  const downloads = [];
  const sentTabMessages = [];

  globalThis.chrome = {
    runtime: {
      id: "test-ext-id",
      getManifest: () => ({ version: "0.4.0" }),
      getURL: (p) => `chrome-extension://test-ext-id/${p}`,
    },
    storage: {
      local: {
        get: async (keys) => {
          if (Array.isArray(keys)) {
            const res = {};
            for (const k of keys) res[k] = localStore[k];
            return res;
          }
          if (typeof keys === "string") {
            return { [keys]: localStore[keys] };
          }
          if (keys && typeof keys === "object") {
            const res = {};
            for (const [k, defVal] of Object.entries(keys)) {
              res[k] = k in localStore ? localStore[k] : defVal;
            }
            return res;
          }
          return { ...localStore };
        },
        set: async (obj) => {
          Object.assign(localStore, obj);
        },
        remove: async (keys) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            delete localStore[k];
          }
        },
      },
      session: {
        get: async (keys) => {
          const res = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            res[k] = sessionStore[k];
          }
          return res;
        },
        set: async (obj) => {
          Object.assign(sessionStore, obj);
        },
        remove: async (keys) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            delete sessionStore[k];
          }
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
      query: async () => openTabs,
      sendMessage: async (tabId, msg) => {
        sentTabMessages.push({ tabId, msg });
        const handler = tabSessionResponses[tabId];
        if (typeof handler === "function") return handler(msg);
        if (handler !== undefined) return handler;
        throw new Error("Could not establish connection. Receiving end does not exist.");
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
    localStore,
    sessionStore,
    getDynamicRules: () => dynamicRules,
    getSessionRules: () => sessionRules,
    createdTabs,
    downloads,
    sentTabMessages,
  };
}

test("Xunlei helper utilities validate dir IDs, folder flags, CDN URL allowlist, session sanitization, and link extraction", () => {
  assert.equal(normalizeXunleiDirId(""), "");
  assert.equal(normalizeXunleiDirId("/"), "");
  assert.equal(normalizeXunleiDirId("0"), "");
  assert.equal(normalizeXunleiDirId("fid:0"), "");
  assert.equal(normalizeXunleiDirId("VOabc123XYZ"), "VOabc123XYZ");
  assert.equal(normalizeXunleiDirId("fid:VOabc123XYZ"), "VOabc123XYZ");

  assert.equal(isXunleiDirItem({ kind: "drive#folder" }), true);
  assert.equal(isXunleiDirItem({ kind: "drive#file" }), false);
  assert.equal(isXunleiDirItem({ file_category: "FOLDER" }), true);
  assert.equal(isXunleiDirItem({ is_dir: true }), true);

  // Official Xunlei CDN domains allowed
  assert.equal(
    isAllowedXunleiDownloadUrl("https://vod0001-sz.xunlei.com/download/?fid=1&e=999"),
    true
  );
  assert.equal(
    isAllowedXunleiDownloadUrl("https://dcdnpc.sdpan.cn/file?e=1791204766"),
    true
  );
  assert.equal(
    isAllowedXunleiDownloadUrl("https://dl.sandai.net/abc.bin"),
    true
  );
  assert.equal(
    isAllowedXunleiDownloadUrl("https://xfile2.a.88cdn.com/file/abc"),
    true
  );
  assert.equal(
    isAllowedXunleiDownloadUrl("https://node1.xycdn.com/download/abc"),
    true
  );

  // Untrusted domains & non-HTTP schemes rejected
  assert.equal(isAllowedXunleiDownloadUrl("https://evil.com/xunlei.com/a"), false);
  assert.equal(isAllowedXunleiDownloadUrl("https://xunlei.com.evil.com/a"), false);
  assert.equal(isAllowedXunleiDownloadUrl("javascript:alert(1)"), false);

  // Session sanitization strips newlines, ensures Bearer prefix, extracts 32-hex deviceId
  const clean = sanitizeXunleiSession({
    authorization: "tok_abc\r\nX-Evil: 1",
    captchaToken: "cap_123\n",
    deviceId: "wdi10.0123456789abcdef0123456789abcdef.extra,second",
    clientId: "Xqp0kJBXWhwaTpB6",
    userId: "924119402",
  });
  assert.equal(clean.authorization, "Bearer tok_abcX-Evil: 1");
  assert.equal(clean.captchaToken, "cap_123");
  assert.equal(clean.deviceId, "0123456789abcdef0123456789abcdef");
  assert.equal(clean.clientId, "Xqp0kJBXWhwaTpB6");
  assert.equal(clean.userId, "924119402");
  assert.equal(sanitizeXunleiSession({ authorization: "" }), null);

  // Download link extraction priority: web_content_link -> links -> medias (origin -> non-VIP -> VIP error)
  assert.equal(
    extractXunleiDownloadLink({
      size: "2048",
      web_content_link: "https://dcdnpc.sdpan.cn/direct?e=123",
      links: { "application/octet-stream": { url: "https://vod0001.xunlei.com/download/a" } },
    }).url,
    "https://dcdnpc.sdpan.cn/direct?e=123"
  );
  assert.equal(
    extractXunleiDownloadLink({
      size: "4096",
      web_content_link: "",
      links: { "application/octet-stream": { url: "https://vod0001.xunlei.com/download/stream" } },
    }).url,
    "https://vod0001.xunlei.com/download/stream"
  );
  assert.equal(
    extractXunleiDownloadLink({
      size: "8192",
      medias: [
        { category: "category_sd", link: { url: "https://vod.xunlei.com/sd" } },
        { is_origin: true, link: { url: "https://vod.xunlei.com/origin" } },
      ],
    }).url,
    "https://vod.xunlei.com/origin"
  );
  const vipOnly = extractXunleiDownloadLink({
    size: "8192",
    medias: [
      {
        category: "category_origin",
        need_more_quota: true,
        vip_types: ["SVIP"],
        link: { url: "https://vod.xunlei.com/vip" },
      },
    ],
  });
  assert.equal(vipOnly.url, null);
  assert.match(vipOnly.error, /SVIP/);

  // Error formatting
  assert.match(formatXunleiApiError(400, 9, "captcha_invalid", ""), /X-Captcha-Token/);
  assert.match(formatXunleiApiError(401, 16, "unauthenticated", ""), /pan\.xunlei\.com/);
  assert.match(formatXunleiApiError(400, 0, "review_panel", ""), /安全验证/);
});

test("Xunlei syncSession rejects untrusted origins and keeps tokens strictly in chrome.storage.session (never local)", async () => {
  const mock = createChromeMock();
  const runtime = createBackgroundRuntime([baiduProvider, quarkProvider, xunleiProvider]);

  await assert.rejects(
    () =>
      runtime.handleMessage(
        {
          type: "PANDIRECT_PROVIDER_SYNC_SESSION",
          provider: "xunlei",
          session: { authorization: "Bearer stolen" },
        },
        { id: "test-ext-id", tab: { url: "https://evil.example.com/" } }
      ),
    /未授权/
  );
  // Missing sender URL must fail closed as well
  await assert.rejects(
    () => xunleiProvider.syncSession({ authorization: "Bearer stolen" }, {}, {}),
    /未授权/
  );
  assert.equal(mock.sessionStore[XUNLEI_SESSION_STORAGE_KEY], undefined);

  const syncRes = await runtime.handleMessage(
    {
      type: "PANDIRECT_PROVIDER_SYNC_SESSION",
      provider: "xunlei",
      session: {
        authorization: "Bearer xl_live_access_token",
        captchaToken: "xl_live_captcha",
        deviceId: "abcdef0123456789abcdef0123456789",
        clientId: "Xqp0kJBXWhwaTpB6",
        userId: "924119402",
        nickname: "迅雷测试用户",
      },
    },
    XUNLEI_TAB_SENDER
  );

  assert.equal(syncRes.ok, true);
  assert.equal(syncRes.loggedIn, true);
  assert.equal(syncRes.nickname, "迅雷测试用户");

  // Token is ONLY in session storage
  assert.equal(
    mock.sessionStore[XUNLEI_SESSION_STORAGE_KEY].authorization,
    "Bearer xl_live_access_token"
  );

  // Zero tokens leaked into persistent chrome.storage.local
  const localDump = JSON.stringify(mock.localStore);
  assert.equal(localDump.includes("xl_live_access_token"), false);
  assert.equal(localDump.includes("xl_live_captcha"), false);
  assert.equal(mock.localStore.providerConfigs.xunlei.loggedIn, true);
  assert.equal(mock.localStore.providerConfigs.xunlei.nickname, "迅雷测试用户");

  // Logout wipes chrome.storage.session & resets status
  const logoutRes = await runtime.handleMessage(
    {
      type: "PANDIRECT_PROVIDER_AUTH_LOGOUT",
      provider: "xunlei",
    },
    POPUP_SENDER
  );
  assert.equal(logoutRes.ok, true);
  assert.equal(mock.sessionStore[XUNLEI_SESSION_STORAGE_KEY], undefined);
  assert.equal(mock.localStore.providerConfigs.xunlei.loggedIn, false);
});

test("Xunlei DNR rules use 3000+ IDs, preserve pan.xunlei.com browsing, and scope shared CDN rules to extension", async () => {
  const mock = createChromeMock();
  const runtime = createBackgroundRuntime([baiduProvider, quarkProvider, xunleiProvider]);

  await runtime.dnr.syncAllDnrRules();
  const rules = mock.getDynamicRules();
  const xunleiRules = rules.filter((r) => r.id >= 3000 && r.id < 4000);
  assert.ok(xunleiRules.length >= 4);

  const apiRule = xunleiRules.find((r) =>
    r.condition.urlFilter.includes("api-pan.xunlei.com/drive/v1/")
  );
  assert.ok(apiRule);
  assert.deepEqual(apiRule.condition.excludedInitiatorDomains, ["pan.xunlei.com"]);

  const sdpanRule = xunleiRules.find((r) => r.condition.urlFilter === "||sdpan.cn/");
  assert.ok(sdpanRule);
  assert.deepEqual(sdpanRule.condition.excludedInitiatorDomains, ["pan.xunlei.com"]);
  assert.deepEqual(sdpanRule.condition.requestMethods, ["get", "head"]);
  assert.equal(sdpanRule.condition.resourceTypes.includes("main_frame"), false);
  const uaHeader = sdpanRule.action.requestHeaders.find((h) => h.header === "user-agent");
  assert.equal(uaHeader.value, DEFAULT_XUNLEI_USER_AGENT);

  for (const sharedFilter of [
    "||88cdn.com/",
    "||p2cdn.com/",
    "||xycdn.com/",
    "||sandai.net/",
    "||xlpan.com/",
    "||onethingpcs.com/",
  ]) {
    const rule = xunleiRules.find((r) => r.condition.urlFilter === sharedFilter);
    assert.ok(rule, `Expected rule for ${sharedFilter}`);
    assert.deepEqual(rule.condition.initiatorDomains, ["test-ext-id"]);
    assert.deepEqual(rule.condition.requestMethods, ["get", "head"]);
    assert.deepEqual(rule.condition.resourceTypes, ["xmlhttprequest", "other"]);
  }
});

test("Xunlei startAuth verifies live tab session, opens pan.xunlei.com when logged out, and supports listFiles + listFolderRecursive", async () => {
  const originalFetch = globalThis.fetch;
  let loggedInSession = null;

  const mock = createChromeMock({
    openTabs: [{ id: 42, active: true, url: "https://pan.xunlei.com/" }],
    tabSessionResponses: {
      42: () => ({ ok: Boolean(loggedInSession), session: loggedInSession }),
    },
  });

  const runtime = createBackgroundRuntime([baiduProvider, quarkProvider, xunleiProvider]);
  const apiCalls = [];

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    apiCalls.push({ url: u, headers: init.headers || {} });

    if (u.startsWith("https://api-pan.xunlei.com/drive/v1/files?")) {
      const parsed = new URL(u);
      const parentId = parsed.searchParams.get("parent_id") || "";
      const pageToken = parsed.searchParams.get("page_token") || "";
      const limit = Number(parsed.searchParams.get("limit")) || 100;

      if (limit === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ kind: "drive#fileList", files: [] }),
        };
      }

      if (parentId === "" && pageToken === "") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            kind: "drive#fileList",
            next_page_token: "page_2_cursor",
            files: [
              { id: "file_root_1", name: "notes.txt", kind: "drive#file", size: "120" },
              { id: "dir_movies", name: "Movies", kind: "drive#folder", size: "0" },
            ],
          }),
        };
      }

      if (parentId === "" && pageToken === "page_2_cursor") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            kind: "drive#fileList",
            next_page_token: "",
            files: [
              { id: "file_root_2", name: "archive.zip", kind: "drive#file", size: "5000" },
              { id: "trashed_1", name: "old.bin", kind: "drive#file", size: "99", trashed: true },
            ],
          }),
        };
      }

      if (parentId === "dir_movies") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            kind: "drive#fileList",
            next_page_token: "",
            files: [
              { id: "dir_scifi", name: "SciFi", kind: "drive#folder", size: "0" },
              { id: "file_mv_1", name: "trailer.mp4", kind: "drive#file", size: "4096" },
            ],
          }),
        };
      }

      if (parentId === "dir_scifi") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            kind: "drive#fileList",
            next_page_token: "",
            files: [
              { id: "file_mv_2", name: "dune.mkv", kind: "drive#file", size: "8192" },
            ],
          }),
        };
      }
    }

    if (u.startsWith("https://api-pan.xunlei.com/drive/v1/files/dir_movies")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "dir_movies",
          parent_id: "",
          name: "Movies",
          kind: "drive#folder",
          size: "0",
        }),
      };
    }

    throw new Error(`Unexpected fetch URL: ${u}`);
  };

  try {
    // Logged out -> opens pan.xunlei.com tab
    const outRes = await runtime.handleMessage(
      {
        type: "PANDIRECT_PROVIDER_AUTH_START",
        provider: "xunlei",
        openLoginIfNeeded: true,
      },
      POPUP_SENDER
    );
    assert.equal(outRes.ok, true);
    assert.equal(outRes.authResult.loggedIn, false);
    assert.equal(outRes.authResult.openedLoginTab, true);
    assert.equal(mock.createdTabs[0].url, "https://pan.xunlei.com/");

    // Logged in -> reads live session from open tab and verifies API
    loggedInSession = {
      authorization: "Bearer xl_token_live_1",
      captchaToken: "cap_live_1",
      deviceId: "11112222333344445555666677778888",
      clientId: "Xqp0kJBXWhwaTpB6",
      userId: "924119402",
      nickname: "JayXunlei",
    };

    const inRes = await runtime.handleMessage(
      {
        type: "PANDIRECT_PROVIDER_AUTH_START",
        provider: "xunlei",
        openLoginIfNeeded: true,
      },
      POPUP_SENDER
    );
    assert.equal(inRes.ok, true);
    assert.equal(inRes.authResult.loggedIn, true);
    assert.equal(inRes.authResult.nickname, "JayXunlei");
    assert.equal(mock.sentTabMessages.some((m) => m.msg.type === XUNLEI_READ_SESSION_MESSAGE), true);

    // List root files with cursor pagination (folders sorted first, trashed filtered out)
    const listRes = await runtime.handleMessage(
      {
        type: "PANDIRECT_LIST_FILES",
        provider: "xunlei",
        dir: "0",
      },
      XUNLEI_TAB_SENDER
    );
    assert.equal(listRes.ok, true);
    assert.equal(listRes.dir, "0");
    assert.equal(listRes.isRoot, true);
    assert.equal(listRes.files.length, 3);
    assert.equal(listRes.files[0].id, "dir_movies");
    assert.equal(listRes.files[0].isdir, true);
    assert.equal(listRes.files[1].name, "notes.txt");
    assert.equal(listRes.files[2].name, "archive.zip");

    // Recursive BFS folder scan
    const recRes = await runtime.handleMessage(
      {
        type: "PANDIRECT_LIST_FOLDER_RECURSIVE",
        provider: "xunlei",
        path: "dir_movies",
      },
      DOWNLOADER_SENDER
    );
    assert.equal(recRes.ok, true);
    assert.equal(recRes.folderName, "Movies");
    assert.equal(recRes.dirsScanned, 2);
    assert.equal(recRes.totalSize, 4096 + 8192);
    assert.deepEqual(
      recRes.files.map((f) => f.relativePath),
      ["Movies/trailer.mp4", "Movies/SciFi/dune.mkv"]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Xunlei resolveDownloadTargets uses PLAY (with CONSUME fallback), auto-retries on captcha_invalid via live tab, forces attachment DNR, and pushes to Aria2 without cookies", async () => {
  const originalFetch = globalThis.fetch;
  let tabCaptchaVersion = 1;
  const aria2Requests = [];

  const mock = createChromeMock({
    openTabs: [{ id: 9, active: true, url: "https://pan.xunlei.com/" }],
    tabSessionResponses: {
      9: () => ({
        ok: true,
        session: {
          authorization: "Bearer xl_token_dl",
          captchaToken: `cap_v${tabCaptchaVersion}`,
          deviceId: "aaaabbbbccccddddeeeeffff00001111",
          clientId: "Xqp0kJBXWhwaTpB6",
        },
      }),
    },
  });

  // Pre-seed stale v1 session in chrome.storage.session
  mock.sessionStore[XUNLEI_SESSION_STORAGE_KEY] = {
    authorization: "Bearer xl_token_dl",
    captchaToken: "cap_v1",
    deviceId: "aaaabbbbccccddddeeeeffff00001111",
    clientId: "Xqp0kJBXWhwaTpB6",
    syncedAt: Date.now(),
  };

  const runtime = createBackgroundRuntime([baiduProvider, quarkProvider, xunleiProvider]);
  await runtime.storage.setCoreConfig({
    aria2Url: "http://127.0.0.1:6800/jsonrpc",
    aria2Secret: "mysecret",
  });

  let playCallsForArchive = 0;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);

    // 1. Archive file: first call fails with error_code=9 (captcha_invalid), then tab rotates to cap_v2 and succeeds on PLAY!
    if (u.startsWith("https://api-pan.xunlei.com/drive/v1/files/fid_zip_1")) {
      playCallsForArchive++;
      if (init.headers["X-Captcha-Token"] === "cap_v1") {
        tabCaptchaVersion = 2;
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error_code: 9,
            error: "captcha_invalid",
            error_description: "captcha token expired",
          }),
        };
      }
      assert.equal(init.headers["X-Captcha-Token"], "cap_v2");
      assert.match(u, /usage=PLAY/);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "fid_zip_1",
          name: "project.zip",
          kind: "drive#file",
          size: "102400",
          web_content_link: "https://dcdnpc.sdpan.cn/dl/project?e=1799999999",
        }),
      };
    }

    // 2. Fallback file: PLAY returns empty link -> falls back to CONSUME!
    if (u.startsWith("https://api-pan.xunlei.com/drive/v1/files/fid_fallback_2")) {
      if (u.includes("usage=PLAY")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "fid_fallback_2",
            name: "doc.pdf",
            kind: "drive#file",
            size: "2048",
            web_content_link: "",
          }),
        };
      }
      assert.match(u, /usage=CONSUME/);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "fid_fallback_2",
          name: "doc.pdf",
          kind: "drive#file",
          size: "2048",
          web_content_link: "https://vod0001-sz.xunlei.com/download/?fid=fid_fallback_2",
        }),
      };
    }

    // 3. 1-byte Range preflight on sdpan CDN (returns NO Content-Disposition, matching real Xunlei CDN!)
    if (u.startsWith("https://dcdnpc.sdpan.cn/dl/project")) {
      assert.equal(init.headers.Range, "bytes=0-0");
      assert.equal(init.credentials, "omit");
      return {
        ok: true,
        status: 206,
        url: "https://edge-08.sdpan.cn/dl/project?e=1799999999",
        headers: { get: () => "" },
        body: { cancel: async () => {} },
      };
    }

    // 4. Local Aria2 JSON-RPC push
    if (u === "http://127.0.0.1:6800/jsonrpc") {
      const payload = JSON.parse(init.body);
      aria2Requests.push(payload);
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: payload.id, jsonrpc: "2.0", result: "gid_xl_001" }),
      };
    }

    throw new Error(`Unexpected fetch URL: ${u}`);
  };

  try {
    // Browser hidden-iframe download triggers captcha retry + exact-URL ephemeral session attachment DNR rule
    const dlRes = await runtime.handleMessage(
      {
        type: "PANDIRECT_DOWNLOAD_ITEMS",
        provider: "xunlei",
        itemIds: ["fid_zip_1"],
        mode: "browser",
        preferFrameDownload: true,
      },
      XUNLEI_TAB_SENDER
    );
    assert.equal(dlRes.ok, true);
    assert.equal(playCallsForArchive, 2);
    assert.equal(dlRes.results[0].ok, true);
    assert.equal(
      dlRes.results[0].frameDownloadUrl,
      "https://edge-08.sdpan.cn/dl/project?e=1799999999"
    );

    const resolvedSessionRule = mock
      .getSessionRules()
      .find(
        (r) =>
          r.condition.urlFilter ===
          "|https://edge-08.sdpan.cn/dl/project?e=1799999999|"
      );
    assert.ok(resolvedSessionRule);
    assert.deepEqual(resolvedSessionRule.condition.resourceTypes, ["sub_frame"]);
    assert.deepEqual(resolvedSessionRule.condition.initiatorDomains, ["pan.xunlei.com"]);
    assert.ok(
      resolvedSessionRule.action.responseHeaders?.some(
        (h) =>
          h.header === "content-disposition" &&
          h.value.includes("attachment") &&
          h.value.includes("project.zip")
      )
    );
    // Ephemeral rule must NOT leak into persistent dynamic rules
    assert.equal(
      mock.getDynamicRules().some((r) => r.id >= 9001),
      false
    );

    // Aria2 push on fallback file (CONSUME fallback + UA/Referer headers, NO Cookie header)
    const ariaRes = await runtime.handleMessage(
      {
        type: "PANDIRECT_PUSH_ITEM_TO_ARIA2",
        provider: "xunlei",
        itemId: "fid_fallback_2",
        relativePath: "Docs/doc.pdf",
      },
      DOWNLOADER_SENDER
    );
    assert.equal(ariaRes.ok, true);
    assert.equal(ariaRes.gid, "gid_xl_001");
    assert.equal(aria2Requests.length, 1);
    const rpcOptions = aria2Requests[0].params[2];
    assert.equal(rpcOptions.out, "Docs/doc.pdf");
    assert.equal(rpcOptions["user-agent"], DEFAULT_XUNLEI_USER_AGENT);
    assert.equal(rpcOptions.referer, "https://pan.xunlei.com/");
    assert.equal(rpcOptions.header, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Xunlei content.js syncs localStorage session, responds to live session reads, parses xlPanHomeRoutes, extracts rows, and injects menu-only shortcut", () => {
  const contentScript = fs.readFileSync(
    path.join(REPO_ROOT, "providers", "community", "xunlei", "content.js"),
    "utf8"
  );

  const storageData = new Map([
    [
      "credentials_Xqp0kJBXWhwaTpB6",
      JSON.stringify({
        token_type: "Bearer",
        access_token: "xl_acc_tok_999",
        sub: "924119402",
      }),
    ],
    [
      "captcha_Xqp0kJBXWhwaTpB6",
      JSON.stringify({ token: "xl_cap_tok_888" }),
    ],
    ["deviceid", "wdi10.0123456789abcdef0123456789abcdef.xyz"],
    [
      "xlPanHomeRoutes",
      JSON.stringify({
        "/Movies/SciFi": "root_xl/movies_xl/scifi_xl",
      }),
    ],
  ]);

  const fakeLocalStorage = {
    get length() {
      return storageData.size;
    },
    key: (i) => Array.from(storageData.keys())[i] ?? null,
    getItem: (k) => (storageData.has(k) ? storageData.get(k) : null),
  };

  let mountedAdapter = null;
  let onMessageListener = null;
  const sentMessages = [];

  const fakeChrome = {
    runtime: {
      sendMessage: (msg, cb) => {
        sentMessages.push(msg);
        if (cb) cb({ ok: true });
      },
      onMessage: {
        addListener: (fn) => {
          onMessageListener = fn;
        },
      },
    },
  };

  const fakeWindow = {
    location: {
      pathname: "/",
      search: "?path=%2FMovies%2FSciFi",
      hash: "",
    },
    localStorage: fakeLocalStorage,
    addEventListener: () => {},
    PanDirectDrawer: {
      mount: (adapter) => {
        mountedAdapter = adapter;
      },
    },
  };

  const fakeFileRow = {
    nodeType: 1,
    tagName: "LI",
    className: "SourceListItem__item--abc SourceListItem__active--def",
    getAttribute: (k) => (k === "data-file-id" ? "VOfileId123456" : null),
    dataset: { fileId: "VOfileId123456" },
    closest: (sel) => (sel.includes("data-file-id") ? fakeFileRow : null),
    querySelector: (sel) => {
      if (sel.includes("checkbox")) return { checked: true };
      if (sel.includes("SourceListItem__size")) return { textContent: "12.5 MB" };
      if (sel.includes("SourceListItem__name")) {
        return { getAttribute: () => "demo_video.mp4", textContent: "demo_video.mp4" };
      }
      return null;
    },
  };

  const fakeFolderRow = {
    nodeType: 1,
    tagName: "LI",
    className: "SourceListItem__item--abc",
    getAttribute: (k) => (k === "data-file-id" ? "VOfolderId9876" : null),
    dataset: { fileId: "VOfolderId9876" },
    closest: (sel) => (sel.includes("data-file-id") ? fakeFolderRow : null),
    querySelector: (sel) => {
      if (sel.includes("checkbox")) return null;
      if (sel.includes("SourceListItem__size")) return { textContent: "-" };
      if (sel.includes("SourceListItem__name")) {
        return { getAttribute: () => "Season 1", textContent: "Season 1" };
      }
      return null;
    },
  };

  const fakeDocument = {
    addEventListener: () => {},
    querySelectorAll: () => [fakeFileRow, fakeFolderRow],
  };

  vm.runInNewContext(contentScript, {
    window: fakeWindow,
    document: fakeDocument,
    chrome: fakeChrome,
    URLSearchParams,
  });

  assert.ok(mountedAdapter);
  assert.equal(mountedAdapter.providerId, "xunlei");
  assert.equal(mountedAdapter.rootDir, "0");
  assert.equal(mountedAdapter.idIsFolderPath, true);
  assert.equal(mountedAdapter.inlineActions?.findToolbarAnchors, undefined);

  // Initial localStorage sync pushed to background
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].type, "PANDIRECT_PROVIDER_SYNC_SESSION");
  assert.equal(sentMessages[0].provider, "xunlei");
  assert.equal(sentMessages[0].session.authorization, "Bearer xl_acc_tok_999");
  assert.equal(sentMessages[0].session.captchaToken, "xl_cap_tok_888");
  assert.equal(sentMessages[0].session.deviceId, "0123456789abcdef0123456789abcdef");

  // On-demand live session read from background SW
  assert.equal(typeof onMessageListener, "function");
  let liveReply = null;
  onMessageListener({ type: XUNLEI_READ_SESSION_MESSAGE }, {}, (res) => {
    liveReply = res;
  });
  assert.equal(liveReply.ok, true);
  assert.equal(liveReply.session.authorization, "Bearer xl_acc_tok_999");

  // Multi-level xlPanHomeRoutes folder resolution
  assert.deepEqual(JSON.parse(JSON.stringify(mountedAdapter.getCurrentDir())), {
    dir: "scifi_xl",
    displayPath: "/Movies/SciFi",
  });

  // Root route
  fakeWindow.location.search = "";
  assert.deepEqual(JSON.parse(JSON.stringify(mountedAdapter.getCurrentDir())), {
    dir: "0",
    displayPath: "/",
  });

  // Selected row extraction
  assert.deepEqual(
    JSON.parse(JSON.stringify(mountedAdapter.getSelectedItemsFromDom())),
    {
      ids: ["VOfileId123456"],
      names: ["demo_video.mp4"],
    }
  );

  // Row context detection (including folder size === "-")
  const mockMoreBtn = {
    nodeType: 1,
    tagName: "BUTTON",
    closest: (sel) => {
      if (sel.includes("more")) return mockMoreBtn;
      if (sel.includes("data-file-id")) return fakeFolderRow;
      return null;
    },
  };
  const rowCtx = mountedAdapter.inlineActions.resolveRowContextFromTarget(mockMoreBtn);
  assert.ok(rowCtx);
  assert.equal(rowCtx.isMoreTrigger, true);
  assert.deepEqual(JSON.parse(JSON.stringify(rowCtx.item)), {
    id: "VOfolderId9876",
    name: "Season 1",
    isdir: true,
  });

  // Three-dots dropdown menu anchor detection
  const mockDropdown = {
    tagName: "UL",
    closest: () => null,
  };
  const mockItemDownload = {
    tagName: "LI",
    textContent: "下载",
    parentElement: mockDropdown,
    closest: () => null,
    getBoundingClientRect: () => ({ top: 100, left: 200, width: 120, height: 32 }),
  };
  const mockItemRename = {
    tagName: "LI",
    textContent: "重命名",
    parentElement: mockDropdown,
    closest: () => null,
    getBoundingClientRect: () => ({ top: 132, left: 200, width: 120, height: 32 }),
  };

  const mockMenuDoc = {
    body: {},
    querySelectorAll: () => [mockItemDownload, mockItemRename],
  };

  const anchors = mountedAdapter.inlineActions.findMenuAnchors(mockMenuDoc);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].anchor, mockItemDownload);
  assert.equal(anchors[0].insertPosition, "beforebegin");
  assert.equal(anchors[0].itemTag, "li");
});

test("Real repo dual-artifact build keeps Xunlei 100% out of store.zip and wires it into community.zip", async () => {
  const tempDist = fs.mkdtempSync(path.join(os.tmpdir(), "pandirect-xunlei-dist-"));
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
      "community/xunlei",
    ]);

    // Store build must have zero references to xunlei / quark / cookies
    const storeManifest = JSON.parse(
      fs.readFileSync(path.join(storeRes.outDir, "manifest.json"), "utf8")
    );
    assert.equal(storeManifest.permissions.includes("cookies"), false);
    assert.equal(
      storeManifest.host_permissions.some((h) => /xunlei|sdpan|sandai/i.test(h)),
      false
    );
    assert.equal(
      storeManifest.content_scripts.some((cs) =>
        cs.matches.some((m) => m.includes("xunlei"))
      ),
      false
    );

    const storePopupMod = await import(
      pathToFileURL(path.join(storeRes.outDir, "providers", "popup-index.js")).href
    );
    assert.deepEqual(Object.keys(storePopupMod.popupCardRenderers), []);

    // Community build wires xunlei provider, host permissions, content_scripts, and popup card
    const communityManifest = JSON.parse(
      fs.readFileSync(path.join(communityRes.outDir, "manifest.json"), "utf8")
    );
    assert.ok(communityManifest.host_permissions.includes("*://*.xunlei.com/*"));
    assert.ok(communityManifest.host_permissions.includes("*://*.sdpan.cn/*"));
    assert.ok(
      communityManifest.content_scripts.some((cs) =>
        cs.matches.includes("https://pan.xunlei.com/*")
      )
    );

    const communityPopupMod = await import(
      pathToFileURL(
        path.join(communityRes.outDir, "providers", "popup-index.js")
      ).href
    );
    assert.equal(typeof communityPopupMod.popupCardRenderers.xunlei, "function");
  } finally {
    fs.rmSync(tempDist, { recursive: true, force: true });
  }
});
