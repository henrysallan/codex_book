# 05 — Flow 3: Inline Annotation

Hyper-local, passage-anchored conversations. The user highlights text (or targets a block via drag-handle), opens a threaded chat about that specific passage, and the thread is persisted as a first-class annotation.

---

## Existing Infrastructure

This flow has the most existing code. Currently implemented:

| Component | Status |
|-----------|--------|
| `AnnotationChat` component | ✅ Full UI — header, highlighted text display, message list, input |
| `annotations` Supabase table | ✅ Schema with `document_id`, `block_id`, `highlighted_text`, `messages` (JSONB) |
| Store actions (`openAnnotationChat`, `addAnnotationMessage`, etc.) | ✅ Full CRUD |
| Annotation markers on blocks | ✅ Visual indicators showing which blocks have annotations |
| Formatting toolbar "Annotate" button | ✅ Triggers annotation from text selection |
| Drag-handle "Annotate" menu item | ✅ Triggers annotation from block context menu |
| AI responses | ❌ Currently returns placeholder text |

**The work here is connecting real LLM inference to the existing annotation chat UI.**

---

## How It's Triggered

Two paths (both already implemented):

1. **Text selection** → click the "Annotation Chat" button in the formatting toolbar → opens `AnnotationChat` anchored to the selected text with a yellow highlight applied.
2. **Block drag-handle** → "Annotate" menu item → opens `AnnotationChat` anchored to the full block text.

---

## Context Assembly

The annotation chat needs tight, focused context — not a full knowledge base search.

### Primary Context

The highlighted/selected text itself. This is already stored in `activeAnnotation.highlightedText`.

### Secondary Context

The surrounding document content. Two approaches:

- **Simple**: include the full document content (fine for documents under ~4K tokens).
- **Chunked**: include ±2 chunks around the annotated passage. Use the chunk index from the indexing pipeline to identify neighbours.

### Optional: Related Content via Backlinks

If the document has backlinks, include chunk summaries from linked documents. This enables the annotation to reference related material without a full retrieval pipeline.

```
Priority order for context assembly:
1. The highlighted text (always)
2. The surrounding document or ±2 chunks (always)
3. Chunk summaries from backlinked documents (if backlinks exist)
```

---

## Model

**Haiku 3.5** by default. Context is small and interactions should feel instant (~300-500ms).

No escalation to a heavier model — annotation chats are meant to be quick exchanges.

---

## System Prompt

```
You are Cortex, an AI assistant for a personal knowledge base.
The user has highlighted a specific passage and wants to discuss it.

Document: "{documentTitle}"

Highlighted passage:
---
"{highlightedText}"
---

Surrounding context:
---
{surroundingContent}
---

Instructions:
- Focus on the highlighted passage.
- Be concise — annotation responses should be 1-3 sentences unless the user asks for more.
- If the user asks whether a claim is supported elsewhere, check the surrounding context and any related content provided.
- If asked to rephrase or improve, provide the revised text directly.
```

---

## Multi-Turn Conversation

Annotations support multi-turn within the thread. The full message history is sent with each request:

```typescript
interface AnnotationChatRequest {
  annotationId: string;
  documentId: string;
  highlightedText: string;
  messages: { role: "user" | "assistant"; content: string }[];
  // Server fetches surrounding context from the document
}
```

Each new user message is persisted to the annotation's `messages` JSONB array immediately (already implemented via `addAnnotationMessage`). The AI response is appended after generation.

---

## Annotations as First-Class Objects

Annotations aren't just UI — they're searchable knowledge artifacts.

### Embedding

After an annotation thread reaches 2+ messages, generate an embedding of the thread content (concatenated messages). This embedding is stored on the annotation and makes the thread discoverable via Flow 1 semantic search.

### Search Integration

Annotations appear in Flow 1 search results alongside document chunks:

```
Search result types:
1. Document chunk — "In 'Sync Architecture Notes', section 'CRDT Strategy': ..."
2. Annotation thread — "Annotation on 'Design Doc': You discussed whether the pull model is sufficient..."
```

This means your questions, explorations, and decisions are as searchable as your documents.

### Indexing Pipeline Integration

When an annotation is created or updated:
1. Concatenate the highlighted text + all messages into a single text block.
2. Generate a summary (Groq Llama 8B, 1 sentence).
3. Generate an embedding (text-embedding-3-small).
4. Store on the annotation record.

This runs asynchronously, same as document indexing.

---

## Persistence Details

### Existing Schema (annotations table)

```sql
id uuid PRIMARY KEY
document_id uuid → documents(id) ON DELETE CASCADE
user_id text
block_id text              -- BlockNote block ID for positioning
highlighted_text text       -- The anchored passage
messages jsonb             -- Array of {role, content, timestamp}
created_at timestamptz
updated_at timestamptz
```

### New Columns Needed

```sql
summary text               -- AI-generated summary of the thread
embedding vector(1536)     -- For semantic search
```

See [06-data-model.md](./06-data-model.md) for the full migration.

---

## API Route

**`POST /api/ai/annotate`**

```typescript
interface AnnotateRequest {
  annotationId: string;
  documentId: string;
  highlightedText: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

// Returns: streaming SSE response (single assistant message)
```

The server:
1. Fetches the document content for surrounding context.
2. Optionally fetches backlink chunk summaries.
3. Sends highlighted text + context + conversation history to Haiku.
4. Streams the response back.

---

## Cost

~$0.003 per annotation message. Annotations are cheap — Haiku with small context windows.

---

## Use Cases

- "Is this claim supported by anything else in my notes?"
- "What's a better way to phrase this?"
- "This contradicts something I wrote elsewhere — find it"
- "Expand on this idea"
- "What's the source for this number?"
- "Simplify this paragraph"
