import { getServerSupabase } from "@/lib/supabaseServer";

interface UsageParams {
  userId?: string;
  flow: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  documentId?: string;
}

/**
 * Log AI token usage to the usage_logs table.
 * Called at the end of every API route after the LLM response completes.
 * Fails silently — usage tracking should never break the main response.
 */
export async function logUsage(params: UsageParams): Promise<void> {
  try {
    const supabase = getServerSupabase();
    if (!supabase) {
      // No server-side Supabase configured — log to console as fallback
      console.log("[usage]", {
        flow: params.flow,
        provider: params.provider,
        model: params.model,
        input_tokens: params.inputTokens,
        output_tokens: params.outputTokens,
      });
      return;
    }

    const { error } = await supabase.from("usage_logs").insert({
      user_id: params.userId ?? "local",
      flow: params.flow,
      provider: params.provider,
      model: params.model,
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
      document_id: params.documentId ?? null,
    });

    if (error) {
      console.error("[usage] Failed to log usage:", error.message);
    }
  } catch (err) {
    console.error("[usage] Unexpected error logging usage:", err);
  }
}
