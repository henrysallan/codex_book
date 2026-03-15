# Cortex: A Personal Knowledge Operating System

## Vision

Cortex is a document-first knowledge tool built for a single user who wants deep control over how AI integrates with their thinking process. Where Notion treats documents as entries in a database and Claude treats conversations as ephemeral threads, Cortex treats the document as the primary artifact and AI as a collaborator that lives alongside it — never inside it.

The core insight: AI shouldn't write your documents. It should help you think about them. Chat is a tool in service of the document, not the other way around. Conversations are ephemeral; documents are permanent; annotations capture the thinking that connects them.

## Architecture

### Three-Panel Layout

The interface is a classic three-panel workspace:

**Left Panel — File Tree.** A folder-based document hierarchy stored in Supabase. Users organize documents manually into folders, creating the explicit structure of their knowledge base. This is the intentional organizational layer — the stuff you decided goes together.

**Center Panel — Block Editor.** A BlockNote-powered editor that renders rich content: formatted text, images, embedded PDFs, custom block types, and backlinks to other documents. BlockNote provides the Notion-style editing experience (slash menus, drag-and-drop, floating toolbars) while exposing documents as clean typed JSON block arrays — a structure that is trivially serializable for search indexing and AI context injection. The editor syncs in real time via Yjs through Supabase's real-time subscriptions.

**Right Panel — AI Chat (toggleable).** An assistant-ui chat interface connected to the Anthropic API via the Vercel AI SDK. This panel is contextually aware of the current document and has tool access to the full knowledge base. It serves as a search interface, a thinking partner, and an annotation companion. It never directly modifies the document.

### Data Model

The system has three core entity types:

**Documents** are markdown-compatible block arrays stored as Yjs documents in Supabase. Each document has metadata (title, folder path, created/updated timestamps, tags) and a vector embedding for semantic search. Documents can contain backlinks to other documents, forming an implicit knowledge graph.

**Annotations** are AI conversations anchored to a specific text range within a document. A user highlights a passage, opens a thread, and discusses it with Claude. The annotation stores the highlighted text, the positional anchor (using Yjs relative positions so it survives concurrent edits), and the full chat thread. Annotations are first-class searchable objects — over time, they become a record of every question asked, every doubt explored, and every alternative considered.

**Chats** are side-panel conversations associated with a document or free-floating. They cover higher-level queries: "what are the gaps in this document," "find connections across these three pages," "summarize everything I've written about X." Chat transcripts can optionally be saved as linked resources on a document, searchable but not cluttering the main workspace.

All three entity types are indexed for both keyword search (Postgres full-text search) and semantic search (pgvector embeddings). All three participate in the backlink graph.

### Search as AI Chat

There is no traditional search UI. Search is a conversation.

When a user types a query into the AI panel, Claude determines the appropriate retrieval strategy and executes it using tool calls. The available tools include:

- `search_documents` — full-text and semantic search over all documents
- `search_annotations` — search across annotation threads for past reasoning and questions
- `get_backlinks` — traverse the link graph outward from a document
- `recent_activity` — temporal filtering for "what was I working on last week" queries
- `semantic_similarity` — find conceptual connections between document clusters that don't yet have explicit backlinks

Claude composes these tools based on the query. A simple keyword search uses one call. A complex query like "find contradictions between my notes on sync architecture and my earlier design doc" might chain multiple tools — search both document clusters, pull their annotations, compare semantic overlap, and synthesize findings.

Results come back as conversation, not a ranked list. Claude can surface patterns, flag contradictions, and suggest connections that a traditional search UI could never express.

A fast keyboard-driven fuzzy finder remains available for opening documents by name. Not everything needs an LLM.

### Embedding Pipeline

Every document and annotation is continuously embedded in the background. On each save, a Supabase edge function fires, calls an embedding model (either a local model on the user's GPU or a lightweight API like Voyage), and writes the vector back to the corresponding row. This runs async and non-blocking — the user never notices it happening.

Embeddings power semantic search, automated backlink suggestions (surfacing documents that are conceptually related but not yet explicitly linked), and context retrieval for AI conversations.

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | Next.js (App Router) | Full-stack React, API routes for AI backend, familiar ecosystem |
| Block Editor | BlockNote | Notion-style UX out of the box, typed JSON block structure ideal for AI, built on Yjs/ProseMirror |
| AI Chat UI | assistant-ui | Composable React primitives for streaming chat, tool call rendering, Anthropic-compatible via Vercel AI SDK |
| AI Backend | Vercel AI SDK + Anthropic API | Streaming, tool use, model selection (Haiku for cheap lookups, Sonnet for deeper analysis) |
| Database | Supabase (Postgres) | pgvector for embeddings, full-text search, real-time subscriptions for sync, auth, storage |
| Sync | Yjs via Supabase Realtime | CRDT-based conflict resolution, offline support, treats AI as just another collaborator if needed |
| Embeddings | Local model (RTX 3090) or Voyage API | Async embedding on save, zero marginal cost if local |

## AI Cost Strategy

The user already pays for Claude Pro, but the API is billed separately. The cost strategy is layered:

- **Haiku** for cheap, fast operations: search queries, auto-tagging, annotation thread responses, backlink suggestions
- **Sonnet** for deeper analysis: document-level critique, cross-document synthesis, complex multi-tool retrieval chains
- **Local models** (via Ollama on RTX 3090) for zero-cost tasks: embedding generation, classification, simple summarization
- **Hybrid escape hatch**: a "copy context to clipboard" button that bundles relevant blocks and backlinks for pasting into claude.ai when extended conversational work is needed without API cost


## Development Phases

**Phase 1 — Editor + Storage.** BlockNote editor with Supabase persistence, folder tree, basic document CRUD. No AI, no sync. Just a functional web-based markdown editor with a file system.

**Phase 2 — Search + Backlinks.** Full-text search over documents, backlink parsing and graph storage, keyboard fuzzy finder. The knowledge base becomes navigable.

**Phase 3 — AI Chat Panel.** assistant-ui integration, Vercel AI SDK backend, tool definitions for search and backlink traversal. The right panel comes alive.

**Phase 4 — Annotations.** Highlight-to-annotate flow, annotation threading, annotation search indexing. The thinking layer emerges.

**Phase 5 — Embeddings + Semantic Search.** Async embedding pipeline, pgvector queries, semantic similarity tools for the AI, automated backlink suggestions.

**Phase 6 — Polish.** Real-time sync via Yjs, offline support, custom block types (PDF embeds, image galleries), Google Drive integration, mobile-friendly layout.