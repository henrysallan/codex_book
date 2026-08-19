-- Annotations table for Cortex annotation chat feature
-- Run this in your Supabase SQL editor

create table if not exists annotations (
  id uuid primary key default uuid_generate_v4(),
  document_id uuid not null references documents(id) on delete cascade,
  user_id text not null default 'local',
  block_id text,
  highlighted_text text not null,
  messages jsonb not null default '[]'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create index if not exists idx_annotations_document on annotations(document_id);
create index if not exists idx_annotations_user on annotations(user_id);

create trigger annotations_updated_at
  before update on annotations
  for each row execute function update_updated_at();

-- RLS (enable if using auth)
-- alter table annotations enable row level security;
-- create policy "Users can manage own annotations" on annotations
--   for all using (auth.uid()::text = user_id);
