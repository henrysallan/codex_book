-- Share link support: add share_slug column to documents
-- A non-null share_slug means the document is publicly shared at /share/<slug>

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS share_slug TEXT UNIQUE;

-- Index for fast lookups by slug
CREATE INDEX IF NOT EXISTS idx_documents_share_slug ON documents(share_slug)
  WHERE share_slug IS NOT NULL;
