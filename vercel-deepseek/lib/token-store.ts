/**
 * Token 持久化存储
 * 使用 Vercel KV 存储所有账号的登录 token
 * 如果 KV 不可用,回退到内存缓存(单实例内有效,冷启动丢失)
 */

// 内存回退缓存
const memoryStore = new Map<string, TokenData>();

export interface TokenData {
  token: string;
  saved_at: number;
  mobile: string;
}

function isVercelKVConfigured(): boolean {
  return !!(process.env.KV_URL && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

/** 获取某个账号的持久化 token */
export async function getToken(accountKey: string): Promise<TokenData | null> {
  try {
    if (isVercelKVConfigured()) {
      const { kv } = await import("@vercel/kv");
      const raw = await kv.get<string>(`token:${accountKey}`);
      if (raw) return JSON.parse(raw) as TokenData;
      return null;
    }
  } catch {
    // KV 不可用,回退内存
  }
  return memoryStore.get(accountKey) ?? null;
}

/** 保存某个账号的 token */
export async function saveToken(accountKey: string, data: TokenData): Promise<void> {
  try {
    if (isVercelKVConfigured()) {
      const { kv } = await import("@vercel/kv");
      await kv.set(`token:${accountKey}`, JSON.stringify(data));
      return;
    }
  } catch {
    // 回退内存
  }
  memoryStore.set(accountKey, data);
}

/** 删除某个账号的 token(登出时) */
export async function deleteToken(accountKey: string): Promise<void> {
  try {
    if (isVercelKVConfigured()) {
      const { kv } = await import("@vercel/kv");
      await kv.del(`token:${accountKey}`);
      return;
    }
  } catch {
    // noop
  }
  memoryStore.delete(accountKey);
}