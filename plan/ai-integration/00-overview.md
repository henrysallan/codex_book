# AI Integration — Overview

This document set describes the AI intelligence layer for Cortex. The system has two halves:

1. **The Indexing Pipeline** — background processing that turns documents into a searchable knowledge graph of chunks, summaries, tags, and embeddings.
2. **The Inference Flows** — three distinct ways users interact with AI, each tuned for a different use case and cost profile.

## Architecture Summary

```
┌──────────────────────────────────────────────────┐
│                  User Actions                     │
│  Save doc · Chat query · Highlight text           │
└────────┬──────────────┬──────────────┬────────────┘
         │              │              │
    ┌────▼────┐   ┌─────▼─────┐  ┌────▼─────┐
    │ Indexing │   │  Routing   │  │Annotation│
    │ Pipeline │   │ Classifier │  │  Anchor  │
    └────┬────┘   └─────┬─────┘  └────┬─────┘
         │              │              │
    ┌────▼────┐   ┌─────▼─────┐  ┌────▼─────┐
    │ Chunks  │   │ Tier 0/1/2│  │  Flow 3  │
    │Summaries│   │ Retrieval │  │  (local)  │
    │  Tags   │──▶│  + LLM    │  │  + LLM   │
    │Embeddings│  └───────────┘  └──────────┘
    └─────────┘
```

## Documents in This Set

| Doc | Title | Purpose |
|-----|-------|---------|
| [01](./01-indexing-pipeline.md) | Indexing Pipeline | Chunking, summaries, tagging, embeddings |
| [02](./02-reprocessing.md) | Reprocessing Strategy | Incremental updates on document edits |
| [03](./03-flow-search.md) | Flow 1: General Search & Insight | Tiered retrieval for cross-document queries |
| [04](./04-flow-context.md) | Flow 2: Context-Based Query | Conversations with explicit document context |
| [05](./05-flow-annotation.md) | Flow 3: Inline Annotation | Passage-anchored threaded chats |
| [06](./06-data-model.md) | Data Model | New Supabase tables, columns, and indexes |
| [07](./07-implementation-steps.md) | Implementation Steps | Ordered build plan with dependencies |

## Model & Provider Strategy

| Task | Model | Provider | Approx Cost |
|------|-------|----------|-------------|
| Chunk summaries & tags | Llama 3.1 8B | Groq | ~free tier / very cheap |
| Document-level summaries | Llama 3.1 8B | Groq | ~free tier |
| Query routing classifier | Llama 3.1 8B | Groq | <$0.001/query |
| Embeddings | text-embedding-3-small | OpenAI | $0.02/1M tokens |
| Tier 0 & 1 answers | Haiku 3.5 | Anthropic | ~$0.005/query |
| Tier 2 deep analysis | Sonnet 4 | Anthropic | ~$0.02–0.08/query |
| Annotation chat | Haiku 3.5 | Anthropic | ~$0.003/message |

All model calls go through a server-side API route (`/api/ai/*`) — no API keys reach the client.

## Existing Infrastructure

The Cortex codebase already has:

- **ChatPanel** — UI shell with model picker, context chips, and multi-turn message list. Currently returns placeholder responses.
- **AnnotationChat** — Threaded chat anchored to highlighted text with persistence to Supabase. Currently returns placeholder responses.
- **Context items** — Users can pin documents or blocks to chat context via drag-handle menu.
- **Backlinks** — Wikilink tracking between documents.
- **Full-text search** — Postgres `tsvector` search on title/subtitle/content.
- **Annotations table** — Supabase table with `document_id`, `block_id`, `highlighted_text`, `messages` (JSONB).

The AI integration replaces the placeholder responses with real inference and adds the indexing layer underneath.

## Design Principles

1. **Never block the editor.** Indexing runs asynchronously. The user saves, and the pipeline processes in the background.
2. **Cheapest viable model.** Groq for classification and summarization, Haiku for chat, Sonnet only when needed. Escalation is always opt-in.
3. **Incremental by default.** Editing one paragraph reprocesses one chunk, not the whole document.
4. **Controlled tag vocabulary.** Tag generation prompts include the user's existing tag list to prevent fragmentation.
5. **Annotations are first-class.** They have embeddings, appear in search results, and form a parallel knowledge layer.
6. **Track every token.** All providers return exact usage counts in every response. A `usage_logs` table records every call from day one — flow, model, input/output tokens, timestamp. No invisible costs.
