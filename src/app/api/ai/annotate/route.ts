import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { logUsage } from "@/lib/ai/usage";
import { embedText } from "@/lib/ai/embed";
import {
  getServerSupabase,
  isServerSupabaseConfigured,
} from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const maxDuration = 60;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
});

const MODEL = "claude-haiku-4-5-20251001";

/**
 * Fetch the surrounding document content to give the model context
 * about *where* the highlighted text lives.
 */
async function fetchDocumentContext(
  documentId: string
): Promise<{ title: string; plainText: string } | null> {
  if (!isServerSupabaseConfigured()) return null;
  const supabase = getServerSupabase();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("documents")
    .select("title, content")
    .eq("id", documentId)
    .single();

  if (error || !data) return null;

  // Convert BlockNote JSON to a readable plain-text excerpt
  try {
    const blocks = JSON.parse(data.content);
    const plainText = blocksToPlainText(blocks).slice(0, 4000); // cap at ~4k chars
    return { title: data.title, plainText };
  } catch {
    return { title: data.title, plainText: "" };
  }
}

/**
 * Very lightweight BlockNote → plain text (for system prompt context).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function blocksToPlainText(blocks: any[]): string {
  const lines: string[] = [];

  for (const block of blocks) {
    if (block.type === "heading") {
      const level = block.props?.level ?? 1;
      const prefix = "#".repeat(level) + " ";
      lines.push(prefix + inlineToText(block.content));
    } else if (block.type === "bulletListItem" || block.type === "numberedListItem") {
      lines.push("• " + inlineToText(block.content));
    } else if (block.type === "paragraph") {
      lines.push(inlineToText(block.content));
    } else if (block.type === "database") {
      lines.push("[Database table]");
    }

    // Recurse into children
    if (Array.isArray(block.children) && block.children.length > 0) {
      lines.push(blocksToPlainText(block.children));
    }
  }

  return lines.join("\n");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function inlineToText(content: any): string {
  if (!Array.isArray(content)) return "";
  return content
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((c: any) => {
      if (typeof c === "string") return c;
      if (c.type === "text") return c.text ?? "";
      if (c.type === "pageLink") return c.props?.docTitle ?? "link";
      return "";
    })
    .join("");
}

/**
 * Build the system prompt with the highlighted text and surrounding
 * document context.
 */
function buildSystemPrompt(
  highlightedText: string,
  docContext: { title: string; plainText: string } | null
): string {
  let prompt = `You are Cortex, a helpful AI writing assistant embedded in a note-taking app. The user has highlighted a passage of text and wants to discuss it with you.

## Highlighted text
"${highlightedText}"
`;

  if (docContext) {
    prompt += `
## Document context
Title: ${docContext.title}

The highlighted text appears in the following document:

${docContext.plainText}
`;
  }

  prompt += `
## Guidelines
- Be concise and helpful. Match the tone of the user's writing.
- Respond directly to the user's question or comment about the highlighted text.
- If asked to rewrite, edit, or improve text, provide the revised version directly.
- Use markdown formatting when appropriate (bold, lists, code blocks).
- If the question is unclear, ask a brief clarifying question.
- Do NOT repeat the highlighted text back unless specifically asked.
`;

  return prompt;
}

/**
 * Generate and store an embedding for an annotation thread
 * so it's searchable in Flow 1.
 */
async function embedAnnotation(
  annotationId: string,
  highlightedText: string,
  messages: { role: string; content: string }[],
  lastAssistantResponse: string
): Promise<void> {
  const supabase = getServerSupabase();
  if (!supabase) return;

  // Build a concise text representation of the thread for embedding
  const threadText = [
    `Highlighted: ${highlightedText}`,
    ...messages.slice(-4).map((m) => `${m.role}: ${m.content}`),
    `assistant: ${lastAssistantResponse}`,
  ].join("\n");

  // Build a one-line summary for the summary column
  const summary = lastAssistantResponse.slice(0, 300);

  const embedding = await embedText(threadText, { documentId: undefined });

  await supabase
    .from("annotations")
    .update({ summary, embedding: JSON.stringify(embedding) })
    .eq("id", annotationId);
}

/**
 * POST /api/ai/annotate
 *
 * Handles Flow 3 (Inline Annotation Chat).
 * Streams an AI response about highlighted text using Anthropic Haiku 3.5.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      annotationId,
      documentId,
      highlightedText,
      messages,
    } = body as {
      annotationId: string;
      documentId: string;
      highlightedText: string;
      messages: { role: "user" | "assistant"; content: string }[];
    };

    if (!highlightedText || !messages || messages.length === 0) {
      return NextResponse.json(
        { error: "Missing required fields: highlightedText, messages" },
        { status: 400 }
      );
    }

    // Fetch surrounding document for context
    const docContext = documentId
      ? await fetchDocumentContext(documentId)
      : null;

    const systemPrompt = buildSystemPrompt(highlightedText, docContext);

    // Build Anthropic message array from conversation history
    const anthropicMessages: Anthropic.MessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Stream the response
    const encoder = new TextEncoder();
    let inputTokens = 0;
    let outputTokens = 0;
    let finalResponseText = "";

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const response = anthropic.messages.stream({
            model: MODEL,
            max_tokens: 1024,
            system: systemPrompt,
            messages: anthropicMessages,
          });

          response.on("text", (text) => {
            finalResponseText += text;
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "text", content: text })}\n\n`
              )
            );
          });

          // Wait for the stream to finish and collect usage
          const finalMessage = await response.finalMessage();
          inputTokens = finalMessage.usage?.input_tokens ?? 0;
          outputTokens = finalMessage.usage?.output_tokens ?? 0;

          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`)
          );
          controller.close();

          // Log usage (fire and forget)
          logUsage({
            flow: "annotate",
            provider: "anthropic",
            model: MODEL,
            inputTokens,
            outputTokens,
            documentId: documentId ?? undefined,
          }).catch(() => {});

          // Embed the annotation thread (fire and forget)
          // After 2+ messages (at least one exchange), generate an embedding
          // so the annotation is searchable in Flow 1
          if (messages.length >= 2 && annotationId) {
            embedAnnotation(annotationId, highlightedText, messages, finalResponseText).catch(
              (e: unknown) => console.error("[/api/ai/annotate] Embedding error:", e)
            );
          }
        } catch (err) {
          console.error("[/api/ai/annotate] Stream error:", err);
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

    void annotationId; // used for logging context, not needed in prompt

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    console.error("[/api/ai/annotate] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
