-- =============================================================================
-- User isolation for search + satellite tables
--
-- WHY
-- ---
-- The anon key ships in the browser. Tables without RLS are world-readable.
-- `search_documents` is SECURITY DEFINER with no user filter, so even the RLS
-- on `documents` does not apply to ⌘⇧F or the AI retrieval path.
-- Server-side AI uses the service-role key (RLS bypass), so RPCs and queries
-- must take an explicit `p_user_id` from a verified JWT.
--
-- Apply in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- After this runs:
--   - Browser search uses auth.uid() (client cannot spoof another user).
--   - Service-role AI search must pass p_user_id or it returns zero rows.
--   - Anon callers cannot pass a victim uuid to read private notes.
-- =============================================================================

-- ── 1. Drop prior RPC signatures (CREATE OR REPLACE cannot add arguments) ──

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'search_documents',
        'match_chunks',
        'match_documents',
        'match_annotations',
        'get_all_tags'
      )
  loop
    execute 'drop function if exists ' || r.sig;
  end loop;
end $$;

-- ── 2. search_documents(query, p_user_id) ──
-- SECURITY INVOKER so browser RLS applies. Service-role callers pass p_user_id.
-- coalesce(auth.uid(), p_user_id) means a logged-in user cannot spoof; anon
-- with a guessed uuid still hits documents RLS (own + shared only).

create function search_documents(
  search_query text,
  p_user_id uuid default null
)
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
  v_user_id uuid := coalesce(auth.uid(), p_user_id);
  fts_count int;
begin
  if v_user_id is null then
    return;
  end if;

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
  where d.user_id = v_user_id
    and d.fts @@ websearch_to_tsquery('english', search_query)
  order by rank desc
  limit 20;

  get diagnostics fts_count = row_count;

  if fts_count = 0 then
    return query
    select
      d.id,
      d.title,
      d.subtitle,
      d.folder_id,
      d.tags,
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
    where d.user_id = v_user_id
      and (
        d.title % search_query
        or d.content % search_query
      )
    order by rank desc
    limit 20;
  end if;
end;
$$ language plpgsql security invoker;

revoke all on function search_documents(text, uuid) from public;
grant execute on function search_documents(text, uuid) to anon, authenticated, service_role;

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('match_chunks', 'match_documents', 'match_annotations', 'get_all_tags')
  loop
    execute 'revoke all on function ' || r.sig || ' from public';
    execute 'grant execute on function ' || r.sig || ' to authenticated, service_role';
  end loop;
end $$;

-- ── 3. Vector match RPCs — same user filter ──

create function match_chunks(
  query_embedding vector(1536),
  match_threshold float default 0.5,
  match_count int default 20,
  p_user_id uuid default null
)
returns table (
  id uuid,
  document_id uuid,
  chunk_index integer,
  content text,
  summary text,
  tags text[],
  similarity float
) as $$
declare
  v_user_id uuid := coalesce(auth.uid(), p_user_id);
begin
  if v_user_id is null then
    return;
  end if;

  return query
  select
    dc.id,
    dc.document_id,
    dc.chunk_index,
    dc.content,
    dc.summary,
    dc.tags,
    1 - (dc.embedding <=> query_embedding) as similarity
  from document_chunks dc
  join documents d on d.id = dc.document_id
  where d.user_id = v_user_id
    and dc.embedding is not null
    and 1 - (dc.embedding <=> query_embedding) > match_threshold
  order by dc.embedding <=> query_embedding
  limit match_count;
end;
$$ language plpgsql security invoker;

create function match_documents(
  query_embedding vector(1536),
  match_threshold float default 0.5,
  match_count int default 10,
  p_user_id uuid default null
)
returns table (
  id uuid,
  title text,
  ai_summary text,
  ai_tags text[],
  similarity float
) as $$
declare
  v_user_id uuid := coalesce(auth.uid(), p_user_id);
begin
  if v_user_id is null then
    return;
  end if;

  return query
  select
    d.id,
    d.title,
    d.ai_summary,
    d.ai_tags,
    1 - (d.embedding <=> query_embedding) as similarity
  from documents d
  where d.user_id = v_user_id
    and d.embedding is not null
    and 1 - (d.embedding <=> query_embedding) > match_threshold
  order by d.embedding <=> query_embedding
  limit match_count;
end;
$$ language plpgsql security invoker;

create function match_annotations(
  query_embedding vector(1536),
  match_threshold float default 0.5,
  match_count int default 10,
  p_user_id uuid default null
)
returns table (
  id uuid,
  document_id uuid,
  highlighted_text text,
  summary text,
  similarity float
) as $$
declare
  v_user_id uuid := coalesce(auth.uid(), p_user_id);
begin
  if v_user_id is null then
    return;
  end if;

  return query
  select
    a.id,
    a.document_id,
    a.highlighted_text,
    a.summary,
    1 - (a.embedding <=> query_embedding) as similarity
  from annotations a
  join documents d on d.id = a.document_id
  where d.user_id = v_user_id
    and a.embedding is not null
    and 1 - (a.embedding <=> query_embedding) > match_threshold
  order by a.embedding <=> query_embedding
  limit match_count;
end;
$$ language plpgsql security invoker;

create function get_all_tags(p_user_id uuid default null)
returns text[] as $$
declare
  v_user_id uuid := coalesce(auth.uid(), p_user_id);
begin
  if v_user_id is null then
    return array[]::text[];
  end if;

  return (
    select array_agg(distinct tag)
    from (
      select unnest(ai_tags) as tag
      from documents
      where user_id = v_user_id
      union
      select unnest(dc.tags) as tag
      from document_chunks dc
      join documents d on d.id = dc.document_id
      where d.user_id = v_user_id
    ) t
  );
end;
$$ language plpgsql security invoker;

-- ── 4. Re-home leftover `local` rows so enabling RLS does not hide them ──
-- Satellite tables defaulted user_id to text 'local' before Google auth.
-- documents.user_id is uuid. Copy the parent document owner where we can;
-- if the corpus has a single owner, use that for rows with no parent doc.

update annotations a
set user_id = d.user_id::text
from documents d
where a.document_id = d.id
  and a.user_id in ('local', '');

update attachments a
set user_id = d.user_id::text
from documents d
where a.document_id = d.id
  and a.user_id in ('local', '');

do $$
declare
  only_user text;
begin
  select user_id::text into only_user
  from documents
  group by user_id
  having count(*) = (select count(*) from documents)
  limit 1;

  if only_user is not null then
    update pdf_annotations
      set user_id = only_user
      where user_id in ('local', '');
    update moodboard_assets
      set user_id = only_user
      where user_id in ('local', '');
    update usage_logs
      set user_id = only_user
      where user_id in ('local', '');
  end if;
end $$;

-- ── 5. RLS on satellite tables ──
-- documents.user_id is uuid. annotations/attachments/pdf/usage/moodboard_assets
-- store user_id as text. Chunks/moodboard_state/objects have no user_id —
-- scope through the parent document.

alter table document_chunks enable row level security;
drop policy if exists "Users can view own chunks" on document_chunks;
drop policy if exists "Users can insert own chunks" on document_chunks;
drop policy if exists "Users can update own chunks" on document_chunks;
drop policy if exists "Users can delete own chunks" on document_chunks;
create policy "Users can view own chunks"
  on document_chunks for select
  using (exists (
    select 1 from documents d
    where d.id = document_chunks.document_id and d.user_id = auth.uid()
  ));
create policy "Users can insert own chunks"
  on document_chunks for insert
  with check (exists (
    select 1 from documents d
    where d.id = document_chunks.document_id and d.user_id = auth.uid()
  ));
create policy "Users can update own chunks"
  on document_chunks for update
  using (exists (
    select 1 from documents d
    where d.id = document_chunks.document_id and d.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from documents d
    where d.id = document_chunks.document_id and d.user_id = auth.uid()
  ));
create policy "Users can delete own chunks"
  on document_chunks for delete
  using (exists (
    select 1 from documents d
    where d.id = document_chunks.document_id and d.user_id = auth.uid()
  ));

alter table annotations enable row level security;
drop policy if exists "Users can view own annotations" on annotations;
drop policy if exists "Users can insert own annotations" on annotations;
drop policy if exists "Users can update own annotations" on annotations;
drop policy if exists "Users can delete own annotations" on annotations;
create policy "Users can view own annotations"
  on annotations for select
  using (auth.uid()::text = user_id);
create policy "Users can insert own annotations"
  on annotations for insert
  with check (auth.uid()::text = user_id);
create policy "Users can update own annotations"
  on annotations for update
  using (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id);
create policy "Users can delete own annotations"
  on annotations for delete
  using (auth.uid()::text = user_id);

alter table pdf_annotations enable row level security;
drop policy if exists "Users can view own pdf annotations" on pdf_annotations;
drop policy if exists "Users can insert own pdf annotations" on pdf_annotations;
drop policy if exists "Users can update own pdf annotations" on pdf_annotations;
drop policy if exists "Users can delete own pdf annotations" on pdf_annotations;
create policy "Users can view own pdf annotations"
  on pdf_annotations for select
  using (auth.uid()::text = user_id);
create policy "Users can insert own pdf annotations"
  on pdf_annotations for insert
  with check (auth.uid()::text = user_id);
create policy "Users can update own pdf annotations"
  on pdf_annotations for update
  using (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id);
create policy "Users can delete own pdf annotations"
  on pdf_annotations for delete
  using (auth.uid()::text = user_id);

alter table attachments enable row level security;
drop policy if exists "Users can view own attachments" on attachments;
drop policy if exists "Users can insert own attachments" on attachments;
drop policy if exists "Users can update own attachments" on attachments;
drop policy if exists "Users can delete own attachments" on attachments;
create policy "Users can view own attachments"
  on attachments for select
  using (auth.uid()::text = user_id);
create policy "Users can insert own attachments"
  on attachments for insert
  with check (auth.uid()::text = user_id);
create policy "Users can update own attachments"
  on attachments for update
  using (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id);
create policy "Users can delete own attachments"
  on attachments for delete
  using (auth.uid()::text = user_id);

alter table usage_logs enable row level security;
drop policy if exists "Users can view own usage logs" on usage_logs;
drop policy if exists "Users can insert own usage logs" on usage_logs;
create policy "Users can view own usage logs"
  on usage_logs for select
  using (auth.uid()::text = user_id);
create policy "Users can insert own usage logs"
  on usage_logs for insert
  with check (auth.uid()::text = user_id);

alter table moodboard_state enable row level security;
drop policy if exists "Users can view own moodboard state" on moodboard_state;
drop policy if exists "Users can insert own moodboard state" on moodboard_state;
drop policy if exists "Users can update own moodboard state" on moodboard_state;
drop policy if exists "Users can delete own moodboard state" on moodboard_state;
create policy "Users can view own moodboard state"
  on moodboard_state for select
  using (exists (
    select 1 from documents d
    where d.id = moodboard_state.document_id and d.user_id = auth.uid()
  ));
create policy "Users can insert own moodboard state"
  on moodboard_state for insert
  with check (exists (
    select 1 from documents d
    where d.id = moodboard_state.document_id and d.user_id = auth.uid()
  ));
create policy "Users can update own moodboard state"
  on moodboard_state for update
  using (exists (
    select 1 from documents d
    where d.id = moodboard_state.document_id and d.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from documents d
    where d.id = moodboard_state.document_id and d.user_id = auth.uid()
  ));
create policy "Users can delete own moodboard state"
  on moodboard_state for delete
  using (exists (
    select 1 from documents d
    where d.id = moodboard_state.document_id and d.user_id = auth.uid()
  ));

alter table moodboard_objects enable row level security;
drop policy if exists "Users can view own moodboard objects" on moodboard_objects;
drop policy if exists "Users can insert own moodboard objects" on moodboard_objects;
drop policy if exists "Users can update own moodboard objects" on moodboard_objects;
drop policy if exists "Users can delete own moodboard objects" on moodboard_objects;
create policy "Users can view own moodboard objects"
  on moodboard_objects for select
  using (exists (
    select 1 from documents d
    where d.id = moodboard_objects.moodboard_id and d.user_id = auth.uid()
  ));
create policy "Users can insert own moodboard objects"
  on moodboard_objects for insert
  with check (exists (
    select 1 from documents d
    where d.id = moodboard_objects.moodboard_id and d.user_id = auth.uid()
  ));
create policy "Users can update own moodboard objects"
  on moodboard_objects for update
  using (exists (
    select 1 from documents d
    where d.id = moodboard_objects.moodboard_id and d.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from documents d
    where d.id = moodboard_objects.moodboard_id and d.user_id = auth.uid()
  ));
create policy "Users can delete own moodboard objects"
  on moodboard_objects for delete
  using (exists (
    select 1 from documents d
    where d.id = moodboard_objects.moodboard_id and d.user_id = auth.uid()
  ));

alter table moodboard_assets enable row level security;
drop policy if exists "Users can view own moodboard assets" on moodboard_assets;
drop policy if exists "Users can insert own moodboard assets" on moodboard_assets;
drop policy if exists "Users can update own moodboard assets" on moodboard_assets;
drop policy if exists "Users can delete own moodboard assets" on moodboard_assets;
create policy "Users can view own moodboard assets"
  on moodboard_assets for select
  using (auth.uid()::text = user_id);
create policy "Users can insert own moodboard assets"
  on moodboard_assets for insert
  with check (auth.uid()::text = user_id);
create policy "Users can update own moodboard assets"
  on moodboard_assets for update
  using (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id);
create policy "Users can delete own moodboard assets"
  on moodboard_assets for delete
  using (auth.uid()::text = user_id);

-- ── 6. Google refresh tokens: server-only ──
-- RLS already exists (rls_user_google_tokens_migration.sql). Revoke client
-- grants so the anon key cannot read or write this table even with a stolen
-- user JWT. Server routes use the service-role key.

alter table user_google_tokens enable row level security;
revoke all on table user_google_tokens from public, anon, authenticated;
grant all on table user_google_tokens to service_role;
