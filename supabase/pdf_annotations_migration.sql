-- PDF Annotations table — highlights, notes, and chat threads on Drive PDFs
-- Run this in your Supabase SQL editor

create table if not exists pdf_annotations (
  id uuid primary key default uuid_generate_v4(),
  drive_file_id text not null,            -- Google Drive file ID
  user_id text not null,
  color text not null default 'yellow',   -- yellow | green | blue | pink | purple
  type text not null default 'highlight', -- highlight | note | chat

  -- Text anchor (for relocating the highlight across sessions)
  page_number int not null,
  anchor_exact text not null,             -- the selected text
  anchor_prefix text,                     -- ~30 chars before selection
  anchor_suffix text,                     -- ~30 chars after selection

  -- Content
  note text,                              -- for type='note'
  messages jsonb not null default '[]',   -- for type='chat'

  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create index if not exists idx_pdf_annot_file on pdf_annotations(drive_file_id);
create index if not exists idx_pdf_annot_user on pdf_annotations(user_id);

-- Auto-update updated_at (reuses the trigger function from documents)
create trigger pdf_annotations_updated_at
  before update on pdf_annotations
  for each row execute function update_updated_at();
