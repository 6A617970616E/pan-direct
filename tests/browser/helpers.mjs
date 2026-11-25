import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

const RUNTIME_ITEMS = [
  "manifest.json",
  "background.js",
  "core",
  "providers",
  "popup",
  "downloader",
  "icons",
];

/**
 * Copies the root (dev) extension into a temp dir, adds the dev-only
 * `declarativeNetRequestFeedback` permission (needed for testMatchOutcome)
 * and a blank extension page used as the test harness.
 */
export function prepareExtensionCopy({
  rootDir = process.env.PANDIRECT_EXT_ROOT || REPO_ROOT,
} = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pandirect-ext-"));
  for (const item of RUNTIME_ITEMS) {
    fs.cpSync(path.join(rootDir, item), path.join(outDir, item), {
      recursive: true,
    });
  }

  const manifestPath = path.join(outDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.permissions = Array.from(
    new Set([...(manifest.permissions || []), "declarativeNetRequestFeedback"])
  );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  fs.mkdirSync(path.join(outDir, "__test__"), { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "__test__", "harness.html"),
    "<!doctype html><meta charset=utf-8><title>harness</title>\n"
  );
  return outDir;
}

/**
 * Launches Chromium with the extension loaded and returns a harness page
 * running inside the extension origin (full chrome.* API access).
 */
export async function launchExtension({ headless = true } = {}) {
  const extDir = prepareExtensionCopy();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pandirect-profile-"));

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
    ],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  }
  const extensionId = new URL(worker.url()).host;

  async function close() {
    await context.close();
    fs.rmSync(extDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/__test__/harness.html`);

  // Wait until onInstalled has synced the provider-wide dynamic rules and the
  // rule set is stable. (page.waitForFunction() can't be used here: it treats the
  // Promise returned by an async predicate as truthy and returns immediately.)
  const deadline = Date.now() + 15000;
  let lastCount = -1;
  for (;;) {
    const count = await page.evaluate(
      async () => (await chrome.declarativeNetRequest.getDynamicRules()).length
    );
    if (count > 0 && count === lastCount) break;
    if (Date.now() > deadline) {
      await close();
      throw new Error("Timed out waiting for PanDirect to sync its DNR rules");
    }
    lastCount = count;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return { context, page, worker, extensionId, extDir, close };
}
