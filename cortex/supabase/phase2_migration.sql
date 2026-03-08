-- Phase 2 Migration: Backlinks + Search
-- Run this in your Supabase SQL Editor

-- Backlinks table (tracks [[wikilink]] references between documents)
create table if not exists backlinks (
  id uuid primary key default uuid_generate_v4(),
  source_document_id uuid not null references documents(id) on delete cascade,
  target_document_id uuid not null references documents(id) on delete cascade,
  created_at timestamp with time zone default now(),
  unique(source_document_id, target_document_id)
);

create index if not exists idx_backlinks_source on backlinks(source_document_id);
create index if not exists idx_backlinks_target on backlinks(target_document_id);

-- Full-text search function
create or replace function search_documents(search_query text)
returns table (
  id uuid,
  title text,
  subtitle text,
  folder_id uuid,
  tags text[],
  content text,
  rank real,
  created_at timestamptz,
  updated_at timestamptz
) as $$
begin
  return query
  select
    d.id,
    d.title,
    d.subtitle,
    d.folder_id,
    d.tags,
    d.content,
    ts_rank(d.fts, websearch_to_tsquery('english', search_query)) as rank,
    d.created_at,
    d.updated_at
  from documents d
  where d.fts @@ websearch_to_tsquery('english', search_query)
  order by rank desc
  limit 20;
end;
$$ language plpgsql;
