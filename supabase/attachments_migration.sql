-- Attachments table — stores Google Drive file references linked to documents
-- Run this in your Supabase SQL editor

create table if not exists attachments (
  id uuid primary key default uuid_generate_v4(),
  document_id uuid not null references documents(id) on delete cascade,
  user_id text not null default 'local',
  file_name text not null,
  mime_type text not null default 'application/pdf',
  file_size bigint,                    -- bytes
  drive_file_id text not null,         -- Google Drive file ID
  drive_web_view_link text,            -- Optional: direct link to view in Drive
  created_at timestamp with time zone default now()
);

create index if not exists idx_attachments_document on attachments(document_id);
create index if not exists idx_attachments_drive_file on attachments(drive_file_id);

-- Store Google OAuth refresh tokens so we can get fresh Drive access tokens
-- after the initial Supabase session's provider_token expires.
create table if not exists user_google_tokens (
  user_id text primary key,
  refresh_token text not null,
  updated_at timestamp with time zone default now()
);
