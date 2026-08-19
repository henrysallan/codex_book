-- Auth Migration: Multi-user with Google Auth + Row Level Security
-- Run this in your Supabase SQL Editor AFTER enabling Google Auth in the dashboard.
--
-- BEFORE running this:
--   1. Go to Supabase Dashboard → Authentication → Providers
--   2. Enable Google provider
--   3. Add your Google OAuth Client ID and Secret
--   4. Set the redirect URL shown in Supabase into your Google Cloud Console
--

-- =============================================
-- 1. Clean up old local-only data & alter columns
-- =============================================

-- Remove any rows created before auth was set up (user_id = 'local').
-- These can't be linked to a real auth.users row.
-- If you want to keep them, comment out the 3 DELETE lines below,
-- and instead sign in first, note your user UUID from the Supabase
-- auth.users table, then manually UPDATE ... SET user_id = '<your-uuid>'.

delete from backlinks where exists (
  select 1 from documents d
  where (d.id = backlinks.source_document_id or d.id = backlinks.target_document_id)
    and d.user_id = 'local'
);
delete from documents where user_id = 'local';
delete from folders where user_id = 'local';

-- Folders: change user_id from text to uuid, link to auth.users
alter table folders
  alter column user_id drop default;

alter table folders
  alter column user_id type uuid using (user_id::uuid);

alter table folders
  alter column user_id set default auth.uid();

alter table folders
  add constraint folders_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

-- Documents: change user_id from text to uuid, link to auth.users
alter table documents
  alter column user_id drop default;

alter table documents
  alter column user_id type uuid using (user_id::uuid);

alter table documents
  alter column user_id set default auth.uid();

alter table documents
  add constraint documents_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

-- Add user_id to backlinks for RLS
alter table backlinks
  add column if not exists user_id uuid default auth.uid() references auth.users(id) on delete cascade;

-- Index for user-scoped queries
create index if not exists idx_folders_user on folders(user_id);
create index if not exists idx_documents_user on documents(user_id);
create index if not exists idx_backlinks_user on backlinks(user_id);

-- =============================================
-- 2. Enable Row Level Security
-- =============================================

alter table folders enable row level security;
alter table documents enable row level security;
alter table backlinks enable row level security;

-- =============================================
-- 3. RLS Policies — each user can only see/modify their own data
-- =============================================

-- Folders
create policy "Users can view own folders"
  on folders for select
  using (auth.uid() = user_id);

create policy "Users can insert own folders"
  on folders for insert
  with check (auth.uid() = user_id);

create policy "Users can update own folders"
  on folders for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own folders"
  on folders for delete
  using (auth.uid() = user_id);

-- Documents
create policy "Users can view own documents"
  on documents for select
  using (auth.uid() = user_id);

create policy "Users can insert own documents"
  on documents for insert
  with check (auth.uid() = user_id);

create policy "Users can update own documents"
  on documents for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own documents"
  on documents for delete
  using (auth.uid() = user_id);

-- Backlinks
create policy "Users can view own backlinks"
  on backlinks for select
  using (auth.uid() = user_id);

create policy "Users can insert own backlinks"
  on backlinks for insert
  with check (auth.uid() = user_id);

create policy "Users can update own backlinks"
  on backlinks for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own backlinks"
  on backlinks for delete
  using (auth.uid() = user_id);

-- =============================================
-- 4. Update search function to respect RLS
-- =============================================

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
    and d.user_id = auth.uid()
  order by rank desc
  limit 20;
end;
$$ language plpgsql security definer;
