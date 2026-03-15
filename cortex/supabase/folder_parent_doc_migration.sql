-- Add parent_document_id to folders table
-- Allows folders to be nested under documents (in addition to nesting under other folders)
ALTER TABLE folders
  ADD COLUMN IF NOT EXISTS parent_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_folders_parent_document_id ON folders(parent_document_id);
