-- Search egress fix: return a short ts_headline snippet from the server
-- instead of the full `content` column. Reduces per-query egress from
-- ~20 × full-document payload to ~20 × ~200-char snippet.
--
-- Safe to run after auth_migration.sql (supersedes the search_documents function there).
-- Drop first: Postgres cannot change a function's return-table columns via
-- `create or replace`, so we drop and recreate.

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
      -- strip BlockNote JSON-ish noise for a cleaner snippet; good enough heuristic
      regexp_replace(d.content, '[\{\}\[\]":,]', ' ', 'g'),
      websearch_to_tsquery('english', search_query),
      'MaxWords=20, MinWords=8, ShortWord=3, MaxFragments=1'
    ) as snippet,
    ts_rank(d.fts, websearch_to_tsquery('english', search_query)) as rank,
    d.created_at,
    d.updated_at
  from documents d
  where d.fts @@ websearch_to_tsquery('english', search_query)
    and d.user_id = auth.uid()
  order by rank desc
  limit 20;
end;
$$ language plpgsql security definer;
