-- =============================================================
-- Cortex AI Integration Migration
-- Run this in the Supabase SQL editor
-- =============================================================

-- 1. Enable pgvector extension
create extension if not exists vector;

-- =============================================================
-- 2. New table: document_chunks
-- =============================================================

create table if not exists document_chunks (
  id uuid primary key default uuid_generate_v4(),
  document_id uuid not null references documents(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  content_hash text not null,
  heading text,
  block_ids text[] not null default '{}',
  token_count integer not null default 0,
  summary text,
  tags text[] not null default '{}',
  embedding vector(1536),
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create index if not exists idx_chunks_document on document_chunks(document_id);
create index if not exists idx_chunks_hash on document_chunks(content_hash);
create index if not exists idx_chunks_tags on document_chunks using gin(tags);

create trigger document_chunks_updated_at
  before update on document_chunks
  for each row execute function update_updated_at();

-- =============================================================
-- 3. New columns on documents
-- =============================================================

alter table documents
  add column if not exists ai_summary text,
  add column if not exists ai_tags text[] not null default '{}',
  add column if not exists embedding vector(1536),
  add column if not exists content_hash text,
  add column if not exists index_status text not null default 'idle';

create index if not exists idx_documents_ai_tags
  on documents using gin(ai_tags);

-- =============================================================
-- 4. New columns on annotations
-- =============================================================

alter table annotations
  add column if not exists summary text,
  add column if not exists embedding vector(1536);

-- =============================================================
-- 5. New table: usage_logs
-- =============================================================

create table if not exists usage_logs (
  id uuid primary key default uuid_generate_v4(),
  user_id text not null default 'local',
  flow text not null,
  provider text not null,
  model text not null,
  input_tokens integer not null,
  output_tokens integer not null default 0,
  document_id uuid references documents(id) on delete set null,
  created_at timestamp with time zone default now()
);

create index if not exists idx_usage_user on usage_logs(user_id);
create index if not exists idx_usage_flow on usage_logs(flow);
create index if not exists idx_usage_created on usage_logs(created_at);

-- =============================================================
-- 6. Semantic search functions
-- =============================================================

-- Search chunks by embedding similarity
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

-- Search documents by embedding similarity
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

-- Search annotations by embedding similarity
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

-- Get all unique AI-generated tags (for controlled vocabulary prompts)
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

-- =============================================================
-- NOTE: Vector indexes (IVFFlat) require existing data to build.
-- Run these AFTER you have some embeddings populated:
--
-- create index if not exists idx_chunks_embedding
--   on document_chunks using ivfflat (embedding vector_cosine_ops)
--   with (lists = 100);
--
-- create index if not exists idx_documents_embedding
--   on documents using ivfflat (embedding vector_cosine_ops)
--   with (lists = 50);
--
-- create index if not exists idx_annotations_embedding
--   on annotations using ivfflat (embedding vector_cosine_ops)
--   with (lists = 50);
-- =============================================================
