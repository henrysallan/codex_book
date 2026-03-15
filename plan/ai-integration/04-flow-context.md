# 04 — Flow 2: Context-Based Query

A conversation mode where the user works with **explicitly loaded context** — specific documents they've chosen, not documents the system retrieved. This is the closest analogue to a normal Claude conversation, just with your notes pre-loaded.

---

## When It's Triggered

Flow 2 activates when the user has **context items** attached in the ChatPanel. The existing UI already supports this:

- **Pin a document**: via the "Add to context" button (➕ chip) or drag-handle menu item.
- **Pin a block**: via the drag-handle "Add to context" menu item on a specific block.
- **Promote search results**: after a Flow 1 query surfaces relevant docs, a "Use as context" action loads them into Flow 2 mode.
- **Active document**: the "Add active note" button in the ChatPanel input area.

The routing classifier detects this when `contextItems.length > 0` and routes to Flow 2 (the `CONTEXT` category).

---

## Context Assembly

### Document Context Items

For each `{ type: "document", docId }` context item:

1. Fetch the full document content from the store/cache.
2. Include title, content, and summary (if indexed).

### Block Context Items

For each `{ type: "block", blockId, text }` context item:

1. Include the block text directly.
2. Optionally include ±1 surrounding chunk for context.

### Assembly Format

```
The user has loaded the following context for this conversation:

=== Document: "Sync Architecture Notes" ===
{fullContent}

=== Document: "CRDT Research" ===
{fullContent}

=== Block from "Project Retro - Q3" ===
"{blockText}"
```

---

## Model Selection

Based on total context size:

| Total tokens | Model |
|-------------|-------|
| < 10K | Haiku 3.5 |
| 10K–50K | Sonnet 4 |
| > 50K | Sonnet 4 (may need to trim least-relevant content) |

---

## System Prompt

```
You are Cortex, an AI assistant for a personal knowledge base.
The user has loaded specific documents and passages for you to work with.

{assembledContext}

Instructions:
- Work with the provided context to answer the user's questions.
- You can reference, compare, and synthesize across the loaded documents.
- Be specific — cite which document or passage you're drawing from.
- If the user asks you to draft, restructure, or generate new content, base it on the loaded context.
- This is a multi-turn conversation. Maintain continuity across messages.
```

---

## Multi-Turn Conversation

Flow 2 is **stateful** — the full conversation history is sent with each request. The context documents are included in the system prompt (or first message) and persist across turns.

```
Turn 1: "Compare the approaches in these two documents"
Turn 2: "Now draft an outline that combines the best of both"
Turn 3: "Expand section 3 of that outline"
```

Each turn sends the full `messages[]` array to the API, with the assembled context in the system prompt.

---

## Interaction with Flow 1

Flow 2 can be **entered from Flow 1**:

1. User asks a cross-document question (Flow 1, Tier 1 or 2).
2. The response cites documents A, B, and C.
3. An action button appears: **"Continue with these documents as context →"**
4. Clicking it loads A, B, C as context items and switches the conversation to Flow 2 mode.

This provides a natural transition from search ("find me relevant notes") to discussion ("now let's work with what you found").

---

## Saving Conversations

Optionally, a Flow 2 conversation can be **saved as a linked resource** on a document:

- A "Save conversation" button in the chat UI.
- Creates a new annotation (or a special "conversation" annotation) linked to the primary context document.
- The transcript is stored and becomes searchable via the indexing pipeline.

This is a lower-priority feature — implement after the core flows work.

---

## API Route

**`POST /api/ai/chat`** (same endpoint as Flow 1)

The server distinguishes Flow 2 from Flow 1 by the presence of `contextItems` in the request. When context items are present and the router returns `CONTEXT`, the server:

1. Fetches full content for each context document.
2. Assembles context into the system prompt.
3. Sends the full conversation history + context to the selected model.
4. Streams the response back.

```typescript
interface ChatRequest {
  messages: { role: "user" | "assistant"; content: string }[];
  activeDocumentId: string | null;
  contextItems: ContextItem[];
  tier?: "TIER0" | "TIER1" | "TIER2";
}
```

---

## Cost

| Scenario | Model | Approx Cost |
|----------|-------|-------------|
| 1 short document loaded | Haiku 3.5 | ~$0.005/turn |
| 2-3 medium documents | Sonnet 4 | ~$0.02/turn |
| 5+ documents, multi-turn | Sonnet 4 | ~$0.05–0.10/turn |

Multi-turn conversations get more expensive as the message history grows. Consider summarizing older turns if the conversation exceeds ~30K tokens.

---

## Use Cases

- "Help me restructure this argument"
- "Compare these two documents"
- "Draft a new section based on these three notes"
- "What questions does this document leave unanswered?"
- "Find the inconsistencies between these approaches"
