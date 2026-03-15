# 03 — Flow 1: General Search & Insight

The primary AI interface. The user asks a question in the **ChatPanel** and the system uses tiered retrieval to find and reason over relevant content from across their knowledge base.

---

## Query Routing

Before retrieval begins, a lightweight classifier determines which tier to use. This avoids wasting API calls on simple questions and ensures complex queries get enough context.

### Router Model

**Groq — Llama 3.1 8B** (~30ms, 1-token output).

### Router Prompt

```
You are a query router for a personal knowledge base app.

The user asked: "{query}"

Currently open document: "{activeDocument.title}" (or "none")
Context items attached: {contextItems.length}

Classify this query into exactly one category:
- TIER0: Answerable from the current document alone (summarize, rewrite, explain this doc)
- TIER1: Needs to search across documents but summaries are sufficient (find notes about X, when did I write about Y)
- TIER2: Needs full document content for deep analysis (find contradictions, synthesize across docs, compare arguments)
- CONTEXT: User has explicitly loaded context and wants to discuss it (help restructure, compare these docs)

Respond with exactly one word: TIER0, TIER1, TIER2, or CONTEXT
```

### Heuristic Overrides (Skip Classifier)

Some patterns are unambiguous — bypass the classifier to save the 30ms call:

| Signal | Route to |
|--------|----------|
| Text is selected in editor | Flow 3 (annotation) or Flow 2 (context) |
| Context items are attached | Flow 2 (context query) |
| Query contains "across my notes", "everything about", "all my" | Force Tier 2 |
| Query starts with "summarize this", "rewrite", "explain" and a doc is open | Force Tier 0 |
| No document is open and no context items | Force Tier 1+ |

---

## Tier 0 — Current Document Only

**No retrieval needed.** The active document's content goes directly into the LLM context.

### Context Assembly

1. Get the active document's full content (already loaded in `activeDocument`).
2. If the document is very long (>8K tokens), use its chunks and select the most relevant ones via a quick embedding similarity against the query.
3. Include the document title and summary as framing.

### Model

**Haiku 3.5** — fast, cheap, sufficient for single-document tasks.

### System Prompt

```
You are Cortex, an AI assistant for a personal knowledge base.
You are answering a question about a specific document the user is working on.

Document: "{title}"
---
{documentContent}
---

Answer the user's question based on the document above. Be concise and specific.
If the document doesn't contain relevant information, say so.
```

### Cost

~$0.005 per query.

### Use Cases

- "Summarize this document"
- "What's the main argument here?"
- "Rewrite the introduction"
- "What are the key takeaways?"

---

## Tier 1 — Summary Scan

The workhorse tier — handles ~80% of cross-document queries. Retrieves candidates via vector search, reads their summaries, and synthesizes an answer.

### Retrieval

1. **Embed the query** using text-embedding-3-small.
2. **Vector search** on `document_chunks.embedding` → top 20–30 candidate chunks.
3. **Optional tag filter**: if the router or query analysis identifies specific tags, filter candidates by `ai_tags` to narrow results.
4. **Deduplicate by document**: group chunks by parent document to avoid flooding results from one verbose doc.

### Context Assembly

Concatenate the **chunk summaries** of the top candidates (~3K tokens total):

```
Results from your knowledge base:

1. [Document: "Sync Architecture Notes"] Section: "CRDT Strategy"
   Summary: Describes the decision to use Yjs for real-time sync, with delta-based updates over WebSocket...
   
2. [Document: "Project Retro - Q3"] Section: "Technical Wins"
   Summary: Highlights the migration to edge functions and the 40% latency improvement...

...
```

### Model

**Haiku 3.5** — reads summaries, synthesizes a coherent answer.

### System Prompt

```
You are Cortex, an AI assistant for a personal knowledge base.
The user asked a question and the system retrieved relevant passages from their notes.

Retrieved context (these are summaries of relevant sections):
---
{formattedSummaries}
---

Instructions:
- Answer the user's question based on the retrieved context.
- Cite which document each piece of information comes from.
- If the summaries suggest relevant content but lack detail, say "I found relevant notes but may need to look deeper for a complete answer" and the system will offer a "Look deeper" option.
- If nothing relevant was found, say so honestly.
```

### Escalation

If the model's response includes the "look deeper" signal, or if confidence is low (e.g., only 1–2 marginally relevant results), the UI shows an inline **"Look deeper →"** button. Clicking it re-runs the query at Tier 2.

### Cost

~$0.003–0.01 per query.

### Use Cases

- "What have I written about sync?"
- "Find my notes on Wittgenstein"
- "When did I last work on the Welcome site?"
- "What are my open questions about CRDTs?"

---

## Tier 2 — Full Context Retrieval

Deep analysis mode. Pulls full document content for the most relevant results and uses a more capable model.

### Retrieval

1. Same vector search as Tier 1 → top 20–30 candidate chunks.
2. Model (or simple heuristic) identifies the **3–5 most relevant documents** from the candidates.
3. Pull **full content** of those documents into context.

### Context Assembly

```
The user asked: "{query}"

Relevant documents from their knowledge base:

=== Document 1: "Sync Architecture Notes" ===
{fullContent1}

=== Document 2: "CRDT Research" ===  
{fullContent2}

=== Document 3: "Project Retro - Q3" ===
{fullContent3}
```

### Model Selection

| Total context size | Model |
|-------------------|-------|
| < 10K tokens | Haiku 3.5 |
| 10K–50K tokens | Sonnet 4 |
| > 50K tokens | Sonnet 4 (with context trimming) |

### System Prompt

```
You are Cortex, an AI assistant for a personal knowledge base.
The user asked a complex question that requires analyzing multiple documents in detail.

{assembledDocuments}

Instructions:
- Provide a thorough, well-structured answer.
- Cite specific passages and documents.
- Identify connections, contradictions, or gaps across documents.
- If the user asked for synthesis, provide a structured outline or summary.
```

### Cost

~$0.02–0.08 per query depending on document sizes and model.

### Use Cases

- "Find contradictions between my sync notes and the design doc"
- "Synthesize everything I know about CRDTs into an outline"
- "What are the gaps in my research on X?"
- "Compare my approach in doc A vs doc B"

---

## UX Flow

```
User types query in ChatPanel
         │
         ▼
  ┌──────────────┐
  │  Route query  │ (heuristics first, then classifier if ambiguous)
  └──────┬───────┘
         │
    ┌────┼────┬───────┐
    ▼    ▼    ▼       ▼
  Tier0 Tier1 Tier2  Flow2
    │    │     │      │
    ▼    ▼     ▼      ▼
  Answer Answer Answer Answer
              │
         (if thin)
              ▼
       "Look deeper →"
         button shown
              │
           (click)
              ▼
          Re-run at
           Tier 2
```

### Response Rendering

- Responses stream token-by-token into the ChatPanel (SSE from the API route).
- Document citations render as clickable links that open the referenced document.
- The "Look deeper" button appears inline after the response text.
- Each message stores its tier level and retrieval metadata for debugging/cost tracking.

---

## API Route

**`POST /api/ai/chat`**

```typescript
interface ChatRequest {
  messages: { role: "user" | "assistant"; content: string }[];
  activeDocumentId: string | null;
  contextItems: ContextItem[];
  tier?: "TIER0" | "TIER1" | "TIER2";  // override from "look deeper"
}

// Returns: streaming SSE response
```

The route handles routing, retrieval, context assembly, and LLM call. The client just sends messages and renders the stream.
