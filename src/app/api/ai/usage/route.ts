import { NextResponse } from "next/server";
import {
  getServerSupabase,
  isServerSupabaseConfigured,
} from "@/lib/supabaseServer";

export const runtime = "nodejs";

/**
 * GET /api/ai/usage
 *
 * Returns aggregated usage data for the cost dashboard.
 * Query params:
 *   - days: number of days to look back (default 30)
 */
export async function GET(req: Request) {
  if (!isServerSupabaseConfigured()) {
    return NextResponse.json(
      { error: "Server Supabase not configured" },
      { status: 503 }
    );
  }

  const supabase = getServerSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Supabase client unavailable" },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const days = parseInt(url.searchParams.get("days") ?? "30", 10);
  const since = new Date();
  since.setDate(since.getDate() - days);

  // Fetch all usage logs within the time window.
  // Supabase/PostgREST defaults to 1000 rows max, so we paginate.
  const PAGE_SIZE = 1000;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allRows: any[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from("usage_logs")
      .select("flow, provider, model, input_tokens, output_tokens, created_at")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      console.error("[/api/ai/usage] Error:", error);
      return NextResponse.json(
        { error: "Failed to fetch usage data" },
        { status: 500 }
      );
    }

    const page = data ?? [];
    allRows.push(...page);
    offset += PAGE_SIZE;
    hasMore = page.length === PAGE_SIZE;
  }

  const rows = allRows;

  // ─── Aggregate by flow ───

  const byFlow: Record<string, { inputTokens: number; outputTokens: number; calls: number }> = {};
  let totalInput = 0;
  let totalOutput = 0;
  let totalCalls = 0;

  // ─── Aggregate by day ───

  const byDay: Record<string, { inputTokens: number; outputTokens: number; calls: number }> = {};

  // ─── Aggregate by model ───

  const byModel: Record<string, { inputTokens: number; outputTokens: number; calls: number }> = {};

  for (const row of rows) {
    const input = row.input_tokens ?? 0;
    const output = row.output_tokens ?? 0;

    totalInput += input;
    totalOutput += output;
    totalCalls++;

    // By flow
    if (!byFlow[row.flow]) byFlow[row.flow] = { inputTokens: 0, outputTokens: 0, calls: 0 };
    byFlow[row.flow].inputTokens += input;
    byFlow[row.flow].outputTokens += output;
    byFlow[row.flow].calls++;

    // By day
    const day = row.created_at?.slice(0, 10) ?? "unknown";
    if (!byDay[day]) byDay[day] = { inputTokens: 0, outputTokens: 0, calls: 0 };
    byDay[day].inputTokens += input;
    byDay[day].outputTokens += output;
    byDay[day].calls++;

    // By model
    if (!byModel[row.model]) byModel[row.model] = { inputTokens: 0, outputTokens: 0, calls: 0 };
    byModel[row.model].inputTokens += input;
    byModel[row.model].outputTokens += output;
    byModel[row.model].calls++;
  }

  // ─── Estimate costs (rough per-token pricing) ───

  const PRICING: Record<string, { input: number; output: number }> = {
    "claude-3-5-haiku-20241022": { input: 0.80, output: 4.00 },
    "claude-haiku-4-5-20251001": { input: 0.80, output: 4.00 },
    "claude-sonnet-4-20250514": { input: 3.00, output: 15.00 },
    "claude-sonnet-4-6": { input: 3.00, output: 15.00 },
    "llama-3.1-8b-instant": { input: 0.05, output: 0.08 },
    "text-embedding-3-small": { input: 0.02, output: 0.0 },
  };

  let totalCostUsd = 0;
  const costByModel: Record<string, number> = {};

  for (const [modelName, stats] of Object.entries(byModel)) {
    const pricing = PRICING[modelName] ?? { input: 1.0, output: 3.0 };
    const cost =
      (stats.inputTokens / 1_000_000) * pricing.input +
      (stats.outputTokens / 1_000_000) * pricing.output;
    costByModel[modelName] = cost;
    totalCostUsd += cost;
  }

  return NextResponse.json({
    days,
    totalCalls,
    totalInput,
    totalOutput,
    totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
    byFlow,
    byDay,
    byModel,
    costByModel,
  });
}
