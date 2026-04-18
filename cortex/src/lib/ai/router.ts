/**
 * Query Router — determines which retrieval tier to use.
 *
 * Three-layer system:
 * 1. Affirmation resolution (carry prior-turn intent into short "yes"/"ok" replies)
 * 2. Heuristic overrides (instant, no API call)
 * 3. Groq Llama 3.1 8B classifier (~30ms, 1-token output)
 */

import Groq from "groq-sdk";
import { logUsage } from "./usage";
import { groqLimited } from "./groqLimiter";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY ?? "" });
const MODEL = "llama-3.1-8b-instant";

export type Tier = "TIER0" | "TIER1" | "TIER2" | "CONTEXT" | "GENERAL";

interface RouteInput {
  query: string;
  hasActiveDocument: boolean;
  contextItemCount: number;
  /** Length of the full conversation (including assistant turns). */
  conversationLength: number;
  /**
   * Prior user messages in chronological order (most recent last, NOT including `query`).
   * Used to resolve short affirmations like "yes" back to the substantive prior query.
   */
  priorUserQueries?: string[];
}

/**
 * Route a user query to the appropriate retrieval tier.
 * Returns the tier, the effective query used for routing, and whether the classifier was used.
 */
export async function routeQuery(
  input: RouteInput
): Promise<{ tier: Tier; source: "heuristic" | "classifier" | "affirmation"; effectiveQuery: string }> {
  // ─── Layer 1: Affirmation resolution ───
  // If the user just said "yes" / "ok" / "do it", route as if they sent the
  // substantive prior user message. This matches the common follow-up flow:
  //   user: "explain ethics according to my notes"
  //   assistant: "should I search your knowledge base?"
  //   user: "yes"  ← this should route like the first message, not "yes"
  let effectiveQuery = input.query;
  let source: "heuristic" | "classifier" | "affirmation" = "heuristic";

  if (isShortAffirmation(input.query) && input.priorUserQueries?.length) {
    const prior = findLastSubstantiveQuery(input.priorUserQueries);
    if (prior) {
      effectiveQuery = prior;
      source = "affirmation";
    }
  }

  const effectiveInput: RouteInput = { ...input, query: effectiveQuery };

  // ─── Layer 2: Heuristic overrides ───

  const heuristic = applyHeuristics(effectiveInput);
  if (heuristic) {
    // If we resolved an affirmation, keep "affirmation" as the source; otherwise "heuristic".
    const src = source === "affirmation" ? "affirmation" : "heuristic";
    return { tier: heuristic, source: src, effectiveQuery };
  }

  // ─── Layer 3: Groq classifier ───

  const tier = await classifyWithGroq(effectiveQuery, input.hasActiveDocument);
  return { tier, source: source === "affirmation" ? "affirmation" : "classifier", effectiveQuery };
}

// ─── Affirmation detection ───

const SHORT_AFFIRMATION_RE =
  /^\s*(yes|yeah|yep|yup|sure|ok|okay|k|kk|do\s+it|go\s+ahead|please\s+do|please|do\s+that|sounds?\s+good|search|go|continue)\s*[.!?]*\s*$/i;

function isShortAffirmation(query: string): boolean {
  if (!query) return false;
  // Also treat very short queries (<= 3 words) that begin with an affirmation as affirmations.
  return SHORT_AFFIRMATION_RE.test(query);
}

/**
 * Walk backwards through prior user queries and return the first one that
 * looks substantive (not itself an affirmation, at least 4 words).
 */
function findLastSubstantiveQuery(priorQueries: string[]): string | null {
  for (let i = priorQueries.length - 1; i >= 0; i--) {
    const q = priorQueries[i];
    if (!q) continue;
    if (isShortAffirmation(q)) continue;
    const wordCount = q.trim().split(/\s+/).length;
    if (wordCount >= 3) return q;
  }
  return null;
}

// ─── Heuristics ───

/** Forces TIER2 — deep cross-document analysis. */
const TIER2_PATTERNS = [
  /across\s+(all\s+)?my\s+notes?/i,
  /through(out)?\s+(all\s+)?my\s+notes?/i,
  /everything\s+about/i,
  /all\s+my\s+(notes|documents|pages)/i,
  /compare\s+(all|every|multiple)/i,
  /search\s+(all|every)/i,
  /synthesi[sz]e\s+(my|all)/i,
  /compile\s+(all|everything)/i,
];

/**
 * Forces TIER1 — search summaries across notes.
 * These patterns imply the user wants to pull from their knowledge base,
 * even when a document happens to be open in the editor.
 */
const TIER1_PATTERNS = [
  /according\s+to\s+my\s+notes?/i,
  /based\s+on\s+my\s+notes?/i,
  /in\s+my\s+notes?/i,
  /from\s+my\s+notes?/i,
  /my\s+notes?\s+(on|about|regarding)/i,
  /what\s+(have|did)\s+I\s+(written|said|noted|wrote|thought)/i,
  /what\s+do\s+I\s+(have|know|think)\s+(on|about|regarding)/i,
  /find\s+(notes?|documents?|pages?)\s+(on|about)/i,
  /show\s+me\s+(notes?|documents?|pages?)/i,
];

/** Forces TIER0 — current document only. Requires an active document. */
const TIER0_PATTERNS = [
  /^(summarize|rewrite|explain|simplify|expand|shorten|paraphrase)\s+(this|the\s+(document|note|page|section|paragraph))/i,
  /^what\s+(does\s+)?this\s+(say|mean|document|note)/i,
  /^(fix|improve|edit|proofread)\s+this/i,
  /\bin\s+this\s+(document|note|page)\b/i,
  /^tldr\s*(of\s+this)?/i,
];

/**
 * Forces GENERAL — general knowledge / research questions with no reference
 * to the user's notes. Claude answers from training data only.
 */
const GENERAL_PATTERNS = [
  /^(who|what|when|where|why|how)\s+(is|was|are|were|did|does|do|can|could|would|will|has|have|had)\s+/i,
  /^(explain|describe|define|what'?s?|tell\s+me\s+about)\s+(?!this|the\s+(document|note|page))/i,
  /^(list|name|give\s+me)\s+(all|the|some|examples?\s+of)\s+/i,
  /^(can\s+you|could\s+you|please)\s+(explain|describe|tell|help\s+me\s+understand)/i,
  /^(write|draft|compose|create)\s+(a|an|me\s+a)\s+(summary|essay|paragraph|list|outline|overview|poem|story|email|letter)/i,
  /^(translate|convert)(\s+this)?\s+(to|into)/i,
  /^(what|how)\s+(are|is)\s+the\s+(difference|similarities?)\s+between/i,
];

function applyHeuristics(input: RouteInput): Tier | null {
  const { query, hasActiveDocument, contextItemCount } = input;

  // Context items present → CONTEXT mode
  if (contextItemCount > 0) {
    return "CONTEXT";
  }

  // TIER1-forcing patterns ("according to my notes", etc.) take precedence
  // over TIER0 even when a doc is open — the user is explicitly pointing at
  // the knowledge base, not the current editor buffer.
  for (const pattern of TIER1_PATTERNS) {
    if (pattern.test(query)) {
      return "TIER1";
    }
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

  // GENERAL — pure research / knowledge questions that don't reference the
  // user's notes. Only applies when the query has no notes-related keywords.
  const NOTES_ANCHOR_RE = /\b(my\s+notes?|my\s+documents?|my\s+knowledge\s*base|in\s+my|from\s+my|I\s+(wrote|wrote|noted|have))\b/i;
  if (!NOTES_ANCHOR_RE.test(query)) {
    for (const pattern of GENERAL_PATTERNS) {
      if (pattern.test(query)) {
        return "GENERAL";
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
- TIER0: Answerable from the CURRENT document alone. The user is asking about what they are editing right now ("summarize this", "fix the intro", "what does this paragraph mean").
- TIER1: Cross-document search where chunk summaries are enough ("what have I written about X", "find my notes on Y").
- TIER2: Deep cross-document analysis requiring full content ("synthesize my views on X across everything I've written", "compare my notes on A and B").
- GENERAL: General knowledge or research question that does NOT reference the user's notes. The user wants Claude to answer from its own training knowledge, not from their notebook. Examples: "who was Simone Weil", "explain quantum entanglement", "what is the difference between utilitarianism and deontology", "write me a summary of The Republic", "list all of Camus's published works".

Guidance:
- Questions that reference "my notes", "my notebook", "my knowledge base" are almost always TIER1 or TIER2, NEVER TIER0 or GENERAL — even if a document is open.
- Questions like "explain X", "tell me about X", "what is X" (without "in this document" or "in my notes") are GENERAL — the user wants research, not retrieval.
- Only pick TIER0 when the query explicitly points at the current document ("this", "the paragraph above", "the intro I just wrote") or is clearly a rewrite/polish task on the current text.
- Pick GENERAL when the query is asking for factual knowledge, definitions, explanations, creative writing, or research that doesn't depend on the user's personal notes.
- Prefer TIER1 over TIER2 when in doubt — TIER2 is expensive.

Context flag: ${hasActiveDocument ? "a document IS open in the editor." : "NO document is open in the editor."}

Respond with exactly one token: TIER0, TIER1, TIER2, or GENERAL.`;

    const response = await groqLimited(() => groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Query: ${query}` },
      ],
      max_tokens: 4,
      temperature: 0,
    }));

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

    // Parse response — TIER0 only honored when a doc is actually open.
    if (text.includes("TIER0") && hasActiveDocument) return "TIER0";
    if (text.includes("TIER2")) return "TIER2";
    if (text.includes("GENERAL")) return "GENERAL";
    // Default to TIER1 for TIER1, ambiguous, or any unrecognised response.
    return "TIER1";
  } catch (err) {
    console.error("[router] Groq classifier error, falling back to TIER1:", err);
    return "TIER1";
  }
}
