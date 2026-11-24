import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT_DIR = path.resolve(__dirname, "..");

const EDITION_META = {
  store: {
    label: "Store",
    tiers: ["official"],
  },
  community: {
    label: "Community",
    tiers: ["official", "community"],
  },
  dev: {
    label: "Dev",
    tiers: ["official", "community"],
  },
};

const IGNORED_NAMES = new Set([".DS_Store", "Thumbs.db"]);

// Standard IEEE 802.3 CRC-32 lookup table (works on Node 18/20/22+)
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function computeCrc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosDate =
    ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  return { dosDate, dosTime };
}

function walkFilesSorted(dirPath, baseDir = dirPath) {
  const results = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFilesSorted(fullPath, baseDir));
    } else if (entry.isFile()) {
      const relPath = path.relative(baseDir, fullPath).split(path.sep).join("/");
      results.push({ fullPath, relPath });
    }
  }
  return results;
}

/**
 * Pure Node.js deterministic ZIP archive creator (zero external binaries/deps).
 */
export function createZipFromDirectory(sourceDir, zipFilePath) {
  const files = walkFilesSorted(sourceDir);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const rawData = fs.readFileSync(file.fullPath);
    const stat = fs.statSync(file.fullPath);
    const { dosDate, dosTime } = toDosDateTime(stat.mtime);
    const nameBuf = Buffer.from(file.relPath, "utf8");
    const crc = computeCrc32(rawData);

    const deflated = zlib.deflateRawSync(rawData, { level: 9 });
    const useDeflate = deflated.length < rawData.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : rawData;

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len

    localParts.push(localHeader, nameBuf, payload);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(0x0314, 4); // version made by (Unix, 2.0)
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra len
    centralHeader.writeUInt16LE(0, 32); // comment len
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDirBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  const zipBuffer = Buffer.concat([...localParts, centralDirBuffer, eocd]);
  fs.mkdirSync(path.dirname(zipFilePath), { recursive: true });
  fs.writeFileSync(zipFilePath, zipBuffer);

  return { fileCount: files.length, byteLength: zipBuffer.length };
}

// Discovers enabled providers under providers/<tier>/<id>/provider.json.
export function discoverProviders(rootDir, tier) {
  const tierDir = path.join(rootDir, "providers", tier);
  if (!fs.existsSync(tierDir)) return [];

  const entries = fs.readdirSync(tierDir, { withFileTypes: true });
  const discovered = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(tierDir, entry.name, "provider.json");
    if (!fs.existsSync(metaPath)) continue;

    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (meta.enabled === false) continue;

    if (!meta.id || !meta.name || !meta.entry || !meta.exportName) {
      throw new Error(
        `Invalid provider.json at ${metaPath}: requires id, name, entry, exportName`
      );
    }
    if (meta.tier !== tier) {
      throw new Error(
        `Tier mismatch in ${metaPath}: expected "${tier}", got "${meta.tier}"`
      );
    }

    discovered.push({
      ...meta,
      dirName: entry.name,
      relDir: `providers/${tier}/${entry.name}`,
    });
  }

  discovered.sort((a, b) => a.id.localeCompare(b.id));
  return discovered;
}

export function discoverProvidersForEdition(rootDir, edition) {
  const meta = EDITION_META[edition];
  if (!meta) {
    throw new Error(`Unknown edition: ${edition}`);
  }
  const all = [];
  for (const tier of meta.tiers) {
    all.push(...discoverProviders(rootDir, tier));
  }
  return all;
}

export function assembleManifest({ baseManifest, edition, providers }) {
  const manifest = structuredClone(baseManifest);

  if (edition === "community") {
    manifest.name = `${baseManifest.name} (Community)`;
    manifest.short_name = `${baseManifest.short_name || baseManifest.name} Community`;
    manifest.description = `${baseManifest.description}（社区版：包含官方开放平台与社区实验性网盘适配器）`;
  }

  const permissionSet = new Set(baseManifest.permissions || []);
  for (const p of providers) {
    for (const perm of p.manifest?.permissions || []) {
      permissionSet.add(perm);
    }
  }
  manifest.permissions = Array.from(permissionSet);

  const hostPermissionSet = new Set();
  for (const p of providers) {
    for (const host of p.manifest?.host_permissions || []) {
      hostPermissionSet.add(host);
    }
  }
  for (const host of baseManifest.host_permissions || []) {
    hostPermissionSet.add(host);
  }
  manifest.host_permissions = Array.from(hostPermissionSet);

  const mergedContentScripts = [];
  for (const p of providers) {
    for (const cs of p.manifest?.content_scripts || []) {
      mergedContentScripts.push(structuredClone(cs));
    }
  }
  if (edition !== "store") {
    for (const cs of baseManifest.content_scripts || []) {
      mergedContentScripts.push(structuredClone(cs));
    }
  }
  manifest.content_scripts = mergedContentScripts;

  return manifest;
}

export function generateProvidersIndexSource(providers) {
  const lines = [
    "// Auto-generated by scripts/build.mjs (static ES imports required by MV3 Service Workers).",
  ];
  const exportNames = [];

  for (const p of providers) {
    const importPath = `./${p.tier}/${p.dirName}/${p.entry}`;
    lines.push(`import { ${p.exportName} } from "${importPath}";`);
    exportNames.push(p.exportName);
  }

  lines.push("");
  lines.push(`export const providers = [${exportNames.join(", ")}];`);
  lines.push("");
  return lines.join("\n");
}

export function generatePopupIndexSource(providers) {
  const lines = ["// Auto-generated by scripts/build.mjs."];
  const entries = [];

  for (const p of providers) {
    if (!p.popupEntry || !p.popupExportName) continue;
    const importPath = `./${p.tier}/${p.dirName}/${p.popupEntry}`;
    lines.push(`import { ${p.popupExportName} } from "${importPath}";`);
    entries.push(`  ${JSON.stringify(p.id)}: ${p.popupExportName},`);
  }

  lines.push("");
  if (entries.length === 0) {
    lines.push("export const popupCardRenderers = {};");
  } else {
    lines.push("export const popupCardRenderers = {");
    lines.push(...entries);
    lines.push("};");
  }
  lines.push("");
  return lines.join("\n");
}

export function generateEditionSource(edition) {
  const meta = EDITION_META[edition];
  return [
    "// Auto-generated by scripts/build.mjs.",
    `export const EDITION = ${JSON.stringify(edition)};`,
    `export const EDITION_LABEL = ${JSON.stringify(meta.label)};`,
    `export const INCLUDED_TIERS = ${JSON.stringify(meta.tiers)};`,
    "",
  ].join("\n");
}

function copyFilteredRecursive(
  src,
  dest,
  { excludeMarkdown = false, excludeBuildMeta = false } = {}
) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      copyFilteredRecursive(
        path.join(src, entry.name),
        path.join(dest, entry.name),
        { excludeMarkdown, excludeBuildMeta }
      );
    }
    return;
  }

  const base = path.basename(src).toLowerCase();
  if (excludeMarkdown && base.endsWith(".md")) {
    return;
  }
  if (excludeBuildMeta && base === "provider.json") {
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/**
 * Post-build integrity & store-isolation assertions.
 */
export function verifyEditionDirectory({ edition, outDir, manifest, providers }) {
  if (manifest.manifest_version !== 3) {
    throw new Error(`[${edition}] manifest_version must be 3`);
  }

  // Collect every file path referenced by manifest.json
  const referencedFiles = new Set();
  if (manifest.background?.service_worker) {
    referencedFiles.add(manifest.background.service_worker);
  }
  if (manifest.action?.default_popup) {
    referencedFiles.add(manifest.action.default_popup);
  }
  for (const iconPath of Object.values(manifest.icons || {})) {
    referencedFiles.add(iconPath);
  }
  for (const iconPath of Object.values(manifest.action?.default_icon || {})) {
    referencedFiles.add(iconPath);
  }
  for (const cs of manifest.content_scripts || []) {
    for (const jsPath of cs.js || []) referencedFiles.add(jsPath);
    for (const cssPath of cs.css || []) referencedFiles.add(cssPath);
  }

  for (const relPath of referencedFiles) {
    const full = path.join(outDir, relPath);
    if (!fs.existsSync(full)) {
      throw new Error(
        `[${edition}] Manifest references missing file: ${relPath}`
      );
    }
  }

  // Store edition MUST NOT include any community provider files, imports, or cookies permission
  if (edition === "store") {
    if ((manifest.permissions || []).includes("cookies")) {
      throw new Error(
        "[store] Store build must not request the `cookies` permission"
      );
    }
    const communityDir = path.join(outDir, "providers", "community");
    if (fs.existsSync(communityDir)) {
      throw new Error(
        "[store] Store build must not contain providers/community/"
      );
    }
    for (const p of providers) {
      if (p.tier !== "official") {
        throw new Error(
          `[store] Non-official provider "${p.id}" leaked into store build`
        );
      }
    }
    const indexContent = fs.readFileSync(
      path.join(outDir, "providers", "index.js"),
      "utf8"
    );
    if (indexContent.includes("./community/")) {
      throw new Error(
        "[store] Store providers/index.js must not import community providers"
      );
    }
    const popupIndexContent = fs.readFileSync(
      path.join(outDir, "providers", "popup-index.js"),
      "utf8"
    );
    if (popupIndexContent.includes("./community/")) {
      throw new Error(
        "[store] Store providers/popup-index.js must not import community providers"
      );
    }
    if (fs.existsSync(path.join(outDir, "core", "content-bridge.js"))) {
      throw new Error(
        "[store] Store build must not ship dev-only core/content-bridge.js"
      );
    }
    const hasLocalhostContentScript = (manifest.content_scripts || []).some(
      (cs) =>
        (cs.matches || []).some(
          (m) => m.includes("localhost") || m.includes("127.0.0.1")
        )
    );
    if (hasLocalhostContentScript) {
      throw new Error(
        "[store] Store build must not inject content_scripts on localhost/127.0.0.1"
      );
    }
  }

  // Ensure dev-only files are never shipped in release zips
  const forbiddenFiles = [
    "HANDOFF.md",
    "test-page.html",
    "package.json",
    "manifest.base.json",
    "scripts",
    "tests",
    "docs",
  ];
  for (const forbidden of forbiddenFiles) {
    if (fs.existsSync(path.join(outDir, forbidden))) {
      throw new Error(
        `[${edition}] Forbidden dev file leaked into output: ${forbidden}`
      );
    }
  }
}

export function buildEdition({
  rootDir = DEFAULT_ROOT_DIR,
  distDir = path.join(rootDir, "dist"),
  edition,
}) {
  if (edition !== "store" && edition !== "community") {
    throw new Error(`Unsupported build edition: ${edition}`);
  }

  const baseManifestPath = path.join(rootDir, "manifest.base.json");
  const baseManifest = JSON.parse(fs.readFileSync(baseManifestPath, "utf8"));
  const providers = discoverProvidersForEdition(rootDir, edition);

  const outDir = path.join(distDir, edition);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // Copy shared runtime assets
  const runtimeDirs = ["core", "popup", "downloader", "icons"];
  for (const dir of runtimeDirs) {
    copyFilteredRecursive(path.join(rootDir, dir), path.join(outDir, dir), {
      excludeMarkdown: true,
    });
  }
  if (edition === "store") {
    fs.rmSync(path.join(outDir, "core", "content-bridge.js"), { force: true });
  }

  const runtimeFiles = [
    "background.js",
    "LICENSE",
    "providers/base-provider.js",
  ];
  for (const file of runtimeFiles) {
    copyFilteredRecursive(path.join(rootDir, file), path.join(outDir, file));
  }

  // Copy ONLY enabled providers for this edition
  for (const p of providers) {
    copyFilteredRecursive(
      path.join(rootDir, p.relDir),
      path.join(outDir, p.relDir),
      { excludeMarkdown: true, excludeBuildMeta: true }
    );
  }

  // Generate edition-specific manifest.json, core/edition.js, providers/index.js & popup-index.js
  const manifest = assembleManifest({ baseManifest, edition, providers });
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(outDir, "core", "edition.js"),
    generateEditionSource(edition),
    "utf8"
  );
  fs.writeFileSync(
    path.join(outDir, "providers", "index.js"),
    generateProvidersIndexSource(providers),
    "utf8"
  );
  fs.writeFileSync(
    path.join(outDir, "providers", "popup-index.js"),
    generatePopupIndexSource(providers),
    "utf8"
  );

  // Run strict post-build verification before creating ZIP
  verifyEditionDirectory({ edition, outDir, manifest, providers });

  const zipPath = path.join(distDir, `${edition}.zip`);
  const zipStats = createZipFromDirectory(outDir, zipPath);

  return {
    edition,
    version: manifest.version,
    providers: providers.map((p) => `${p.tier}/${p.id}`),
    outDir,
    zipPath,
    ...zipStats,
  };
}

/**
 * Syncs root `manifest.json`, `providers/index.js`, and `providers/popup-index.js`
 * so developers can load the repository root directly via "Load unpacked" without building.
 */
export function syncRootManifestAndRegistry(rootDir = DEFAULT_ROOT_DIR) {
  const baseManifest = JSON.parse(
    fs.readFileSync(path.join(rootDir, "manifest.base.json"), "utf8")
  );
  const providers = discoverProvidersForEdition(rootDir, "dev");
  const manifest = assembleManifest({
    baseManifest,
    edition: "dev",
    providers,
  });

  fs.writeFileSync(
    path.join(rootDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(rootDir, "providers", "index.js"),
    generateProvidersIndexSource(providers),
    "utf8"
  );
  fs.writeFileSync(
    path.join(rootDir, "providers", "popup-index.js"),
    generatePopupIndexSource(providers),
    "utf8"
  );

  return {
    version: manifest.version,
    providers: providers.map((p) => `${p.tier}/${p.id}`),
  };
}

function parseArgs(argv) {
  let target = "all";
  let syncRoot = false;
  let noDist = false;

  for (const arg of argv) {
    if (arg.startsWith("--target=")) {
      target = arg.slice("--target=".length);
    } else if (arg === "--sync-root") {
      syncRoot = true;
    } else if (arg === "--no-dist") {
      noDist = true;
    }
  }
  return { target, syncRoot, noDist };
}

function main() {
  const { target, syncRoot, noDist } = parseArgs(process.argv.slice(2));

  if (syncRoot) {
    const synced = syncRootManifestAndRegistry(DEFAULT_ROOT_DIR);
    console.log(
      `[PanDirect] Synced root manifest.json & providers/index.js (v${synced.version}, providers: ${synced.providers.join(", ") || "none"})`
    );
  }

  if (noDist) return;

  const targets =
    target === "all" ? ["store", "community"] : [target];

  for (const edition of targets) {
    const res = buildEdition({ rootDir: DEFAULT_ROOT_DIR, edition });
    const kb = (res.byteLength / 1024).toFixed(1);
    console.log(
      `[PanDirect] Built ${res.edition.padEnd(9)} v${res.version} -> ${path.relative(
        DEFAULT_ROOT_DIR,
        res.zipPath
      )} (${res.fileCount} files, ${kb} KB) | providers: [${res.providers.join(", ")}]`
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
