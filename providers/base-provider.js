const DEFAULT_CAPABILITIES = {
  listFiles: true,
  listFolderRecursive: true,
  downloadByIds: true,
  directUrlDownload: true,
  folderStreaming: true,
  aria2: true,
};

const REQUIRED_METHODS = [
  "isAllowedDownloadUrl",
  "listFiles",
  "listFolderRecursive",
  "resolveDownloadTargets",
  "resolveStreamTarget",
];

/**
 * Validates and normalizes a PanDirect netdisk provider definition.
 * Both `providers/official/*` and `providers/community/*` implement this contract.
 */
export function defineProvider(spec) {
  if (!spec || typeof spec !== "object") {
    throw new Error("Provider definition must be an object");
  }
  if (!spec.id || typeof spec.id !== "string") {
    throw new Error("Provider definition requires a string `id`");
  }
  if (!spec.name || typeof spec.name !== "string") {
    throw new Error(`Provider "${spec.id}" requires a string \`name\``);
  }
  if (spec.tier !== "official" && spec.tier !== "community") {
    throw new Error(
      `Provider "${spec.id}" must declare tier as "official" or "community"`
    );
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof spec[method] !== "function") {
      throw new Error(`Provider "${spec.id}" is missing required method: ${method}()`);
    }
  }

  return {
    description: "",
    authType: "none",
    dnrRuleIdBase: 0,
    downloadCredentials: "omit",
    defaultConfig: {},
    disallowedUrlMessage: "下载链接域名不在该网盘允许的安全白名单范围内。",
    normalizeConfig: (raw) => ({ ...(spec.defaultConfig || {}), ...(raw || {}) }),
    getPublicStatus: () => ({}),
    getDnrRules: () => [],
    getDownloadRequestHeaders: () => [],
    getAria2Headers: () => [],
    startAuth: async () => ({ ok: true }),
    logout: async () => {},
    ...spec,
    capabilities: {
      ...DEFAULT_CAPABILITIES,
      ...(spec.capabilities || {}),
    },
  };
}
