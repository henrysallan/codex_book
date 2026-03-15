-- Add parent_document_id to documents table for note-nesting (sub-pages)
-- Run this in your Supabase SQL editor

alter table documents
  add column if not exists parent_document_id uuid references documents(id) on delete set null;

create index if not exists idx_documents_parent_doc on documents(parent_document_id);
