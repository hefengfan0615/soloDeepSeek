/**
 * 认证模块
 *
 * 环境变量:
 *   APIKEY   - 格式: "key1,key2,key3,..."  用于客户端认证
 *   ADMIN    - 格式: "mobile1:password1,mobile2:password2,..."  用于 DeepSeek 登录
 */

export interface AdminAccount {
  mobile: string;
  password: string;
}

let _apiKeys: string[] | null = null;
let _adminAccounts: AdminAccount[] | null = null;

/** 获取所有 API Key */
function getApiKeys(): string[] {
  if (_apiKeys !== null) return _apiKeys;
  const raw = process.env.APIKEY || "";
  _apiKeys = raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  return _apiKeys;
}

/** 获取所有管理员账号 */
export function getAdminAccounts(): AdminAccount[] {
  if (_adminAccounts !== null) return _adminAccounts;
  const raw = process.env.ADMIN || "";
  _adminAccounts = raw
    .split(",")
    .map((entry) => {
      const [mobile, ...rest] = entry.trim().split(":");
      return { mobile: mobile?.trim() || "", password: rest.join(":").trim() };
    })
    .filter((a) => a.mobile && a.password);
  return _adminAccounts;
}

/** 根据 API Key 分配一个 Admin 账号(按 key 索引轮询) */
export function resolveAccountByApiKey(apiKey: string): AdminAccount | null {
  const keys = getApiKeys();
  const accounts = getAdminAccounts();
  if (accounts.length === 0) return null;
  const idx = keys.indexOf(apiKey);
  if (idx < 0) return null;
  return accounts[idx % accounts.length];
}

/** 验证 API Key 是否有效 */
export function validateApiKey(apiKey: string): boolean {
  const keys = getApiKeys();
  if (keys.length === 0) {
    // 没有配置 APIKEY 环境变量时,允许所有请求(开发模式)
    return true;
  }
  return keys.includes(apiKey);
}

/** 从 Authorization header 提取 API Key */
export function extractApiKey(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}