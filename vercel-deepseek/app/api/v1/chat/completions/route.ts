/**
 * POST /v1/chat/completions
 * OpenAI 兼容的聊天接口,支持:
 *   - stream=false: 返回完整 JSON 响应
 *   - stream=true:  SSE (Server-Sent Events) 流式响应
 *   - reasoning_content: 思考过程放在 message/delta.reasoning_content
 *
 * 认证: Authorization: Bearer <APIKEY>
 *   - 未配置 APIKEY 环境变量时允许所有请求
 *   - 每个 API Key 映射到 ADMIN 中的一个账号
 */

import { NextRequest, NextResponse } from "next/server";
import { DeepSeekClient, getClientForApiKey, getAnyClient, type ChatMessage } from "@/lib/deepseek-client";
import { extractApiKey, validateApiKey } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // 1) 认证
  const authHeader = req.headers.get("authorization");
  const apiKey = extractApiKey(authHeader);

  if (!validateApiKey(apiKey || "")) {
    return NextResponse.json(
      { error: "无效的 API Key" },
      { status: 401 }
    );
  }

  // 2) 解析请求体
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "无效的请求体,需要 JSON" },
      { status: 400 }
    );
  }

  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json(
      { error: "缺少 messages 参数" },
      { status: 400 }
    );
  }

  const model = (body.model as string) || "default";
  const stream = Boolean(body.stream);
  const searchEnabled = body.search_enabled !== false;
  const thinkingEnabled = body.thinking_enabled !== false;

  // 3) 获取客户端
  let client: DeepSeekClient | null = null;
  if (apiKey) {
    client = getClientForApiKey(apiKey);
  }
  if (!client) {
    client = getAnyClient();
  }
  if (!client) {
    return NextResponse.json(
      { error: "未配置 ADMIN 环境变量" },
      { status: 500 }
    );
  }

  // 4) 确保 token
  try {
    await client.ensureToken();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[v1/chat] 登录失败:", message);
    return NextResponse.json(
      { error: "DeepSeek 登录失败", detail: message },
      { status: 502 }
    );
  }

  // 5) 流式 / 非流式
  const typedMessages = messages.map((m) => ({
    role: (m.role as ChatMessage["role"]) || "user",
    content: (m.content as string) || "",
  }));

  if (stream) {
    return streamResponse(client, typedMessages, model, searchEnabled, thinkingEnabled);
  }

  try {
    const gen = client.openaiChat(
      typedMessages,
      model,
      false,
      searchEnabled,
      thinkingEnabled
    );

    const first = await gen.next();
    if (first.done) {
      return NextResponse.json(
        { error: "AI 未返回任何内容" },
        { status: 502 }
      );
    }

    return NextResponse.json(first.value);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[v1/chat] 错误:", message);
    return NextResponse.json(
      { error: "AI 请求失败", detail: message },
      { status: 502 }
    );
  }
}

/** SSE 流式响应 */
function streamResponse(
  client: DeepSeekClient,
  messages: ChatMessage[],
  model: string,
  searchEnabled: boolean,
  thinkingEnabled: boolean
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const gen = client.openaiChat(messages, model, true, searchEnabled, thinkingEnabled);

        for await (const chunk of gen) {
          if (chunk.done) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            break;
          }
          const line = `data: ${JSON.stringify(chunk)}\n\n`;
          controller.enqueue(encoder.encode(line));
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[v1/chat stream] 错误:", message);
        const errorChunk = {
          error: { message, type: "server_error" },
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`)
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}