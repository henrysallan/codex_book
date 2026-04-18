-- Enable pg_trgm for fuzzy / typo-tolerant search.
-- Falls back to trigram similarity when FTS (tsvector) returns zero rows,
-- e.g. misspelled names, partial words, foreign terms.

create extension if not exists pg_trgm;

-- GIN trigram index on title for fast fuzzy title matching
create index if not exists idx_documents_title_trgm
  on documents using gin (title gin_trgm_ops);

-- GIN trigram index on content for fuzzy content matching (heavier but
-- covers the case where the user misspells a term that only appears in body text)
create index if not exists idx_documents_content_trgm
  on documents using gin (content gin_trgm_ops);

-- ─── Upgraded search_documents: FTS first, trigram fallback ───

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
declare
  fts_count int;
begin
  -- ── Pass 1: Full-text search (exact stem matching) ──
  return query
  select
    d.id,
    d.title,
    d.subtitle,
    d.folder_id,
    d.tags,
    ts_headline(
      'english',
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

  -- Check how many rows FTS returned
  get diagnostics fts_count = row_count;

  -- ── Pass 2: Trigram fallback (only when FTS found nothing) ──
  if fts_count = 0 then
    return query
    select
      d.id,
      d.title,
      d.subtitle,
      d.folder_id,
      d.tags,
      -- No ts_headline available (query doesn't match tsvector), so use
      -- a substring of the cleaned content as the snippet
      left(
        regexp_replace(
          regexp_replace(d.content, '"(type|id|props|children|text|styles|content)":\s*', '', 'g'),
          '[\{\}\[\]",]', ' ', 'g'
        ),
        200
      ) as snippet,
      greatest(
        similarity(d.title, search_query),
        similarity(d.content, search_query)
      )::real as rank,
      d.created_at,
      d.updated_at
    from documents d
    where
      d.title % search_query          -- trigram similarity on title
      or d.content % search_query     -- trigram similarity on content
    order by rank desc
    limit 20;
  end if;
end;
$$ language plpgsql security definer;
