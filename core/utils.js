export function sanitizeSegment(seg) {
  if (!seg || typeof seg !== "string") return "";
  return seg
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim();
}

export function sanitizeFilename(name) {
  const cleaned = sanitizeSegment(name);
  return cleaned || undefined;
}

export function sanitizeRelativePath(relPath) {
  if (!relPath || typeof relPath !== "string") return undefined;
  const parts = relPath
    .split("/")
    .map((p) => sanitizeSegment(p))
    .filter((p) => p && p !== "." && p !== "..");
  return parts.length > 0 ? parts.join("/") : undefined;
}

export function isHttpUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function normalizeDirectoryPath(dir) {
  if (!dir || typeof dir !== "string") return "/";
  const trimmed = dir.trim();
  if (!trimmed || !trimmed.startsWith("/")) return "/";
  return trimmed.replace(/\/+$/, "") || "/";
}
