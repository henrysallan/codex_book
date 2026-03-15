# 06 — Data Model

All database changes needed for the AI integration. This covers new tables, new columns on existing tables, indexes, and Supabase functions.

---

## New Table: `document_chunks`

Stores the semantic chunks produced by the indexing pipeline.

```sql
-- Enable pgvector (run once)
create extension if not exists vector;

create table if not exists document_chunks (
  id uuid primary key default uuid_generate_v4(),
  document_id uuid not null references documents(id) on delete cascade,
  chunk_index integer not null,          -- position within document (0-based)
  content text not null,                 -- raw text of the chunk
  content_hash text not null,            -- SHA-256 for change detection
  heading text,                          -- nearest heading above this chunk
  block_ids text[] not null default '{}', -- BlockNote block IDs spanned
  token_count integer not null default 0,
  summary text,                          -- AI-generated 1-2 sentence summary
  tags text[] not null default '{}',     -- AI-generated chunk-level tags
  embedding vector(1536),               -- semantic embedding
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- Indexes
create index if not exists idx_chunks_document on document_chunks(document_id);
create index if not exists idx_chunks_hash on document_chunks(content_hash);
create index if not exists idx_chunks_tags on document_chunks using gin(tags);

-- Vector similarity index (IVFFlat — good up to ~100K rows)
-- Switch to HNSW if chunk count grows significantly
create index if not exists idx_chunks_embedding
  on document_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Updated_at trigger (reuses existing function)
create trigger document_chunks_updated_at
  before update on document_chunks
  for each row execute function update_updated_at();
```

---

## New Columns on `documents`

```sql
-- AI-generated document-level metadata
alter table documents
  add column if not exists ai_summary text,
  add column if not exists ai_tags text[] not null default '{}',
  add column if not exists embedding vector(1536),
  add column if not exists content_hash text,
  add column if not exists index_status text not null default 'idle';

-- Vector similarity index for document embeddings
create index if not exists idx_documents_embedding
  on documents using ivfflat (embedding vector_cosine_ops)
  with (lists = 50);

-- Index on ai_tags for tag-based filtering
create index if not exists idx_documents_ai_tags
  on documents using gin(ai_tags);
```

| Column | Type | Purpose |
|--------|------|---------|
| `ai_summary` | `text` | 2-3 sentence AI-generated document summary |
| `ai_tags` | `text[]` | AI-generated tags (separate from user's manual `tags`) |
| `embedding` | `vector(1536)` | Document-level embedding (from summary) |
| `content_hash` | `text` | SHA-256 of content, for change detection |
| `index_status` | `text` | Pipeline state: `idle`, `queued`, `processing`, `indexed`, `error` |

---

## New Columns on `annotations`

```sql
alter table annotations
  add column if not exists summary text,
  add column if not exists embedding vector(1536);

-- Vector index for annotation embeddings
create index if not exists idx_annotations_embedding
  on annotations using ivfflat (embedding vector_cosine_ops)
  with (lists = 50);
```

| Column | Type | Purpose |
|--------|------|---------|
| `summary` | `text` | AI-generated summary of the annotation thread |
| `embedding` | `vector(1536)` | For semantic search over annotations |

---

## Supabase Functions

### Semantic Search — Chunks

```sql
create or replace function match_chunks(
  query_embedding vector(1536),
  match_threshold float default 0.5,
  match_count int default 20
)
returns table (
  id uuid,
  document_id uuid,
  chunk_index integer,
  content text,
  summary text,
  tags text[],
  similarity float
) as $$
begin
  return query
  select
    dc.id,
    dc.document_id,
    dc.chunk_index,
    dc.content,
    dc.summary,
    dc.tags,
    1 - (dc.embedding <=> query_embedding) as similarity
  from document_chunks dc
  where dc.embedding is not null
    and 1 - (dc.embedding <=> query_embedding) > match_threshold
  order by dc.embedding <=> query_embedding
  limit match_count;
end;
$$ language plpgsql;
```

### Semantic Search — Documents

```sql
create or replace function match_documents(
  query_embedding vector(1536),
  match_threshold float default 0.5,
  match_count int default 10
)
returns table (
  id uuid,
  title text,
  ai_summary text,
  ai_tags text[],
  similarity float
) as $$
begin
  return query
  select
    d.id,
    d.title,
    d.ai_summary,
    d.ai_tags,
    1 - (d.embedding <=> query_embedding) as similarity
  from documents d
  where d.embedding is not null
    and 1 - (d.embedding <=> query_embedding) > match_threshold
  order by d.embedding <=> query_embedding
  limit match_count;
end;
$$ language plpgsql;
```

### Semantic Search — Annotations

```sql
create or replace function match_annotations(
  query_embedding vector(1536),
  match_threshold float default 0.5,
  match_count int default 10
)
returns table (
  id uuid,
  document_id uuid,
  highlighted_text text,
  summary text,
  similarity float
) as $$
begin
  return query
  select
    a.id,
    a.document_id,
    a.highlighted_text,
    a.summary,
    1 - (a.embedding <=> query_embedding) as similarity
  from annotations a
  where a.embedding is not null
    and 1 - (a.embedding <=> query_embedding) > match_threshold
  order by a.embedding <=> query_embedding
  limit match_count;
end;
$$ language plpgsql;
```

### Get All Unique Tags

For the controlled-vocabulary tag prompt:

```sql
create or replace function get_all_tags()
returns text[] as $$
begin
  return (
    select array_agg(distinct tag)
    from (
      select unnest(ai_tags) as tag from documents
      union
      select unnest(tags) as tag from document_chunks
    ) t
  );
end;
$$ language plpgsql;
```

---

## New Table: `usage_logs`

Tracks token usage and cost for every AI API call. Since all LLM calls go through server-side API routes, the backend sees the usage fields in every provider response and logs them automatically.

```sql
create table if not exists usage_logs (
  id uuid primary key default uuid_generate_v4(),
  user_id text not null default 'local',
  flow text not null,               -- e.g. 'chat-tier0', 'chat-tier1', 'chat-tier2', 'annotate', 'index-summarize', 'index-embed', 'index-tags', 'router'
  provider text not null,            -- 'anthropic', 'openai', 'groq'
  model text not null,               -- e.g. 'claude-haiku-3.5', 'text-embedding-3-small', 'llama-3.1-8b'
  input_tokens integer not null,
  output_tokens integer not null default 0,  -- 0 for embeddings
  document_id uuid references documents(id) on delete set null,  -- nullable, for tracing back to source
  created_at timestamp with time zone default now()
);

create index if not exists idx_usage_user on usage_logs(user_id);
create index if not exists idx_usage_flow on usage_logs(flow);
create index if not exists idx_usage_created on usage_logs(created_at);
```

| Column | Type | Purpose |
|--------|------|---------|
| `flow` | `text` | Which pipeline step or inference flow triggered this call |
| `provider` | `text` | `anthropic`, `openai`, or `groq` |
| `model` | `text` | Exact model identifier |
| `input_tokens` | `integer` | Prompt / input tokens reported by the provider |
| `output_tokens` | `integer` | Completion / output tokens (0 for embeddings) |
| `document_id` | `uuid` | Optional — links the call to a specific document for per-doc cost analysis |

### Token Source by Provider

| Provider | Where tokens come from |
|----------|------------------------|
| Anthropic (Haiku/Sonnet) | `response.usage.input_tokens`, `response.usage.output_tokens` — for streaming, these arrive in the final `message_delta` event |
| OpenAI (embeddings) | `response.usage.prompt_tokens`, `response.usage.total_tokens` |
| Groq (Llama 8B) | `response.usage.prompt_tokens`, `response.usage.completion_tokens` |

### Helper

A thin utility in `lib/ai/usage.ts`:

```typescript
export async function logUsage(params: {
  flow: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  documentId?: string;
}) { /* insert into usage_logs */ }
```

Called at the end of every API route handler, after the LLM response completes.

---

## TypeScript Types

New types to add to [types.ts](../../cortex/src/lib/types.ts):

```typescript
export interface DbDocumentChunk {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  content_hash: string;
  heading: string | null;
  block_ids: string[];
  token_count: number;
  summary: string | null;
  tags: string[];
  // embedding is never sent to the client — only used server-side
  created_at: string;
  updated_at: string;
}

export interface ChunkSearchResult {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  summary: string | null;
  tags: string[];
  similarity: number;
}

export interface DocumentSearchResult {
  id: string;
  title: string;
  ai_summary: string | null;
  ai_tags: string[];
  similarity: number;
}

export interface DbUsageLog {
  id: string;
  user_id: string;
  flow: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  document_id: string | null;
  created_at: string;
}
```

---

## Migration File

All of the above should be combined into a single migration file: `supabase/ai_migration.sql`. See [07-implementation-steps.md](./07-implementation-steps.md) for the execution order.

---

## RLS Considerations

When Row Level Security is enabled, the new tables and functions need policies:

```sql
-- document_chunks inherits access from its parent document
alter table document_chunks enable row level security;
create policy "Users access own chunks"
  on document_chunks for all
  using (
    document_id in (
      select id from documents where user_id = auth.uid()::text
    )
  );
```

```sql
-- usage_logs: users can only read their own usage
alter table usage_logs enable row level security;
create policy "Users read own usage"
  on usage_logs for select
  using (user_id = auth.uid()::text);
-- Only the server (service role) inserts usage logs
```

This can be deferred until auth is fully enforced.
