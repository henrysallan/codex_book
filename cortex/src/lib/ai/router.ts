/**
 * Query Router — determines which retrieval tier to use.
 *
 * Two-layer system:
 * 1. Heuristic overrides (instant, no API call)
 * 2. Groq Llama 3.1 8B classifier (~30ms, 1-token output)
 */

import Groq from "groq-sdk";
import { logUsage } from "./usage";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY ?? "" });
const MODEL = "llama-3.1-8b-instant";

export type Tier = "TIER0" | "TIER1" | "TIER2" | "CONTEXT";

interface RouteInput {
  query: string;
  hasActiveDocument: boolean;
  contextItemCount: number;
  /** The first message in the conversation — if multi-turn, routing uses the original query */
  conversationLength: number;
}

/**
 * Route a user query to the appropriate retrieval tier.
 * Returns the tier and whether the classifier was used.
 */
export async function routeQuery(
  input: RouteInput
): Promise<{ tier: Tier; source: "heuristic" | "classifier" }> {
  // ─── Layer 1: Heuristic overrides ───

  const heuristic = applyHeuristics(input);
  if (heuristic) {
    return { tier: heuristic, source: "heuristic" };
  }

  // ─── Layer 2: Groq classifier ───

  const tier = await classifyWithGroq(input.query, input.hasActiveDocument);
  return { tier, source: "classifier" };
}

// ─── Heuristics ───

const TIER2_PATTERNS = [
  /across\s+(all\s+)?my\s+notes/i,
  /everything\s+about/i,
  /all\s+my\s+(notes|documents|pages)/i,
  /compare\s+(all|every|multiple)/i,
  /search\s+(all|every)/i,
];

const TIER0_PATTERNS = [
  /^(summarize|rewrite|explain|simplify|expand|shorten)\s+(this|the)/i,
  /^what\s+(does\s+)?this\s+(say|mean|document)/i,
  /^(fix|improve|edit)\s+this/i,
  /in\s+this\s+(document|note|page)/i,
];

function applyHeuristics(input: RouteInput): Tier | null {
  const { query, hasActiveDocument, contextItemCount } = input;

  // Context items present → CONTEXT mode
  if (contextItemCount > 0) {
    return "CONTEXT";
  }

  // Tier 2 keyword patterns → force deep search
  for (const pattern of TIER2_PATTERNS) {
    if (pattern.test(query)) {
      return "TIER2";
    }
  }

  // Tier 0 keyword patterns (only if a document is open)
  if (hasActiveDocument) {
    for (const pattern of TIER0_PATTERNS) {
      if (pattern.test(query)) {
        return "TIER0";
      }
    }
  }

  // No document open, no context → must search the knowledge base
  if (!hasActiveDocument) {
    return "TIER1";
  }

  // Ambiguous — fall through to classifier
  return null;
}

// ─── Groq Classifier ───

async function classifyWithGroq(
  query: string,
  hasActiveDocument: boolean
): Promise<Tier> {
  try {
    const systemPrompt = `You are a query classifier for a note-taking app with AI search.

Classify the user's query into exactly one category:
- TIER0: Answerable from the current document alone (the user is asking about what they're currently editing)
- TIER1: Needs to search across documents but summaries are sufficient (most cross-document questions)
- TIER2: Needs full document content for deep analysis, comparison, or synthesis across multiple documents

${hasActiveDocument ? "The user currently has a document open in the editor." : "The user does NOT have any document open."}

Respond with exactly one word: TIER0, TIER1, or TIER2`;

    const response = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query },
      ],
      max_tokens: 4,
      temperature: 0,
    });

    const text = response.choices[0]?.message?.content?.trim().toUpperCase() ?? "";

    // Log usage
    const usage = response.usage;
    if (usage) {
      await logUsage({
        flow: "chat-route",
        provider: "groq",
        model: MODEL,
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
      });
    }

    // Parse response
    if (text.includes("TIER0") && hasActiveDocument) return "TIER0";
    if (text.includes("TIER2")) return "TIER2";
    // Default to TIER1 for any ambiguous/unrecognized response
    return "TIER1";
  } catch (err) {
    console.error("[router] Groq classifier error, falling back to TIER1:", err);
    return "TIER1";
  }
}
