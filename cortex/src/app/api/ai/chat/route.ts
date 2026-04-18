import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { logUsage } from "@/lib/ai/usage";
import { routeQuery, type Tier } from "@/lib/ai/router";
import {
  embedQuery,
  retrieveChunks,
  retrieveDocuments,
  fetchDocumentContent,
  fetchContextDocuments,
  keywordSearch,
  keywordResultsToChunks,
  fetchDocumentsById,
  fetchDocumentTitles,
} from "@/lib/ai/retrieve";
import type { SourceMap } from "@/lib/types";
import {
  assembleTier0Context,
  assembleTier1Context,
  assembleTier2Context,
  assembleContextTierContext,
  selectModel,
  type ContextItem,
} from "@/lib/ai/context";
import { TOOL_DEFINITIONS, executeTool } from "@/lib/ai/tools";

export const runtime = "nodejs";
export const maxDuration = 120;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
});

/**
 * POST /api/ai/chat
 *
 * Handles Flow 1 (General Search & Insight) and Flow 2 (Context-Based Query).
 * Pipeline: route query → retrieve → assemble context → stream LLM response.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      messages,
      activeDocumentId,
      activeDocumentContent,
      contextItems,
      tier: tierOverride,
      modelOverride,
    } = body as {
      messages: { role: "user" | "assistant"; content: string }[];
      activeDocumentId: string | null;
      activeDocumentContent?: string;
      contextItems: ContextItem[];
      tier?: Tier;
      modelOverride?: string;
    };

    if (!messages || messages.length === 0) {
      return NextResponse.json(
        { error: "No messages provided" },
        { status: 400 }
      );
    }

    const userMessages = messages.filter((m) => m.role === "user").map((m) => m.content);
    const lastUserMessage = userMessages[userMessages.length - 1] ?? "";
    const priorUserQueries = userMessages.slice(0, -1);

    // ─── Step 1: Route the query ───

    let tier: Tier;
    // Always run routeQuery so affirmation resolution produces a sensible
    // `effectiveQuery`, even when the client forces a tier via `tierOverride`
    // (e.g. the "Look deeper" button). Otherwise a short follow-up like "yes"
    // would get embedded/keyword-searched verbatim.
    const routeResult = await routeQuery({
      query: lastUserMessage,
      hasActiveDocument: !!activeDocumentId,
      contextItemCount: contextItems?.length ?? 0,
      conversationLength: messages.length,
      priorUserQueries,
    });
    const effectiveQuery = routeResult.effectiveQuery;
    tier = tierOverride ?? routeResult.tier;
    console.log(
      `[/api/ai/chat] Routed to ${tier}` +
        (tierOverride ? ` (override; classifier said ${routeResult.tier})` : ` (source: ${routeResult.source})`) +
        (routeResult.source === "affirmation"
          ? ` — affirmation resolved "${lastUserMessage}" → "${effectiveQuery.slice(0, 80)}"`
          : "")
    );

    // ─── Step 2: Retrieve context based on tier ───

    let systemPrompt: string;
    let contextTokens: number;
    let documentIds: string[] = [];
    let sourceMap: SourceMap = {};

    if (tier === "TIER0") {
      // Current document only
      if (!activeDocumentId) {
        // Fallback to TIER1 if no active document
        tier = "TIER1";
      } else {
        // Prefer client-provided content, fall back to DB fetch
        const doc = activeDocumentContent
          ? { title: "Current Document", content: activeDocumentContent }
          : await fetchDocumentContent(activeDocumentId);
        if (doc) {
          const ctx = assembleTier0Context(doc, effectiveQuery);
          systemPrompt = ctx.systemPrompt;
          contextTokens = ctx.contextTokens;
          documentIds = [activeDocumentId];
        } else {
          tier = "TIER1"; // Fallback
        }
      }
    }

    if (tier === "TIER1") {
      // Hybrid search: keyword + vector in parallel
      const [embedding, kwResults] = await Promise.all([
        embedQuery(effectiveQuery),
        keywordSearch(effectiveQuery),
      ]);
      const vectorChunks = await retrieveChunks(embedding, {
        threshold: 0.4,
        count: 25,
        maxPerDocument: 5,
      });

      // Convert keyword results to synthetic chunks, excluding docs already found by vector
      const vectorDocIds = new Set(vectorChunks.map((c) => c.document_id));
      const kwChunks = keywordResultsToChunks(kwResults, vectorDocIds);

      // Merge: vector chunks first (higher precision), then keyword chunks
      const allChunks = [...vectorChunks, ...kwChunks];

      console.log(
        `[/api/ai/chat] TIER1 hybrid: ${vectorChunks.length} vector chunks + ${kwChunks.length} keyword docs = ${allChunks.length} total`
      );

      // Fetch titles for all unique doc IDs so sourceMap has real names
      const allDocIds = [...new Set(allChunks.map((c) => c.document_id))];
      // Keyword results already have titles — build a pre-filled title map
      const kwTitleMap = new Map(kwResults.map((kr) => [kr.id, kr.title]));
      const missingTitleIds = allDocIds.filter((id) => !kwTitleMap.has(id));
      const dbTitles = missingTitleIds.length > 0 ? await fetchDocumentTitles(missingTitleIds) : new Map<string, string>();
      const titleMap = new Map([...kwTitleMap, ...dbTitles]);

      const ctx = assembleTier1Context(allChunks, titleMap);
      systemPrompt = ctx.systemPrompt;
      contextTokens = ctx.contextTokens;
      documentIds = ctx.documentIds;
      sourceMap = ctx.sourceMap;
    }

    if (tier === "TIER2") {
      // Hybrid search: keyword + vector in parallel
      const [embedding, kwResults] = await Promise.all([
        embedQuery(effectiveQuery),
        keywordSearch(effectiveQuery),
      ]);
      const vectorChunks = await retrieveChunks(embedding, {
        threshold: 0.35,
        count: 30,
        maxPerDocument: 6,
      });
      const vectorDocs = await retrieveDocuments(vectorChunks, { maxDocuments: 4 });

      // Merge keyword-matched docs that vector search missed.
      // Scale the keyword cap so TIER2 always aims for ~7 full docs: when
      // vector returns few/zero (e.g. unindexed docs), lean harder on keyword
      // results rather than shipping a near-empty deep search.
      const vectorDocIds = new Set(vectorDocs.map((d) => d.id));
      const TIER2_TARGET_DOC_COUNT = 7;
      const keywordSlots = Math.max(3, TIER2_TARGET_DOC_COUNT - vectorDocs.length);
      const additionalDocIds = kwResults
        .filter((kr) => !vectorDocIds.has(kr.id))
        .slice(0, keywordSlots)
        .map((kr) => kr.id);

      let allDocs = [...vectorDocs];
      if (additionalDocIds.length > 0) {
        const kwDocs = await fetchDocumentsById(additionalDocIds);
        allDocs = [...vectorDocs, ...kwDocs];
      }

      console.log(
        `[/api/ai/chat] TIER2 hybrid: ${vectorDocs.length} vector docs + ${additionalDocIds.length} keyword docs = ${allDocs.length} total`
      );

      const ctx = assembleTier2Context(allDocs);
      systemPrompt = ctx.systemPrompt;
      contextTokens = ctx.contextTokens;
      documentIds = ctx.documentIds;
      sourceMap = ctx.sourceMap;
    }

    if (tier === "CONTEXT") {
      const docItems = (contextItems ?? [])
        .filter((ci): ci is ContextItem & { docId: string } =>
          ci.type === "document" && !!ci.docId
        );
      const docIds = docItems.map((ci) => ci.docId);
      const blockItems = (contextItems ?? []).filter(
        (ci) => ci.type === "block"
      );

      // Use client-provided content when available (avoids RLS issues with anon key)
      const clientDocs: { id: string; title: string; content: string }[] = [];
      const missingDocIds: string[] = [];
      for (const ci of docItems) {
        if (ci.content) {
          clientDocs.push({ id: ci.docId, title: ci.title ?? "Untitled", content: ci.content });
        } else {
          missingDocIds.push(ci.docId);
        }
      }

      // Only fetch from DB for docs not provided by the client
      let dbDocs: { id: string; title: string; content: string }[] = [];
      if (missingDocIds.length > 0) {
        dbDocs = await fetchContextDocuments(missingDocIds);
      }

      let docs = [...clientDocs, ...dbDocs];
      console.log(
        `[/api/ai/chat] CONTEXT tier — ${docs.length} docs (${clientDocs.length} from client, ${dbDocs.length} from DB)`,
        docs.map((d) => ({ id: d.id, title: d.title, contentLen: d.content?.length ?? 0 }))
      );

      // Fallback: if still empty, try fetching active document
      if (docs.length === 0 && activeDocumentId) {
        console.log(`[/api/ai/chat] CONTEXT tier — fallback: fetching active doc ${activeDocumentId}`);
        const fallback = await fetchDocumentContent(activeDocumentId);
        if (fallback) {
          docs = [{ id: activeDocumentId, title: fallback.title, content: fallback.content }];
        }
      }

      const ctx = assembleContextTierContext(docs, blockItems);
      systemPrompt = ctx.systemPrompt;
      contextTokens = ctx.contextTokens;
      sourceMap = ctx.sourceMap;
      documentIds = docIds.length > 0 ? docIds : (activeDocumentId ? [activeDocumentId] : []);
    }

    // Safety fallback
    systemPrompt ??= "You are Cortex, a helpful AI assistant for a note-taking app.";
    contextTokens ??= 100;

    // ─── Step 3: Select model ───

    const MODEL_MAP: Record<string, string> = {
      "Claude Haiku": "claude-haiku-4-5-20251001",
      "Claude Sonnet": "claude-sonnet-4-6",
    };

    const model = modelOverride && MODEL_MAP[modelOverride]
      ? MODEL_MAP[modelOverride]
      : selectModel(contextTokens);

    // ─── Step 4: Stream response with tool-use loop ───

    const currentMessages: Anthropic.MessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const encoder = new TextEncoder();
    let inputTokens = 0;
    let outputTokens = 0;
    const MAX_TOOL_ROUNDS = 5;
    // Rough token budget: keep total input under this to avoid rate limits.
    // Each char ≈ 0.25 tokens. Haiku limit is 50k/min; leave headroom.
    const MAX_INPUT_TOKENS = 35_000;

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Send metadata event first (tier, model, referenced docs, sourceMap)
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "meta",
                tier,
                model,
                documentIds,
                sourceMap,
              })}\n\n`
            )
          );

          for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
            // Estimate accumulated input size and bail if too large
            if (round > 0) {
              const msgChars = JSON.stringify(currentMessages).length;
              const sysChars = systemPrompt.length;
              const estimatedTokens = Math.ceil((msgChars + sysChars) / 4);
              if (estimatedTokens > MAX_INPUT_TOKENS) {
                console.warn(
                  `[/api/ai/chat] Token budget exceeded (~${estimatedTokens} tokens), stopping tool use at round ${round}`
                );
                // Ask Claude to answer with what it has, no more tools
                const response = anthropic.messages.stream({
                  model,
                  max_tokens: 4096,
                  system: systemPrompt,
                  messages: [
                    ...currentMessages,
                    {
                      role: "user",
                      content:
                        "You have gathered enough information. Please answer the original question now using the tool results you already have. Do not call any more tools.",
                    },
                  ],
                });
                response.on("text", (text) => {
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ type: "text", content: text })}\n\n`
                    )
                  );
                });
                const final = await response.finalMessage();
                inputTokens += final.usage?.input_tokens ?? 0;
                outputTokens += final.usage?.output_tokens ?? 0;
                break;
              }
            }

            const response = anthropic.messages.stream({
              model,
              max_tokens: 4096,
              system: systemPrompt,
              messages: currentMessages,
              tools: TOOL_DEFINITIONS,
            });

            response.on("text", (text) => {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "text", content: text })}\n\n`
                )
              );
            });

            const finalMessage = await response.finalMessage();
            inputTokens += finalMessage.usage?.input_tokens ?? 0;
            outputTokens += finalMessage.usage?.output_tokens ?? 0;

            // If no tool use, we're done
            if (finalMessage.stop_reason !== "tool_use") break;

            // Extract tool_use blocks
            const toolBlocks = finalMessage.content.filter(
              (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
            );

            // Notify client which tools are being used
            for (const tool of toolBlocks) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "tool_use",
                    tool: tool.name,
                  })}\n\n`
                )
              );
            }

            // Execute tools in parallel
            const toolResults: Anthropic.Messages.ToolResultBlockParam[] =
              await Promise.all(
                toolBlocks.map(async (tool) => ({
                  type: "tool_result" as const,
                  tool_use_id: tool.id,
                  content: await executeTool(
                    tool.name,
                    tool.input as Record<string, unknown>
                  ),
                }))
              );

            // Append assistant response + tool results for next round
            currentMessages.push({
              role: "assistant",
              content:
                finalMessage.content as unknown as Anthropic.Messages.ContentBlockParam[],
            });
            currentMessages.push({
              role: "user",
              content: toolResults,
            });

            console.log(
              `[/api/ai/chat] Tool round ${round + 1}: ${toolBlocks.map((t) => t.name).join(", ")}`
            );
          }

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "done",
                tier,
                model,
                documentIds,
                sourceMap,
              })}\n\n`
            )
          );
          controller.close();

          // Log usage (fire and forget)
          logUsage({
            flow: `chat-${tier.toLowerCase()}`,
            provider: "anthropic",
            model,
            inputTokens,
            outputTokens,
            documentId: activeDocumentId ?? undefined,
          }).catch(() => {});
        } catch (err) {
          console.error("[/api/ai/chat] Stream error:", err);
          const errorMsg =
            err instanceof Error ? err.message : "Unknown error";
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "error", content: errorMsg })}\n\n`
            )
          );
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    console.error("[/api/ai/chat] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
