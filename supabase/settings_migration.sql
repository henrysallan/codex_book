-- Add per-note settings column to documents table
-- Run this in the Supabase SQL editor

ALTER TABLE documents
ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;
