export const DEFAULT_PROVIDER_ID = "baidu";

export const DEFAULT_CORE_CONFIG = {
  enabled: true,
  downloadMode: "browser", // "browser" | "aria2"
  aria2Url: "http://localhost:6800/jsonrpc",
  aria2Secret: "",
  devBridgeEnabled: false,
};

export const ALL_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "xmlhttprequest",
  "media",
  "other",
];

// Session rule IDs reserved for per-download 302-resolved CDN overrides (priority 2)
export const RESOLVED_HOST_RULE_BASE_ID = 9001;
export const RESOLVED_HOST_RULE_POOL_SIZE = 4000;
export const RESOLVED_HOST_RULE_TTL_MS = 5 * 60 * 1000;
