-- Dashboard Migration: add doc_type column to documents
-- Run this in your Supabase SQL editor

-- Add doc_type column with default 'note'
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS doc_type text NOT NULL DEFAULT 'note';

-- Index for quick system-doc lookups
CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type);

-- Ensure only one todo document per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_unique_todo
  ON documents(user_id, doc_type) WHERE doc_type = 'todo';

-- Ensure only one daily_parent document per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_unique_daily_parent
  ON documents(user_id, doc_type) WHERE doc_type = 'daily_parent';
