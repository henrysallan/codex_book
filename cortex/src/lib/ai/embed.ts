/**
 * Embedder — uses OpenAI text-embedding-3-small to generate
 * vector embeddings for chunks and documents.
 */

import OpenAI from "openai";
import { logUsage } from "./usage";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });

const MODEL = "text-embedding-3-small";

/**
 * Embed one or more text strings in a single batched API call.
 * Returns an array of embedding vectors (1536 dimensions each),
 * in the same order as the input texts.
 */
export async function embedTexts(
  texts: string[],
  options?: {
    flow?: string;
    documentId?: string;
  }
): Promise<number[][]> {
  if (texts.length === 0) return [];

  // OpenAI allows up to 2048 inputs per call; we'll batch in groups of 100
  const BATCH_SIZE = 100;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const response = await openai.embeddings.create({
      model: MODEL,
      input: batch,
    });

    // Log usage
    const usage = response.usage;
    if (usage) {
      await logUsage({
        flow: options?.flow ?? "index-embed",
        provider: "openai",
        model: MODEL,
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: 0,
        documentId: options?.documentId,
      });
    }

    // Sort by index to ensure order matches input
    const sorted = response.data.sort((a, b) => a.index - b.index);
    for (const item of sorted) {
      allEmbeddings.push(item.embedding);
    }
  }

  return allEmbeddings;
}

/**
 * Embed a single text string. Convenience wrapper around embedTexts.
 */
export async function embedText(
  text: string,
  options?: {
    flow?: string;
    documentId?: string;
  }
): Promise<number[]> {
  const [embedding] = await embedTexts([text], options);
  return embedding;
}
