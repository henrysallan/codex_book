-- Fix: search_documents RPC was filtering by `d.user_id = auth.uid()`, but
-- server-side callers (chat API) use the service-role key and have no user
-- JWT, so auth.uid() returns NULL and the function returned zero rows.
--
-- NOTE: This migration has been superseded by trigram_search_migration.sql
-- which includes FTS improvements AND trigram fallback. Run that instead
-- if applying fresh. Kept here for history.
--
-- The chat pipeline already relies on server-side service-role access for
-- every other retrieval path (match_chunks, match_documents, direct table
-- queries). This migration brings search_documents in line with that model.
--
-- If multi-user isolation at the RPC layer becomes necessary, add an explicit
-- `p_user_id uuid` parameter and filter on that instead of auth.uid().

drop function if exists search_documents(text);

create function search_documents(search_query text)
returns table (
  id uuid,
  title text,
  subtitle text,
  folder_id uuid,
  tags text[],
  snippet text,
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
    ts_headline(
      'english',
      -- Strip BlockNote JSON structure but keep readable text.
      -- Two passes: first remove JSON keys/delimiters, then collapse whitespace.
      regexp_replace(
        regexp_replace(d.content, '"(type|id|props|children|text|styles|content)":\s*', '', 'g'),
        '[\{\}\[\]",]', ' ', 'g'
      ),
      websearch_to_tsquery('english', search_query),
      'MaxWords=30, MinWords=10, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … "'
    ) as snippet,
    ts_rank_cd(d.fts, websearch_to_tsquery('english', search_query)) as rank,
    d.created_at,
    d.updated_at
  from documents d
  where d.fts @@ websearch_to_tsquery('english', search_query)
  order by rank desc
  limit 20;
end;
$$ language plpgsql security definer;
