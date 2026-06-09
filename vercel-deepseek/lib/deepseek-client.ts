/**
 * DeepSeek API 客户端(针对 Vercel Serverless 优化)
 *
 * 核心流程:
 *   1. 从 KV/内存获取持久化 token
 *   2. 验证 token 有效性(/api/v0/users/current)
 *   3. token 失效时自动用账号密码重新登录
 *   4. 使用 token 调用 DeepSeek 内部 API
 *
 * 注意: Vercel Serverless 环境可能被 DeepSeek 风控(202),
 *       建议部署时使用固定区域的 Vercel Functions
 */

import { v4 as uuidv4 } from "uuid";
import { solvePow } from "./pow";
import { resolveAccountByApiKey, getAdminAccounts, type AdminAccount } from "./auth";
import * as tokenStore from "./token-store";

// ============== 类型定义 ==============

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface SSEEvent {
  type: "ready" | "search" | "thinking" | "text" | "message" | "finished";
  delta?: string;
  response_message_id?: number;
  results?: Array<Record<string, unknown>>;
  queries?: string[];
  message?: Record<string, unknown>;
}

// ============== 常量 ==============

const BASE_URL = "https://chat.deepseek.com";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function commonHeaders(): Record<string, string> {
  return {
    "User-Agent": UA,
    "x-app-version": "2.0.0",
    "x-client-locale": "en_US",
    "x-client-platform": "web",
    "x-client-version": "2.0.0",
    "x-client-timezone-offset": "0",
    Accept: "application/json",
    "Content-Type": "application/json",
    Referer: `${BASE_URL}/`,
    Origin: BASE_URL,
  };
}

// ============== DeepSeek 客户端 ==============

export class DeepSeekClient {
  private account: AdminAccount;
  private token: string | null = null;
  private accountKey: string;

  constructor(account: AdminAccount) {
    this.account = account;
    // 用手机号哈希作为持久化 key
    this.accountKey = `account_${Buffer.from(account.mobile).toString("base64")}`;
  }

  // ---------- HTTP 请求 ----------
  private async request(
    method: string,
    path: string,
    options: {
      body?: unknown;
      params?: Record<string, string>;
      headers?: Record<string, string>;
      timeout?: number;
    } = {}
  ): Promise<Response> {
    const url = new URL(path, BASE_URL);
    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      ...commonHeaders(),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(options.headers || {}),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), (options.timeout || 30) * 1000);

    try {
      const res = await fetch(url.toString(), {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      return res;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---------- Token 管理 ----------

  /** 确保有可用的 token,过期则自动登录 */
  async ensureToken(): Promise<string> {
    // 1) 尝试从持久化存储加载
    if (!this.token) {
      const saved = await tokenStore.getToken(this.accountKey);
      if (saved) {
        this.token = saved.token;
      }
    }

    // 2) 验证 token
    if (this.token) {
      const valid = await this.verifyToken();
      if (valid) return this.token;
      // token 无效,清除
      this.token = null;
      await tokenStore.deleteToken(this.accountKey);
    }

    // 3) 重新登录
    console.log(`[*] Token 失效,正在为 ${this.account.mobile} 重新登录...`);
    return this.login();
  }

  /** 登录并持久化 token */
  async login(): Promise<string> {
    const deviceId = Buffer.from(
      uuidv4().replace(/-/g, "") + uuidv4().replace(/-/g, ""),
      "hex"
    ).toString("base64");

    const body = {
      email: "",
      mobile: this.account.mobile,
      password: this.account.password,
      area_code: "+86",
      device_id: deviceId,
      os: "web",
    };

    const res = await this.request("POST", "/api/v0/users/login", {
      body,
    });

    const data = (await res.json()) as Record<string, unknown>;
    if ((data.code as number) !== 0) {
      throw new Error(`登录失败: ${JSON.stringify(data)}`);
    }

    const userData = (data.data as Record<string, unknown>).biz_data as Record<string, unknown>;
    this.token = (userData.user as Record<string, unknown>).token as string;

    // 持久化
    await tokenStore.saveToken(this.accountKey, {
      token: this.token,
      saved_at: Math.floor(Date.now() / 1000),
      mobile: this.account.mobile,
    });

    return this.token;
  }

  /** 验证当前 token 是否有效 */
  async verifyToken(): Promise<boolean> {
    if (!this.token) return false;
    try {
      const res = await this.request("GET", "/api/v0/users/current");
      if (res.status !== 200) return false;
      const data = (await res.json()) as Record<string, unknown>;
      return (data.code as number) === 0;
    } catch {
      return false;
    }
  }

  // ---------- 业务接口 ----------

  /** 获取可用模型列表 */
  async listModels(): Promise<Array<Record<string, unknown>>> {
    const did = uuidv4();
    const res = await this.request("GET", "/api/v0/client/settings", {
      params: { did, scope: "model" },
    });
    const data = (await res.json()) as Record<string, unknown>;
    if ((data.code as number) !== 0) {
      throw new Error(`获取模型失败: ${JSON.stringify(data)}`);
    }
    const bizData = (data.data as Record<string, unknown>).biz_data as Record<string, unknown>;
    const settings = bizData.settings as Record<string, unknown>;
    return (settings.model_configs as Record<string, unknown>).value as Array<Record<string, unknown>>;
  }

  /** 创建聊天会话 */
  async createSession(): Promise<string> {
    const res = await this.request("POST", "/api/v0/chat_session/create", { body: {} });
    const data = (await res.json()) as Record<string, unknown>;
    if ((data.code as number) !== 0) {
      throw new Error(`创建会话失败: ${JSON.stringify(data)}`);
    }
    const bizData = (data.data as Record<string, unknown>).biz_data as Record<string, unknown>;
    return (bizData.chat_session as Record<string, unknown>).id as string;
  }

  /** 删除会话 */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.request("POST", "/api/v0/chat_session/delete", {
        body: { chat_session_id: sessionId },
      });
    } catch {
      // 忽略删除失败
    }
  }

  /** 获取 PoW challenge */
  async getPowChallenge(targetPath = "/api/v0/chat/completion"): Promise<Record<string, unknown>> {
    const res = await this.request("POST", "/api/v0/chat/create_pow_challenge", {
      body: { target_path: targetPath },
    });
    const data = (await res.json()) as Record<string, unknown>;
    if ((data.code as number) !== 0) {
      throw new Error(`获取 PoW challenge 失败: ${JSON.stringify(data)}`);
    }
    return (data.data as Record<string, unknown>).biz_data as Record<string, unknown>;
  }

  /** 流式 SSE 聊天(底层) */
  async *iterSSE(
    sessionId: string,
    prompt: string,
    modelType: string,
    searchEnabled: boolean,
    thinkingEnabled: boolean,
    parentMessageId?: string | null
  ): AsyncGenerator<SSEEvent> {
    // 1) PoW
    const ch = await this.getPowChallenge();
    const answer = solvePow(
      ch.challenge as string,
      ch.salt as string,
      ch.expire_at as number,
      ch.difficulty as number
    );

    const powResponse = {
      algorithm: ch.algorithm,
      challenge: ch.challenge,
      salt: ch.salt,
      answer,
      signature: ch.signature,
      target_path: ch.target_path,
    };
    const powHeader = Buffer.from(JSON.stringify(powResponse)).toString("base64");

    // 2) 请求
    const body = {
      chat_session_id: sessionId,
      parent_message_id: parentMessageId || null,
      model_type: modelType,
      prompt,
      ref_file_ids: [],
      thinking_enabled: thinkingEnabled,
      search_enabled: searchEnabled,
      action: null,
      preempt: false,
    };

    const headers: Record<string, string> = {
      ...commonHeaders(),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      "x-ds-pow-response": powHeader,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180 * 1000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const res = await fetch(`${BASE_URL}/api/v0/chat/completion`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.status !== 200) {
        const text = await res.text();
        throw new Error(`chat/completion 失败: ${res.status} ${text.slice(0, 300)}`);
      }

      if (!res.body) throw new Error("响应无 body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      let currentFragmentType: string | null = null;
      const seenResultsKeys = new Set<string>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line || line.startsWith(":")) continue;
          if (!line.startsWith("data:")) continue;

          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(payload);
          } catch {
            continue;
          }

          const v = obj.v;
          const p = (obj.p as string) || "";
          const o = (obj.o as string) || "";

          // response/fragments APPEND -> 切换当前 fragment 类型
          if (
            p === "response/fragments" &&
            o === "APPEND" &&
            Array.isArray(v)
          ) {
            for (const frag of v as Array<Record<string, unknown>>) {
              if (frag.type) currentFragmentType = frag.type as string;
              if (frag.type === "RESPONSE" && typeof frag.content === "string" && frag.content) {
                yield { type: "text", delta: frag.content };
              }
            }
            continue;
          }

          // 裸字符串增量
          if (typeof v === "string" && !p && !o) {
            if (currentFragmentType === "THINK") {
              yield { type: "thinking", delta: v };
            } else {
              yield { type: "text", delta: v };
            }
            continue;
          }

          // thinking_content 片段
          if (
            p.startsWith("response/fragments/") &&
            p.endsWith("/thinking_content") &&
            o === "APPEND" &&
            typeof v === "string"
          ) {
            yield { type: "thinking", delta: v };
            continue;
          }

          // content 片段
          if (
            p.startsWith("response/fragments/") &&
            p.endsWith("/content") &&
            o === "APPEND" &&
            typeof v === "string"
          ) {
            if (currentFragmentType === "THINK") {
              yield { type: "thinking", delta: v };
            } else {
              yield { type: "text", delta: v };
            }
            continue;
          }

          // 搜索结果
          if (p === "response/fragments/-1/results" && Array.isArray(v)) {
            for (const r of v as Array<Record<string, unknown>>) {
              const key = (r.url || r.title) as string;
              if (seenResultsKeys.has(key)) continue;
              seenResultsKeys.add(key);
            }
            yield { type: "search", results: v as Array<Record<string, unknown>>, queries: [] };
            continue;
          }

          // BATCH 推送
          if (p === "response" && o === "BATCH" && Array.isArray(v)) {
            const results: Array<Record<string, unknown>> = [];
            const queries: string[] = [];
            for (const item of v as Array<Record<string, unknown>>) {
              if (item.p === "fragments" && item.o === "APPEND" && Array.isArray(item.v)) {
                for (const frag of item.v as Array<Record<string, unknown>>) {
                  if (frag.type) currentFragmentType = frag.type as string;
                  if (frag.type === "SEARCH") {
                    for (const r of (frag.results as Array<Record<string, unknown>>) || []) {
                      const key = (r.url || r.title) as string;
                      if (seenResultsKeys.has(key)) continue;
                      seenResultsKeys.add(key);
                      results.push(r);
                    }
                    for (const q of (frag.queries as Array<Record<string, unknown>>) || []) {
                      if (q.query) queries.push(q.query as string);
                    }
                  }
                }
              }
            }
            if (results.length || queries.length) {
              yield { type: "search", results, queries };
            }
            continue;
          }

          // 初始 message
          if (typeof v === "object" && v && "response" in v) {
            yield { type: "message", message: v.response as Record<string, unknown> };
            const resp = v.response as Record<string, unknown>;
            for (const frag of (resp.fragments as Array<Record<string, unknown>>) || []) {
              if (frag.type) currentFragmentType = frag.type as string;
              if (frag.type === "THINK" && typeof frag.content === "string" && frag.content) {
                yield { type: "thinking", delta: frag.content };
              }
              if (frag.type === "RESPONSE" && typeof frag.content === "string" && frag.content) {
                yield { type: "text", delta: frag.content };
              }
            }
            continue;
          }

          // finished
          if (p === "response/status" && o === "SET" && v === "FINISHED") {
            yield { type: "finished" };
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      try { reader?.cancel(); } catch { /* noop */ }
    }
  }

  // ---------- OpenAI 兼容接口 ----------

  /** GET /v1/models 兼容格式 */
  async openaiListModels(): Promise<Record<string, unknown>> {
    const models = await this.listModels();
    const now = Math.floor(Date.now() / 1000);

    return {
      object: "list",
      data: models.map((m) => ({
        id: (m.model_type as string) || (m.name as string) || "unknown",
        object: "model",
        created: now,
        owned_by: "deepseek",
      })),
    };
  }

  /** POST /v1/chat/completions 兼容格式
   *  - stream=false: 返回完整 OpenAI chat.completion dict
   *  - stream=true:  异步生成器, yield OpenAI chat.completion.chunk dict
   */
  async *openaiChat(
    messages: ChatMessage[],
    model: string,
    stream: boolean,
    searchEnabled = true,
    thinkingEnabled = true
  ): AsyncGenerator<Record<string, unknown>> {
    // 1) 拼 prompt
    const systemParts: string[] = [];
    const promptParts: string[] = [];

    for (const m of messages) {
      const content = m.content || "";
      if (m.role === "system") systemParts.push(content);
      else if (m.role === "user") promptParts.push(`User: ${content}`);
      else if (m.role === "assistant") promptParts.push(`Assistant: ${content}`);
    }

    if (systemParts.length) {
      promptParts.unshift("System: " + systemParts.join("\n"));
    }

    const prompt = promptParts.join("\n\n") + "\n\nAssistant:";

    // 2) 确保 token + 创建会话
    await this.ensureToken();
    const sessionId = await this.createSession();

    try {
      const chatId = `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 24)}`;
      const created = Math.floor(Date.now() / 1000);
      const textParts: string[] = [];
      const thinkParts: string[] = [];

      if (stream) {
        // 首个 chunk: role
        yield {
          id: chatId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            { index: 0, delta: { role: "assistant" }, finish_reason: null },
          ],
        };
      }

      for await (const ev of this.iterSSE(
        sessionId,
        prompt,
        model,
        searchEnabled,
        thinkingEnabled
      )) {
        if (ev.type === "thinking" && ev.delta) {
          thinkParts.push(ev.delta);
          if (stream) {
            yield {
              id: chatId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { reasoning_content: ev.delta },
                  finish_reason: null,
                },
              ],
            };
          }
        } else if (ev.type === "text" && ev.delta) {
          textParts.push(ev.delta);
          if (stream) {
            yield {
              id: chatId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: ev.delta },
                  finish_reason: null,
                },
              ],
            };
          }
        }
      }

      if (stream) {
        // 末尾 chunk
        yield {
          id: chatId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        // SSE 结束标记
        yield { done: true };
      } else {
        // 非流式: 组装完整响应
        const text = textParts.join("");
        const think = thinkParts.join("");
        const message: Record<string, unknown> = {
          role: "assistant",
          content: text,
        };
        if (think) {
          message.reasoning_content = think;
        }

        yield {
          id: chatId,
          object: "chat.completion",
          created,
          model,
          choices: [
            { index: 0, message, finish_reason: "stop" },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: text.length + think.length,
            total_tokens: text.length + think.length,
          },
        };
      }
    } finally {
      try {
        await this.deleteSession(sessionId);
      } catch {
        // 忽略
      }
    }
  }
}

/** 多账号轮询计数器 */
let roundRobinCounter = 0;

/** 获取一个可用的 DeepSeekClient 实例(多账号轮询) */
export function getClientForApiKey(apiKey: string): DeepSeekClient | null {
  const account = resolveAccountByApiKey(apiKey);
  if (!account) return null;
  return new DeepSeekClient(account);
}

/** 获取任意一个可用的 DeepSeekClient(无 API Key 时回退到第一个账号) */
export function getAnyClient(): DeepSeekClient | null {
  const accounts = getAdminAccounts();
  if (accounts.length === 0) return null;
  const idx = roundRobinCounter++ % accounts.length;
  return new DeepSeekClient(accounts[idx]);
}