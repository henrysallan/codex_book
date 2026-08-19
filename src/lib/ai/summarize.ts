/**
 * Summarizer & Tagger — uses Groq (Llama 3.1 8B) to generate
 * chunk summaries, chunk tags, document summaries, and document tags.
 */

import Groq from "groq-sdk";
import { logUsage } from "./usage";
import { groqLimited } from "./groqLimiter";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY ?? "" });

const MODEL = "llama-3.1-8b-instant";

// ─── Chunk Summary + Tags ───

export interface ChunkSummaryResult {
  summary: string;
  tags: string[];
}

/**
 * Summarize a single chunk and generate 2-3 tags.
 * Uses the controlled vocabulary of existing tags when available.
 */
export async function summarizeChunk(
  content: string,
  existingTags: string[] = [],
  documentId?: string
): Promise<ChunkSummaryResult> {
  const existingTagsList =
    existingTags.length > 0
      ? existingTags.join(", ")
      : "(none yet — create new tags as needed)";

  const response = await groqLimited(() => groq.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content: "You summarize passages from a personal knowledge base. Always respond with valid JSON only, no markdown.",
      },
      {
        role: "user",
        content: `Summarize this passage and generate tags.

<passage>
${content}
</passage>

Respond with JSON only:
{
  "summary": "1-2 sentence summary. Be specific — include names, concepts, and conclusions, not vague descriptions.",
  "tags": ["tag1", "tag2"]
}

Existing tags in this knowledge base (reuse these where possible):
${existingTagsList}

Rules for tags:
- 2-3 tags per chunk
- Lowercase, hyphenated (e.g. "real-time-sync", "client-work")
- Reuse existing tags before inventing new ones
- Be specific: "wittgenstein-language-games" not "philosophy"`,
      },
    ],
    temperature: 0.3,
    max_tokens: 300,
  }));

  const usage = response.usage;
  if (usage) {
    await logUsage({
      flow: "index-summarize-chunk",
      provider: "groq",
      model: MODEL,
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      documentId,
    });
  }

  const raw = response.choices[0]?.message?.content ?? "";
  try {
    // Extract JSON from the response (handle possible markdown fences)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    };
  } catch {
    console.warn("[summarize] Failed to parse chunk summary response:", raw);
    return { summary: "", tags: [] };
  }
}

// ─── Document Summary ───

/**
 * Generate a 2-3 sentence document-level summary from chunk summaries.
 */
export async function summarizeDocument(
  title: string,
  chunkSummaries: string[],
  documentId?: string
): Promise<string> {
  if (chunkSummaries.length === 0) return "";

  const numbered = chunkSummaries
    .map((s, i) => `${i + 1}. ${s}`)
    .join("\n");

  const response = await groqLimited(() => groq.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content: "You summarize documents from a personal knowledge base. Respond with only the summary text, no JSON or markdown formatting.",
      },
      {
        role: "user",
        content: `Below are summaries of each section of a document titled "${title}".

${numbered}

Write a 2-3 sentence summary of the entire document. Capture the overall scope, main argument or topic, and any open questions or conclusions.`,
      },
    ],
    temperature: 0.3,
    max_tokens: 300,
  }));

  const usage = response.usage;
  if (usage) {
    await logUsage({
      flow: "index-summarize-doc",
      provider: "groq",
      model: MODEL,
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      documentId,
    });
  }

  return response.choices[0]?.message?.content?.trim() ?? "";
}

// ─── Document Tags ───

/**
 * Generate 5-10 document-level tags from the summary and chunk tags.
 */
export async function tagDocument(
  title: string,
  summary: string,
  chunkTags: string[],
  existingTags: string[] = [],
  documentId?: string
): Promise<string[]> {
  const uniqueChunkTags = [...new Set(chunkTags)];
  const existingTagsList =
    existingTags.length > 0
      ? existingTags.join(", ")
      : "(none yet — create new tags as needed)";

  const response = await groqLimited(() => groq.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content: "You tag documents from a personal knowledge base. Always respond with valid JSON only, no markdown.",
      },
      {
        role: "user",
        content: `Tag this document from a personal knowledge base.

Document title: "${title}"
Document summary: "${summary}"
Section tags: ${uniqueChunkTags.join(", ")}

Generate 5-10 document-level tags. These are broader than section tags — include topic categories, project names, people, and technologies.

Existing tags in this knowledge base (reuse where possible):
${existingTagsList}

Respond with JSON only:
{
  "tags": ["tag1", "tag2", "tag3"]
}

Rules:
- Lowercase, hyphenated
- Reuse existing tags before inventing new ones
- Include chunk tags that are relevant to the whole document
- Add broader category tags the chunks might not have captured`,
      },
    ],
    temperature: 0.3,
    max_tokens: 300,
  }));

  const usage = response.usage;
  if (usage) {
    await logUsage({
      flow: "index-tags-doc",
      provider: "groq",
      model: MODEL,
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      documentId,
    });
  }

  const raw = response.choices[0]?.message?.content ?? "";
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    const parsed = JSON.parse(jsonMatch[0]);
    return Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 10) : [];
  } catch {
    console.warn("[summarize] Failed to parse document tags response:", raw);
    return [];
  }
}
