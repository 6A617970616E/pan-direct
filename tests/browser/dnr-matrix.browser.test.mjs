/**
 * DNR scenario matrix, evaluated by Chrome's own rule matcher.
 *
 * Loads the root (dev) extension into real Chromium via Playwright, lets it sync
 * its provider-wide dynamic rules, then asks
 * chrome.declarativeNetRequest.testMatchOutcome() whether each hypothetical
 * request would have its headers modified.
 *
 * This catches "a header rule matches traffic it must not touch" regressions
 * (e.g. netdisk web uploads broken by download UA/Origin rewriting) without
 * logging in to any real netdisk account.
 *
 * Run: npm run test:browser
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";

import { launchExtension } from "./helpers.mjs";

const EXT = "__EXT__"; // replaced with chrome-extension://<id> at runtime

/**
 * expect:
 *   "none"      -> no rule may modify this request
 *   "modified"  -> at least one modifyHeaders rule must match
 *   { setHeader: "user-agent" } -> a matched rule must set that request header
 */
const SCENARIOS = [
  // ---------------------------------------------------------------- Baidu
  {
    name: "Baidu web upload: POST superfile2 from pan.baidu.com",
    request: { url: "https://c3.pcs.baidu.com/rest/2.0/pcs/superfile2?method=upload&path=%2Fa.bin", initiator: "https://pan.baidu.com", method: "post", type: "xmlhttprequest" },
    expect: "none",
  },
  {
    name: "Baidu web upload: CORS preflight OPTIONS from pan.baidu.com",
    request: { url: "https://c3.pcs.baidu.com/rest/2.0/pcs/superfile2?method=upload", initiator: "https://pan.baidu.com", method: "options", type: "other" },
    expect: "none",
  },
  {
    name: "Baidu web upload: GET locateupload from pan.baidu.com",
    request: { url: "https://d.pcs.baidu.com/rest/2.0/pcs/file?method=locateupload", initiator: "https://pan.baidu.com", method: "get", type: "xmlhttprequest" },
    expect: "none",
  },
  {
    name: "Baidu web preview: media GET from pan.baidu.com",
    request: { url: "https://allall01.baidupcs.com/file/video.mp4?sign=1", initiator: "https://pan.baidu.com", method: "get", type: "media" },
    expect: "none",
  },
  {
    name: "Baidu web upload: POST from yun.baidu.com",
    request: { url: "https://c.pcs.baidu.com/rest/2.0/pcs/superfile2?method=upload", initiator: "https://yun.baidu.com", method: "post", type: "xmlhttprequest" },
    expect: "none",
  },
  {
    name: "Baidu: top-level navigation to a dlink is not rewritten",
    request: { url: "https://d.pcs.baidu.com/file/abc?fid=1", method: "get", type: "main_frame" },
    expect: "none",
  },
  {
    name: "Baidu: extension POST to PCS is not rewritten",
    request: { url: "https://d.pcs.baidu.com/file/abc", initiator: EXT, method: "post", type: "xmlhttprequest" },
    expect: "none",
  },
  {
    name: "Baidu: service-worker GET preflight gets download UA",
    request: { url: "https://d.pcs.baidu.com/file/abc?fid=1", initiator: EXT, method: "get", type: "xmlhttprequest" },
    expect: { setHeader: "user-agent" },
  },
  {
    name: "Baidu: service-worker HEAD gets download UA",
    request: { url: "https://d.pcs.baidu.com/file/abc?fid=1", initiator: EXT, method: "head", type: "xmlhttprequest" },
    expect: { setHeader: "user-agent" },
  },
  {
    name: "Baidu: browser download without initiator gets download UA",
    request: { url: "https://allall01.baidupcs.com/file/abc?sign=1", method: "get", type: "other" },
    expect: { setHeader: "user-agent" },
  },
  {
    name: "Baidu: folder downloader stream fetch gets download UA",
    request: { url: "https://qd.pcsdata.baidu.com/file/abc?sign=1", initiator: EXT, method: "get", type: "xmlhttprequest" },
    expect: { setHeader: "user-agent" },
  },
  {
    name: "Baidu: third-party site GET on PCS is not rewritten",
    request: { url: "https://allall01.baidupcs.com/file/img.jpg", initiator: "https://example.com", method: "get", type: "xmlhttprequest" },
    expect: "none",
    // Known gap: base rules exclude only the netdisk pages, so other sites'
    // GET/HEAD requests to PCS hosts are still rewritten.
    todo: "base rules use excludedInitiatorDomains, not an extension-only allowlist",
  },

  // ---------------------------------------------------------------- Quark
  {
    name: "Quark web: POST to pds from pan.quark.cn",
    request: { url: "https://ul-zb.pds.quark.cn/upload?part=1", initiator: "https://pan.quark.cn", method: "post", type: "xmlhttprequest" },
    expect: "none",
  },
  {
    name: "Quark web: media preview from pan.quark.cn",
    request: { url: "https://video-h-1.pds.quark.cn/file/v.mp4", initiator: "https://pan.quark.cn", method: "get", type: "media" },
    expect: "none",
  },
  {
    name: "Quark web: GET regional node from drive.quark.cn",
    request: { url: "https://dl-pc-sz.drive.quark.cn/file/a.zip", initiator: "https://drive.quark.cn", method: "get", type: "xmlhttprequest" },
    expect: "none",
  },
  {
    name: "Quark web: page's own file/download API call is untouched",
    request: { url: "https://drive-pc.quark.cn/1/clouddrive/file/download?pr=ucpro", initiator: "https://pan.quark.cn", method: "post", type: "xmlhttprequest" },
    expect: "none",
  },
  {
    name: "Quark: extension POST file/download API gets desktop client UA",
    request: { url: "https://drive-pc.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc", initiator: EXT, method: "post", type: "xmlhttprequest" },
    expect: { setHeader: "user-agent" },
  },
  {
    name: "Quark: extension GET on pds CDN gets desktop client UA",
    request: { url: "https://dl-pc-zb.pds.quark.cn/download/a.mp4?Expires=1", initiator: EXT, method: "get", type: "xmlhttprequest" },
    expect: { setHeader: "user-agent" },
  },
  {
    name: "Quark: extension GET on regional drive node gets desktop client UA",
    request: { url: "https://dl-pc-sz.drive.quark.cn/file/a.zip", initiator: EXT, method: "get", type: "xmlhttprequest" },
    expect: { setHeader: "user-agent" },
  },
  {
    name: "Quark: extension account/info check gets Referer",
    request: { url: "https://pan.quark.cn/account/info?fr=pc", initiator: EXT, method: "get", type: "xmlhttprequest" },
    expect: { setHeader: "referer" },
  },

  // ---------------------------------------------------------------- Xunlei
  {
    name: "Xunlei web: page's own API calls are untouched",
    request: { url: "https://api-pan.xunlei.com/drive/v1/files?parent_id=", initiator: "https://pan.xunlei.com", method: "get", type: "xmlhttprequest" },
    expect: "none",
  },
  {
    name: "Xunlei web: POST to sdpan.cn from pan.xunlei.com",
    request: { url: "https://upload.sdpan.cn/put?x=1", initiator: "https://pan.xunlei.com", method: "post", type: "xmlhttprequest" },
    expect: "none",
  },
  {
    name: "Xunlei web: GET on shared CDN from pan.xunlei.com",
    request: { url: "https://xfile2.a.88cdn.com/file/abc", initiator: "https://pan.xunlei.com", method: "get", type: "media" },
    expect: "none",
  },
  {
    name: "Xunlei: third-party site GET on shared CDN is not rewritten",
    request: { url: "https://xfile2.a.88cdn.com/file/abc", initiator: "https://example.com", method: "get", type: "xmlhttprequest" },
    expect: "none",
  },
  {
    name: "Xunlei: extension POST on shared CDN is not rewritten",
    request: { url: "https://node1.xycdn.com/upload", initiator: EXT, method: "post", type: "xmlhttprequest" },
    expect: "none",
  },
  {
    name: "Xunlei: extension API call gets Origin/Referer",
    request: { url: "https://api-pan.xunlei.com/drive/v1/files/abc?usage=PLAY", initiator: EXT, method: "get", type: "xmlhttprequest" },
    expect: { setHeader: "origin" },
  },
  {
    name: "Xunlei: extension GET on sdpan.cn gets download UA",
    request: { url: "https://dcdnpc.sdpan.cn/file?e=1", initiator: EXT, method: "get", type: "xmlhttprequest" },
    expect: { setHeader: "user-agent" },
  },
  {
    name: "Xunlei: extension GET on shared CDN gets download UA",
    request: { url: "https://xfile2.a.88cdn.com/file/abc", initiator: EXT, method: "get", type: "xmlhttprequest" },
    expect: { setHeader: "user-agent" },
  },

  // ------------------------------------------------- Unrelated traffic
  {
    name: "Unrelated site traffic is never touched",
    request: { url: "https://www.example.com/upload", initiator: "https://www.example.com", method: "post", type: "xmlhttprequest" },
    expect: "none",
  },
];

let harness;
let ext;

before(async () => {
  harness = await launchExtension();
  ext = `chrome-extension://${harness.extensionId}`;
});

after(async () => {
  await harness?.close();
});

/** Runs testMatchOutcome and resolves matched rules to their full definitions. */
async function evaluateRequest(request) {
  const resolved = {
    ...request,
    ...(request.initiator === EXT ? { initiator: ext } : {}),
  };
  return harness.page.evaluate(async (req) => {
    const dnr = chrome.declarativeNetRequest;
    const [dynamicRules, sessionRules, outcome] = await Promise.all([
      dnr.getDynamicRules(),
      dnr.getSessionRules(),
      dnr.testMatchOutcome(req),
    ]);
    const byKey = new Map();
    for (const r of dynamicRules) byKey.set(`_dynamic:${r.id}`, r);
    for (const r of sessionRules) byKey.set(`_session:${r.id}`, r);
    return outcome.matchedRules.map((m) => ({
      key: `${m.rulesetId}:${m.ruleId}`,
      rule: byKey.get(`${m.rulesetId}:${m.ruleId}`) || null,
    }));
  }, resolved);
}

function describeMatches(matches) {
  return matches
    .map(({ key, rule }) => `${key} ${rule?.condition?.urlFilter || ""}`)
    .join(", ");
}

function assertExpectation(matches, expect, label) {
  const modifying = matches.filter(({ rule }) => rule?.action?.type === "modifyHeaders");
  if (expect === "none") {
    assert.equal(modifying.length, 0, `${label}: unexpected rules ${describeMatches(modifying)}`);
    return;
  }
  assert.ok(modifying.length > 0, `${label}: expected a modifyHeaders rule, none matched`);
  if (expect && typeof expect === "object" && expect.setHeader) {
    const sets = modifying.some(({ rule }) =>
      (rule.action.requestHeaders || []).some(
        (h) => h.header.toLowerCase() === expect.setHeader && h.operation === "set"
      )
    );
    assert.ok(sets, `${label}: no matched rule sets ${expect.setHeader} (${describeMatches(modifying)})`);
  }
}

for (const scenario of SCENARIOS) {
  test(scenario.name, { todo: scenario.todo }, async () => {
    const matches = await evaluateRequest(scenario.request);
    assertExpectation(matches, scenario.expect, scenario.name);
  });
}

// --------------------------------------------- Per-download session rules
//
// Installs real rules through core/dnr.js (imported inside the extension page),
// exactly as startBrowserDownload() does, then checks their reach.

async function installResolvedRule(options) {
  return harness.page.evaluate(async (opts) => {
    const { createDnrManager } = await import(chrome.runtime.getURL("core/dnr.js"));
    const { buildBaiduModifyRequestHeaders } = await import(
      chrome.runtime.getURL("providers/official/baidu/provider.js")
    );
    const dnr = createDnrManager({ list: () => [] }, {});
    const installed = await dnr.ensureResolvedHostRule({
      ...opts,
      requestHeaders: buildBaiduModifyRequestHeaders("pan.baidu.com"),
    });
    globalThis.__pdDnr = dnr;
    return installed;
  }, options);
}

async function cleanupResolved(url) {
  await harness.page.evaluate(async (u) => {
    await globalThis.__pdDnr.cleanupResolvedRulesForUrl(u);
  }, url);
  return harness.page.evaluate(async () =>
    (await chrome.declarativeNetRequest.getSessionRules()).length
  );
}

test("Hidden-iframe download rule reaches only that iframe request", async () => {
  const url = "https://allall01.baidupcs.com/file/frame.mp4?sign=abc&expires=1";
  const installed = await installResolvedRule({
    resolvedUrl: url,
    filename: "frame.mp4",
    forceAttachment: true,
    preferFrameDownload: true,
    initiatorDomains: ["pan.baidu.com"],
  });
  assert.ok(installed?.ruleId, "session rule was not installed");

  try {
    const frame = await evaluateRequest({ url, initiator: "https://pan.baidu.com", method: "get", type: "sub_frame" });
    assert.ok(frame.some((m) => m.key === `_session:${installed.ruleId}`), "iframe download must hit its session rule");
    const sessionRule = frame.find((m) => m.key === `_session:${installed.ruleId}`).rule;
    assert.match(sessionRule.action.responseHeaders?.[0]?.value || "", /frame\.mp4/);

    for (const [label, req] of [
      ["same path, other query", { url: url.replace("sign=abc", "sign=other"), initiator: "https://pan.baidu.com", method: "get", type: "sub_frame" }],
      ["page XHR to same URL", { url, initiator: "https://pan.baidu.com", method: "get", type: "xmlhttprequest" }],
      ["POST to same URL", { url, initiator: "https://pan.baidu.com", method: "post", type: "sub_frame" }],
      ["iframe from another site", { url, initiator: "https://evil.example", method: "get", type: "sub_frame" }],
      ["top-level navigation", { url, method: "get", type: "main_frame" }],
    ]) {
      const matches = await evaluateRequest(req);
      assert.equal(
        matches.some((m) => m.key === `_session:${installed.ruleId}`),
        false,
        `${label} must not hit the iframe session rule`
      );
    }
  } finally {
    assert.equal(await cleanupResolved(url), 0, "session rule must be removed after cleanup");
  }
});

test("Browser-download rule reaches the download request but not page uploads", async () => {
  const url = "https://allall01.baidupcs.com/file/direct.zip?sign=xyz";
  const installed = await installResolvedRule({
    resolvedUrl: url,
    filename: "direct.zip",
    forceAttachment: false,
    preferFrameDownload: false,
  });
  assert.ok(installed?.ruleId, "session rule was not installed");

  try {
    const download = await evaluateRequest({ url, method: "get", type: "other" });
    assert.ok(download.some((m) => m.key === `_session:${installed.ruleId}`), "download must hit its session rule");

    const upload = await evaluateRequest({ url, initiator: "https://pan.baidu.com", method: "post", type: "xmlhttprequest" });
    assert.equal(upload.some((m) => m.key === `_session:${installed.ruleId}`), false);
  } finally {
    assert.equal(await cleanupResolved(url), 0);
  }
});
