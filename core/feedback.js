export const FEEDBACK_ISSUES_BASE_URL =
  "https://github.com/6A617970616E/pan-direct/issues/new";

export const FEEDBACK_TEMPLATE = "bug_report.yml";

/**
 * Extracts a concise, non-identifying browser/OS summary from navigator.userAgent.
 */
export function detectBrowserSummary(uaString) {
  const ua =
    typeof uaString === "string"
      ? uaString
      : typeof navigator !== "undefined" && navigator.userAgent
      ? navigator.userAgent
      : "";
  if (!ua) return "";

  let browser = "Browser";
  const edgeMatch = ua.match(/Edg\/([\d.]+)/);
  const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
  const firefoxMatch = ua.match(/Firefox\/([\d.]+)/);
  if (edgeMatch) {
    browser = `Edge ${edgeMatch[1].split(".")[0]}`;
  } else if (chromeMatch) {
    browser = `Chrome ${chromeMatch[1].split(".")[0]}`;
  } else if (firefoxMatch) {
    browser = `Firefox ${firefoxMatch[1].split(".")[0]}`;
  }

  let os = "";
  if (/Windows/i.test(ua)) os = "Windows";
  else if (/Macintosh|Mac OS X/i.test(ua)) os = "macOS";
  else if (/CrOS/i.test(ua)) os = "ChromeOS";
  else if (/Linux/i.test(ua)) os = "Linux";

  return os ? `${browser} / ${os}` : browser;
}

/**
 * Builds a GitHub Issue URL prefilled ONLY with non-sensitive environment metadata
 * (version, edition, download mode, short browser/OS summary, optional provider/scene).
 * Never includes credentials, tokens, cookies, filenames, paths, or Aria2 URLs.
 */
export function buildFeedbackIssueUrl({
  version = "",
  editionLabel = "",
  downloadMode = "",
  providerName = "",
  scene = "",
  userAgent,
} = {}) {
  const query = new URLSearchParams();
  query.set("template", FEEDBACK_TEMPLATE);

  const cleanVersion = typeof version === "string" ? version.trim() : "";
  const versionPart = cleanVersion
    ? cleanVersion.startsWith("v")
      ? cleanVersion
      : `v${cleanVersion}`
    : "";
  const cleanEdition =
    typeof editionLabel === "string" ? editionLabel.trim() : "";
  const versionText = [versionPart, cleanEdition ? `(${cleanEdition})` : ""]
    .filter(Boolean)
    .join(" ");
  if (versionText) {
    query.set("version", versionText);
  }

  const browserText = detectBrowserSummary(userAgent);
  if (browserText) {
    query.set("browser", browserText);
  }

  const cleanProvider =
    typeof providerName === "string" ? providerName.trim() : "";
  if (cleanProvider) {
    query.set("provider", cleanProvider);
  }

  const cleanScene = typeof scene === "string" ? scene.trim() : "";
  if (cleanScene) {
    query.set("scene", cleanScene);
  }

  if (downloadMode === "aria2") {
    query.set("mode", "推送 Aria2");
  } else if (downloadMode === "browser") {
    query.set("mode", "浏览器原生直下");
  }

  return `${FEEDBACK_ISSUES_BASE_URL}?${query.toString()}`;
}
