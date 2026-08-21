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
  rerankChunks,
} from "@/lib/ai/retrieve";
import type { SourceMap } from "@/lib/types";
import {
  assembleTier0Context,
  assembleTier1Context,
  assembleTier2Context,
  assembleContextTierContext,
  assembleGeneralContext,
  selectModel,
  usesAdaptiveThinking,
  MODEL_HAIKU,
  MODEL_SONNET,
  MODEL_OPUS,
  type ContextItem,
} from "@/lib/ai/context";
import { CHAT_TOOLS, executeTool } from "@/lib/ai/tools";

import { requireUserForAI } from "@/lib/serverAuth";
export const runtime = "nodejs";
export const maxDuration = 120;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
});

async function resolvePinnedContext(
  contextItems: ContextItem[] | undefined,
  userId: string
): Promise<{
  docs: { id: string; title: string; content: string }[];
  blockItems: ContextItem[];
  docIds: string[];
}> {
  const items = contextItems ?? [];
  const docItems = items.filter(
    (ci): ci is ContextItem & { docId: string } =>
      ci.type === "document" && !!ci.docId
  );
  const docIds = docItems.map((ci) => ci.docId);
  const blockItems = items.filter((ci) => ci.type === "block");

  const clientDocs: { id: string; title: string; content: string }[] = [];
  const missingDocIds: string[] = [];
  for (const ci of docItems) {
    if (typeof ci.content === "string" && ci.content.trim() && ci.content.trim() !== "[]") {
      clientDocs.push({
        id: ci.docId,
        title: ci.title ?? "Untitled",
        content: ci.content,
      });
    } else {
      missingDocIds.push(ci.docId);
    }
  }

  let dbDocs: { id: string; title: string; content: string }[] = [];
  if (missingDocIds.length > 0) {
    dbDocs = await fetchContextDocuments(missingDocIds, userId);
  }

  return { docs: [...clientDocs, ...dbDocs], blockItems, docIds };
}

function isAbortLike(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  return (
    e.name === "AbortError" ||
    e.name === "APIUserAbortError" ||
    /aborted/i.test(e.message ?? "")
  );
}

function enqueueSse(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  payload: unknown
) {
  try {
    controller.enqueue(
      encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
    );
  } catch {
    // Controller already closed (client gone).
  }
}

function attachChatStream(
  response: ReturnType<typeof anthropic.messages.stream>,
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  signal?: AbortSignal
) {
  response.on("text", (text: string) => {
    if (signal?.aborted) return;
    enqueueSse(controller, encoder, { type: "text", content: text });
  });
  response.on("contentBlock", (block: Anthropic.ContentBlock) => {
    if (signal?.aborted) return;
    if (block.type === "server_tool_use") {
      enqueueSse(controller, encoder, { type: "tool_use", tool: block.name });
    }
  });
}

function chatStreamParams(
  model: string,
  systemPrompt: string,
  messages: Anthropic.MessageParam[],
  tools?: Anthropic.Messages.ToolUnion[]
): Anthropic.MessageCreateParamsStreaming {
  const adaptive = usesAdaptiveThinking(model);
  return {
    model,
    max_tokens: adaptive ? 8192 : 4096,
    system: systemPrompt,
    messages,
    stream: true,
    ...(tools ? { tools } : {}),
    ...(adaptive ? { output_config: { effort: "medium" } } : {}),
  };
}

/**
 * POST /api/ai/chat
 *
 * Handles Flow 1 (General Search & Insight) and Flow 2 (Context-Based Query).
 * Pipeline: route query → retrieve → assemble context → stream LLM response.
 */
export async function POST(req: NextRequest) {
  // These routes run with the service-role key and spend real LLM credits.
  // Requires Authorization: Bearer <supabase access token> — the web client
  // attaches it via authedFetch, trac3 via its Supabase session.
  const auth = await requireUserForAI(req);
  if (auth instanceof NextResponse) return auth;
  const userId = auth.id;

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

    if (tier === "GENERAL") {
      // Research mode — no automatic retrieval. Pinned notes are still included.
      const pinned = await resolvePinnedContext(contextItems, userId);
      const ctx = assembleGeneralContext(pinned.docs, pinned.blockItems);
      systemPrompt = ctx.systemPrompt;
      contextTokens = ctx.contextTokens;
      sourceMap = ctx.sourceMap;
      documentIds = pinned.docIds;
      console.log(
        `[/api/ai/chat] GENERAL tier — research mode` +
          (pinned.docs.length > 0
            ? ` with ${pinned.docs.length} pinned note(s)`
            : " (no pinned notes)")
      );
    }

    if (tier === "TIER0") {
      // Current document only
      if (!activeDocumentId) {
        // Fallback to TIER1 if no active document
        tier = "TIER1";
      } else {
        // Prefer client-provided content, fall back to DB fetch
        const doc = activeDocumentContent
          ? { title: "Current Document", content: activeDocumentContent }
          : await fetchDocumentContent(activeDocumentId, userId);
        if (doc) {
          const ctx = assembleTier0Context(doc);
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
        keywordSearch(effectiveQuery, userId),
      ]);
      const vectorChunks = await retrieveChunks(embedding, userId, {
        threshold: 0.4,
        count: 25,
        maxPerDocument: 5,
      });

      // Convert keyword results to synthetic chunks, excluding docs already found by vector
      const vectorDocIds = new Set(vectorChunks.map((c) => c.document_id));
      const kwChunks = keywordResultsToChunks(kwResults, vectorDocIds);

      // Merge: vector chunks first (higher precision), then keyword chunks
      // Then rerank all results by combined score (similarity + term overlap + source signal)
      const merged = [...vectorChunks, ...kwChunks];
      const allChunks = rerankChunks(merged, effectiveQuery, { limit: 20 });

      console.log(
        `[/api/ai/chat] TIER1 hybrid: ${vectorChunks.length} vector chunks + ${kwChunks.length} keyword docs = ${merged.length} merged → ${allChunks.length} after rerank`
      );

      // Fetch titles for all unique doc IDs so sourceMap has real names
      const allDocIds = [...new Set(allChunks.map((c) => c.document_id))];
      // Keyword results already have titles — build a pre-filled title map
      const kwTitleMap = new Map(kwResults.map((kr) => [kr.id, kr.title]));
      const missingTitleIds = allDocIds.filter((id) => !kwTitleMap.has(id));
      const dbTitles = missingTitleIds.length > 0 ? await fetchDocumentTitles(missingTitleIds, userId) : new Map<string, string>();
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
        keywordSearch(effectiveQuery, userId),
      ]);
      const vectorChunks = await retrieveChunks(embedding, userId, {
        threshold: 0.35,
        count: 30,
        maxPerDocument: 6,
      });
      const vectorDocs = await retrieveDocuments(vectorChunks, userId, { maxDocuments: 4 });

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
        const kwDocs = await fetchDocumentsById(additionalDocIds, userId);
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
      const pinned = await resolvePinnedContext(contextItems, userId);
      let docs = pinned.docs;
      console.log(
        `[/api/ai/chat] CONTEXT tier — ${docs.length} docs (${pinned.docs.length} resolved)`,
        docs.map((d) => ({ id: d.id, title: d.title, contentLen: d.content?.length ?? 0 }))
      );

      // Fallback: if still empty, try fetching active document
      if (docs.length === 0 && activeDocumentId) {
        console.log(`[/api/ai/chat] CONTEXT tier — fallback: fetching active doc ${activeDocumentId}`);
        const fallback = await fetchDocumentContent(activeDocumentId, userId);
        if (fallback) {
          docs = [{ id: activeDocumentId, title: fallback.title, content: fallback.content }];
        }
      }

      const ctx = assembleContextTierContext(docs, pinned.blockItems);
      systemPrompt = ctx.systemPrompt;
      contextTokens = ctx.contextTokens;
      sourceMap = ctx.sourceMap;
      documentIds = pinned.docIds.length > 0 ? pinned.docIds : (activeDocumentId ? [activeDocumentId] : []);
    }

    // Safety fallback
    systemPrompt ??= "You are Cortex, a helpful AI assistant for a note-taking app.";
    contextTokens ??= 100;

    // ─── Step 3: Select model ───

    const MODEL_MAP: Record<string, string> = {
      "Claude Haiku": MODEL_HAIKU,
      "Claude Sonnet": MODEL_SONNET,
      "Claude Opus": MODEL_OPUS,
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

    const runAbort = new AbortController();
    const onClientAbort = () => runAbort.abort();
    if (req.signal.aborted) runAbort.abort();
    else req.signal.addEventListener("abort", onClientAbort, { once: true });

    let currentAnthropic: ReturnType<typeof anthropic.messages.stream> | null =
      null;

    const stream = new ReadableStream({
      async start(controller) {
        const streamOpts = { signal: runAbort.signal };

        const startModelStream = (
          params: Anthropic.MessageCreateParamsStreaming
        ) => {
          const response = anthropic.messages.stream(params, streamOpts);
          currentAnthropic = response;
          attachChatStream(response, controller, encoder, runAbort.signal);
          return response;
        };

        const forceFinalAnswer = async (reason: string) => {
          console.warn(`[/api/ai/chat] Forcing final answer (${reason})`);
          const response = startModelStream(
            chatStreamParams(model, systemPrompt, [
              ...currentMessages,
              {
                role: "user",
                content:
                  "You have gathered enough information. Please answer the original question now using the tool results you already have. Do not call any more tools.",
              },
            ])
          );
          const final = await response.finalMessage();
          inputTokens += final.usage?.input_tokens ?? 0;
          outputTokens += final.usage?.output_tokens ?? 0;
        };

        try {
          enqueueSse(controller, encoder, {
            type: "meta",
            tier,
            model,
            documentIds,
            sourceMap,
          });

          let answered = false;
          for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            if (runAbort.signal.aborted) break;

            if (round > 0) {
              const msgChars = JSON.stringify(currentMessages).length;
              const sysChars = systemPrompt.length;
              const estimatedTokens = Math.ceil((msgChars + sysChars) / 4);
              if (estimatedTokens > MAX_INPUT_TOKENS) {
                await forceFinalAnswer(
                  `token budget ~${estimatedTokens} at round ${round}`
                );
                answered = true;
                break;
              }
            }

            const response = startModelStream(
              chatStreamParams(model, systemPrompt, currentMessages, CHAT_TOOLS)
            );

            const finalMessage = await response.finalMessage();
            inputTokens += finalMessage.usage?.input_tokens ?? 0;
            outputTokens += finalMessage.usage?.output_tokens ?? 0;

            // Server tools (web_search) are executed by Anthropic. pause_turn
            // means the search turn was long — send the assistant message back
            // unchanged so the model can continue.
            if (finalMessage.stop_reason === "pause_turn") {
              currentMessages.push({
                role: "assistant",
                content:
                  finalMessage.content as unknown as Anthropic.Messages.ContentBlockParam[],
              });
              console.log(`[/api/ai/chat] pause_turn at round ${round + 1}`);
              continue;
            }

            // Client tools only — web_search results are already in the message
            if (finalMessage.stop_reason !== "tool_use") {
              answered = true;
              break;
            }

            const toolBlocks = finalMessage.content.filter(
              (b): b is Anthropic.ToolUseBlock =>
                b.type === "tool_use" && b.name !== "web_search"
            );

            if (toolBlocks.length === 0) {
              answered = true;
              break;
            }

            for (const tool of toolBlocks) {
              enqueueSse(controller, encoder, {
                type: "tool_use",
                tool: tool.name,
              });
            }

            const toolResults: Anthropic.Messages.ToolResultBlockParam[] =
              await Promise.all(
                toolBlocks.map(async (tool) => ({
                  type: "tool_result" as const,
                  tool_use_id: tool.id,
                  content: await executeTool(
                    tool.name,
                    tool.input as Record<string, unknown>,
                    userId
                  ),
                }))
              );

            for (let ti = 0; ti < toolBlocks.length; ti++) {
              if (toolBlocks[ti].name === "create_note") {
                try {
                  const result = JSON.parse(
                    toolResults[ti].content as string
                  );
                  if (result.success && result.id) {
                    enqueueSse(controller, encoder, {
                      type: "doc_created",
                      docId: result.id,
                      title: result.title,
                    });
                  }
                } catch {
                  // skip if result isn't parseable
                }
              }
            }

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

          // Round exhaustion (or pause_turn on the last round) used to emit
          // `done` with no synthesis call — a blank reply after 5 tool rounds.
          if (!answered && !runAbort.signal.aborted) {
            await forceFinalAnswer("tool-round exhaustion");
          }

          if (!runAbort.signal.aborted) {
            enqueueSse(controller, encoder, {
              type: "done",
              tier,
              model,
              documentIds,
              sourceMap,
            });
          }
          try {
            controller.close();
          } catch {
            // already closed
          }

          logUsage({
            flow: `chat-${tier.toLowerCase()}`,
            provider: "anthropic",
            model,
            inputTokens,
            outputTokens,
            documentId: activeDocumentId ?? undefined,
            userId,
          }).catch(() => {});
        } catch (err) {
          if (runAbort.signal.aborted || isAbortLike(err)) {
            try {
              controller.close();
            } catch {
              // already closed
            }
            return;
          }
          console.error("[/api/ai/chat] Stream error:", err);
          const errorMsg =
            err instanceof Error ? err.message : "Unknown error";
          enqueueSse(controller, encoder, { type: "error", content: errorMsg });
          try {
            controller.close();
          } catch {
            // already closed
          }
        } finally {
          req.signal.removeEventListener("abort", onClientAbort);
        }
      },
      cancel() {
        runAbort.abort();
        currentAnthropic?.abort();
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
