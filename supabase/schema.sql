-- Cortex Database Schema
-- Run this in your Supabase SQL editor

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Folders table
create table if not exists folders (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  parent_id uuid references folders(id) on delete cascade,
  user_id text not null default 'local',
  position integer not null default 0,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- Documents table
create table if not exists documents (
  id uuid primary key default uuid_generate_v4(),
  title text not null default 'Untitled',
  subtitle text,
  folder_id uuid references folders(id) on delete set null,
  user_id text not null default 'local',
  content text not null default '[]',
  tags text[] not null default '{}',
  settings jsonb not null default '{}'::jsonb,
  parent_document_id uuid references documents(id) on delete set null,
  position integer not null default 0,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- Indexes for performance
create index if not exists idx_folders_parent on folders(parent_id);
create index if not exists idx_documents_folder on documents(folder_id);
create index if not exists idx_documents_parent_doc on documents(parent_document_id);
create index if not exists idx_documents_tags on documents using gin(tags);

-- Full text search index on documents
alter table documents add column if not exists fts tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(subtitle, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'C')
  ) stored;

create index if not exists idx_documents_fts on documents using gin(fts);

-- Updated_at trigger
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger folders_updated_at
  before update on folders
  for each row execute function update_updated_at();

create trigger documents_updated_at
  before update on documents
  for each row execute function update_updated_at();

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

-- Row Level Security (enable when auth is added)
-- alter table folders enable row level security;
-- alter table documents enable row level security;
-- alter table backlinks enable row level security;

-- Attachments table — stores Google Drive file references linked to documents
create table if not exists attachments (
  id uuid primary key default uuid_generate_v4(),
  document_id uuid not null references documents(id) on delete cascade,
  user_id text not null default 'local',
  file_name text not null,
  mime_type text not null default 'application/pdf',
  file_size bigint,
  drive_file_id text not null,
  drive_web_view_link text,
  created_at timestamp with time zone default now()
);

create index if not exists idx_attachments_document on attachments(document_id);
create index if not exists idx_attachments_drive_file on attachments(drive_file_id);

-- Store Google OAuth refresh tokens for Drive API access
create table if not exists user_google_tokens (
  user_id text primary key,
  refresh_token text not null,
  updated_at timestamp with time zone default now()
);
