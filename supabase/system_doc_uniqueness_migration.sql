-- Unique system documents (todo / daily_parent / quick_note_parent / one daily per day).
-- Run in the Supabase SQL editor after user_isolation_migration.sql.
-- Deduplicates existing races first so the unique indexes can be created.

-- Date tag helper: first YYYY-MM-DD entry in tags[]. Used by unique indexes.
create or replace function date_tag_from_tags(tags text[])
returns text
language sql
immutable
parallel safe
as $$
  select t
  from unnest(coalesce(tags, '{}'::text[])) as t
  where t ~ '^\d{4}-\d{2}-\d{2}$'
  order by t
  limit 1;
$$;

-- ── Dedup helpers: reparent children onto the keeper, then delete extras ──

-- Extra quick_note_parent rows (keep oldest per user)
with ranked as (
  select id, user_id,
         row_number() over (partition by user_id order by created_at asc, id asc) as rn
  from documents
  where doc_type = 'quick_note_parent'
),
keepers as (select * from ranked where rn = 1),
losers as (select * from ranked where rn > 1)
update documents d
set parent_document_id = k.id
from losers l
join keepers k on k.user_id = l.user_id
where d.parent_document_id = l.id;

with ranked as (
  select id, user_id,
         row_number() over (partition by user_id order by created_at asc, id asc) as rn
  from documents
  where doc_type = 'quick_note_parent'
)
delete from documents d
using ranked r
where d.id = r.id and r.rn > 1;

-- Extra daily docs for the same civil date (keep oldest)
with ranked as (
  select id, user_id, date_tag_from_tags(tags) as dtag,
         row_number() over (
           partition by user_id, date_tag_from_tags(tags)
           order by created_at asc, id asc
         ) as rn
  from documents
  where doc_type = 'daily' and date_tag_from_tags(tags) is not null
),
keepers as (select * from ranked where rn = 1),
losers as (select * from ranked where rn > 1)
update documents d
set parent_document_id = k.id
from losers l
join keepers k on k.user_id = l.user_id and k.dtag = l.dtag
where d.parent_document_id = l.id;

with ranked as (
  select id,
         row_number() over (
           partition by user_id, date_tag_from_tags(tags)
           order by created_at asc, id asc
         ) as rn
  from documents
  where doc_type = 'daily' and date_tag_from_tags(tags) is not null
)
delete from documents d
using ranked r
where d.id = r.id and r.rn > 1;

-- Extra single-tag dated notes under the same parent (quick-note day containers)
with ranked as (
  select id, user_id, parent_document_id, date_tag_from_tags(tags) as dtag,
         row_number() over (
           partition by user_id, parent_document_id, date_tag_from_tags(tags)
           order by created_at asc, id asc
         ) as rn
  from documents
  where doc_type = 'note'
    and parent_document_id is not null
    and cardinality(tags) = 1
    and date_tag_from_tags(tags) is not null
),
keepers as (select * from ranked where rn = 1),
losers as (select * from ranked where rn > 1)
update documents d
set parent_document_id = k.id
from losers l
join keepers k
  on k.user_id = l.user_id
 and k.parent_document_id = l.parent_document_id
 and k.dtag = l.dtag
where d.parent_document_id = l.id;

with ranked as (
  select id,
         row_number() over (
           partition by user_id, parent_document_id, date_tag_from_tags(tags)
           order by created_at asc, id asc
         ) as rn
  from documents
  where doc_type = 'note'
    and parent_document_id is not null
    and cardinality(tags) = 1
    and date_tag_from_tags(tags) is not null
)
delete from documents d
using ranked r
where d.id = r.id and r.rn > 1;

-- Extra todo / daily_parent (keep oldest; these already had unique indexes
-- but races before the index was applied can still exist)
with ranked as (
  select id, user_id, doc_type,
         row_number() over (partition by user_id, doc_type order by created_at asc, id asc) as rn
  from documents
  where doc_type in ('todo', 'daily_parent')
)
delete from documents d
using ranked r
where d.id = r.id and r.rn > 1;

-- ── Unique indexes ──

create unique index if not exists idx_documents_unique_quick_note_parent
  on documents (user_id) where doc_type = 'quick_note_parent';

create unique index if not exists idx_documents_one_daily_per_day
  on documents (user_id, (date_tag_from_tags(tags)))
  where doc_type = 'daily' and date_tag_from_tags(tags) is not null;

-- Day containers: a note whose only tag is a date, nested under a parent.
create unique index if not exists idx_documents_one_dated_note_per_parent_day
  on documents (user_id, parent_document_id, (date_tag_from_tags(tags)))
  where doc_type = 'note'
    and parent_document_id is not null
    and cardinality(tags) = 1
    and date_tag_from_tags(tags) is not null;
