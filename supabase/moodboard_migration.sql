-- Moodboard Migration
-- Run this in your Supabase SQL editor after the base schema

-- ============================================================
-- moodboard_state: stores tldraw snapshot + canvas settings per moodboard
-- ============================================================

create table if not exists moodboard_state (
  document_id uuid primary key references documents(id) on delete cascade,
  tldraw_snapshot jsonb,
  canvas_settings jsonb not null default '{}'::jsonb,
  updated_at timestamp with time zone default now()
);

create trigger moodboard_state_updated_at
  before update on moodboard_state
  for each row execute function update_updated_at();

-- ============================================================
-- moodboard_objects: relational representation of canvas objects
-- ============================================================

create table if not exists moodboard_objects (
  id uuid primary key default uuid_generate_v4(),
  moodboard_id uuid not null references documents(id) on delete cascade,
  type text not null,                          -- 'image', 'gif', 'video'
  asset_url text not null,                     -- Supabase Storage public URL
  original_filename text,
  mime_type text,
  width float not null default 0,
  height float not null default 0,
  x float not null default 0,
  y float not null default 0,
  rotation float not null default 0,
  z_index integer not null default 0,
  file_size_bytes integer,
  tags text[],                                 -- reserved for future tagging
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create index if not exists idx_moodboard_objects_moodboard on moodboard_objects(moodboard_id);
create index if not exists idx_moodboard_objects_tags on moodboard_objects using gin(tags);

create trigger moodboard_objects_updated_at
  before update on moodboard_objects
  for each row execute function update_updated_at();

-- ============================================================
-- moodboard_assets: tracks uploaded assets independently
-- ============================================================

create table if not exists moodboard_assets (
  id uuid primary key default uuid_generate_v4(),
  user_id text not null default 'local',
  storage_path text not null,                  -- path within Supabase Storage bucket
  public_url text not null,                    -- Supabase Storage public URL
  original_filename text,
  mime_type text,
  file_size_bytes integer,                     -- after compression
  original_size_bytes integer,                 -- before compression
  width_px integer,
  height_px integer,
  duration_ms integer,                         -- for video, nullable
  created_at timestamp with time zone default now()
);

create index if not exists idx_moodboard_assets_user on moodboard_assets(user_id);

-- ============================================================
-- Supabase Storage bucket for moodboard assets
-- ============================================================
-- Run this via Supabase dashboard or the management API:
--   Create a PUBLIC bucket named "moodboard-assets"
--
-- If using SQL (Supabase exposes storage schema):
-- insert into storage.buckets (id, name, public)
-- values ('moodboard-assets', 'moodboard-assets', true)
-- on conflict (id) do nothing;

-- ============================================================
-- RLS policies (enable when auth is active)
-- ============================================================

-- alter table moodboard_state enable row level security;
-- create policy "Users can manage their own moodboard state"
--   on moodboard_state for all
--   using (document_id in (select id from documents where user_id = auth.uid()::text))
--   with check (document_id in (select id from documents where user_id = auth.uid()::text));

-- alter table moodboard_objects enable row level security;
-- create policy "Users can manage their own moodboard objects"
--   on moodboard_objects for all
--   using (moodboard_id in (select id from documents where user_id = auth.uid()::text))
--   with check (moodboard_id in (select id from documents where user_id = auth.uid()::text));

-- alter table moodboard_assets enable row level security;
-- create policy "Users can manage their own moodboard assets"
--   on moodboard_assets for all
--   using (user_id = auth.uid()::text)
--   with check (user_id = auth.uid()::text);

-- Storage RLS: users can only upload to their own prefix
-- create policy "Users upload to own prefix"
--   on storage.objects for insert
--   with check (bucket_id = 'moodboard-assets' and (storage.foldername(name))[1] = auth.uid()::text);
-- create policy "Public read for moodboard assets"
--   on storage.objects for select
--   using (bucket_id = 'moodboard-assets');
