/**
 * GET /v1/models
 * 无需 API Key,动态返回 DeepSeek 模型列表
 *
 * 使用第一个可用账号的 token 获取模型列表,
 * 如果所有账号 token 都失效且登录失败,返回错误
 */

import { NextResponse } from "next/server";
import { DeepSeekClient } from "@/lib/deepseek-client";
import { getAdminAccounts } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const accounts = getAdminAccounts();
  if (accounts.length === 0) {
    return NextResponse.json(
      { error: "未配置 ADMIN 环境变量,无法获取模型列表" },
      { status: 500 }
    );
  }

  // 使用第一个账号获取模型列表
  const client = new DeepSeekClient(accounts[0]);

  try {
    await client.ensureToken();
    const result = await client.openaiListModels();
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[v1/models] 错误:", message);
    return NextResponse.json(
      { error: "获取模型列表失败", detail: message },
      { status: 502 }
    );
  }
}