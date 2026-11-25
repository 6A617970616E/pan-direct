#!/usr/bin/env node
/**
 * PanDirect version checker & bumper.
 *
 * Keeps all version declarations in lockstep across:
 *   - package.json
 *   - manifest.base.json
 *   - manifest.json (via syncRootManifestAndRegistry)
 *   - popup/popup.html (#versionText fallback)
 *
 * Usage:
 *   node scripts/bump-version.mjs --check [--tag=v0.4.0]
 *   node scripts/bump-version.mjs <patch|minor|major|X.Y.Z>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syncRootManifestAndRegistry } from "./build.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT_DIR = path.resolve(__dirname, "..");

const VERSION_SPAN_RE = /(<span\s+id="versionText">)v([^<]+)(<\/span>)/;

/**
 * Validates Chrome/Edge MV3 3-part numeric version (`X.Y.Z`, each 0..65535, no leading zeros).
 */
export function isValidExtensionVersion(version) {
  if (typeof version !== "string") return false;
  const match = version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) return false;
  return match.slice(1).every((part) => Number(part) <= 65535);
}

/**
 * Resolves `patch`, `minor`, `major`, or an explicit `X.Y.Z` / `vX.Y.Z` target version.
 */
export function resolveNextVersion(currentVersion, target) {
  if (!isValidExtensionVersion(currentVersion)) {
    throw new Error(`Invalid current version: "${currentVersion}"`);
  }
  const raw = String(target || "").trim();
  if (!raw) {
    throw new Error("Target version is required (patch | minor | major | X.Y.Z)");
  }

  const [major, minor, patch] = currentVersion.split(".").map(Number);
  let next = raw;
  if (raw === "patch") {
    next = `${major}.${minor}.${patch + 1}`;
  } else if (raw === "minor") {
    next = `${major}.${minor + 1}.0`;
  } else if (raw === "major") {
    next = `${major + 1}.0.0`;
  } else if (raw.startsWith("v") || raw.startsWith("V")) {
    next = raw.slice(1);
  }

  if (!isValidExtensionVersion(next)) {
    throw new Error(
      `Invalid target version "${raw}". Expected X.Y.Z (integers 0..65535, e.g. 0.4.1)`
    );
  }
  return next;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

/**
 * Verifies that package.json, manifest.base.json, manifest.json, popup/popup.html
 * (and optional git tag `vX.Y.Z`) all declare the exact same valid version.
 */
export function checkVersionConsistency(
  rootDir = DEFAULT_ROOT_DIR,
  { expectedTag = "" } = {}
) {
  const pkg = readJson(path.join(rootDir, "package.json"));
  const baseManifest = readJson(path.join(rootDir, "manifest.base.json"));
  const rootManifest = readJson(path.join(rootDir, "manifest.json"));
  const popupHtml = fs.readFileSync(
    path.join(rootDir, "popup", "popup.html"),
    "utf8"
  );
  const popupMatch = popupHtml.match(VERSION_SPAN_RE);
  const popupVersion = popupMatch ? popupMatch[2] : null;

  const errors = [];
  if (!isValidExtensionVersion(pkg.version)) {
    errors.push(`package.json version "${pkg.version}" is not a valid X.Y.Z version`);
  }
  if (baseManifest.version !== pkg.version) {
    errors.push(
      `manifest.base.json version "${baseManifest.version}" !== package.json "${pkg.version}"`
    );
  }
  if (rootManifest.version !== pkg.version) {
    errors.push(
      `manifest.json version "${rootManifest.version}" !== package.json "${pkg.version}" (run \`npm run sync-root\`)`
    );
  }
  if (popupVersion !== pkg.version) {
    errors.push(
      `popup/popup.html #versionText "v${popupVersion}" !== package.json "v${pkg.version}"`
    );
  }
  if (expectedTag) {
    const expected = `v${pkg.version}`;
    if (expectedTag !== expected) {
      errors.push(
        `Git tag "${expectedTag}" does not match package.json version "${expected}"`
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Version consistency check failed:\n- ${errors.join("\n- ")}`);
  }

  return { ok: true, version: pkg.version };
}

/**
 * Bumps version across package.json, manifest.base.json, popup/popup.html,
 * and regenerates root manifest.json & provider registries via sync-root.
 */
export function bumpVersion(rootDir = DEFAULT_ROOT_DIR, target) {
  const pkgPath = path.join(rootDir, "package.json");
  const basePath = path.join(rootDir, "manifest.base.json");
  const popupPath = path.join(rootDir, "popup", "popup.html");

  const pkg = readJson(pkgPath);
  const previousVersion = pkg.version;
  const nextVersion = resolveNextVersion(previousVersion, target);

  pkg.version = nextVersion;
  writeJson(pkgPath, pkg);

  const baseManifest = readJson(basePath);
  baseManifest.version = nextVersion;
  writeJson(basePath, baseManifest);

  const popupHtml = fs.readFileSync(popupPath, "utf8");
  if (!VERSION_SPAN_RE.test(popupHtml)) {
    throw new Error(`Could not locate #versionText span in ${popupPath}`);
  }
  const updatedPopupHtml = popupHtml.replace(
    VERSION_SPAN_RE,
    `$1v${nextVersion}$3`
  );
  fs.writeFileSync(popupPath, updatedPopupHtml, "utf8");

  syncRootManifestAndRegistry(rootDir, { includeDevBridge: false });
  checkVersionConsistency(rootDir);

  return { previousVersion, version: nextVersion };
}

function parseCliArgs(argv) {
  let check = false;
  let expectedTag = "";
  let target = "";

  for (const arg of argv) {
    if (arg === "--check") {
      check = true;
    } else if (arg.startsWith("--tag=")) {
      expectedTag = arg.slice("--tag=".length).trim();
    } else if (!arg.startsWith("-")) {
      target = arg;
    }
  }
  return { check, expectedTag, target };
}

function main() {
  const { check, expectedTag, target } = parseCliArgs(process.argv.slice(2));

  if (check) {
    const res = checkVersionConsistency(DEFAULT_ROOT_DIR, { expectedTag });
    console.log(
      `[PanDirect] Version check passed: v${res.version}${
        expectedTag ? ` (matches tag ${expectedTag})` : ""
      }`
    );
    return;
  }

  if (!target) {
    console.error(
      "Usage:\n" +
        "  npm run version:check [-- --tag=vX.Y.Z]\n" +
        "  npm run version:bump -- <patch|minor|major|X.Y.Z>"
    );
    process.exit(1);
  }

  const res = bumpVersion(DEFAULT_ROOT_DIR, target);
  console.log(
    `[PanDirect] Bumped version: v${res.previousVersion} -> v${res.version}`
  );
  console.log(
    `[PanDirect] Updated package.json, manifest.base.json, manifest.json, and popup/popup.html`
  );
  console.log("\nNext steps to publish a GitHub Release:");
  console.log(`  npm test && npm run build`);
  console.log(`  git commit -am "release: v${res.version}"`);
  console.log(`  git tag v${res.version}`);
  console.log(`  git push origin main --tags`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
