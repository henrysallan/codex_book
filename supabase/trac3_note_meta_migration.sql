-- =============================================================================
-- trac3_note_meta — sidecar metadata for notes captured by the trac3 iOS app
--
-- WHY A SEPARATE TABLE AND NOT COLUMNS ON `documents`
-- ---------------------------------------------------
-- trac3's per-note metadata is the schema of an app under active development:
-- classifier output, parsed time blocks, enrichment cards, calendar links. It
-- will churn. `documents` is Cortex's hot table, read on every page load and
-- indexed six ways — it should not churn alongside a client's feature work.
--
-- A separate table also means RLS can be written correctly from the start
-- instead of retrofitted, and that Cortex's web app can ignore this entirely.
--
-- WHAT IS DELIBERATELY *NOT* STORED HERE
-- --------------------------------------
-- `resolved_contacts` carries ONLY `displayName` and `cnID`.
--
-- trac3 resolves names in notes against the on-device contact store and keeps
-- phone numbers and email addresses on the note so its action sheet can offer
-- Message / Call / FaceTime / Email. Those never leave the device. The app's
-- stated privacy boundary is that the contact list is never uploaded and that
-- only `displayName` + `cnID` are ever sent off-device (they already go to
-- Anthropic in the synthesis prompt), so syncing phone numbers into Postgres
-- would be a real widening of that boundary, not an implementation detail.
--
-- If you ever want the phone/email round-trip for a second device, that is a
-- deliberate product decision — make it explicitly, and encrypt the payload.
-- Do not let it arrive by accident through a schema change here.
--
-- TYPE NOTE
-- ---------
-- `user_id` is `uuid` here, matching `documents.user_id`, not the `text`
-- convention used by the older annotations / attachments / usage_logs tables.
-- New tables should use uuid; the split in the old ones is a wart to unify
-- separately.
--
-- Apply in the Supabase SQL editor. Idempotent — safe to re-run.
-- =============================================================================

create table if not exists trac3_note_meta (
  -- Same id as the note's `documents` row. trac3 supplies the uuid when it
  -- creates the note, so local and remote ids are identical.
  document_id uuid primary key references documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  -- Classifier output (ClassifierPromptV3).
  note_type text,                    -- event | reminder | recommendation | thought | person_note | task | misc
  section text,                      -- time | thought | recommendation
  note_state text,                   -- pending | enriched | archived | resolved
  urgency text,
  classifier_prompt_version text,

  -- Structured time block, so a reinstall can still offer "create event"
  -- without re-running the classifier.
  parsed_time jsonb,

  -- [{ displayName, cnID, confidence }] — NO phone numbers, NO email addresses.
  -- See the note above before widening this.
  resolved_contacts jsonb,

  -- EnrichmentCard for recommendation notes: title, subtitle, summary, fields, links.
  enrichment jsonb,
  enrichment_prompt_version text,

  -- Google Calendar idempotency link { eventID, htmlLink, subject, ... }.
  calendar_event jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_trac3_note_meta_user on trac3_note_meta(user_id);
create index if not exists idx_trac3_note_meta_section on trac3_note_meta(section);

-- Keep updated_at honest. `update_updated_at` already exists (schema.sql).
drop trigger if exists trac3_note_meta_updated_at on trac3_note_meta;
create trigger trac3_note_meta_updated_at
  before update on trac3_note_meta
  for each row execute function update_updated_at();

-- ─── RLS, on from day one ───

drop policy if exists "Users can view own trac3 note meta" on trac3_note_meta;
drop policy if exists "Users can insert own trac3 note meta" on trac3_note_meta;
drop policy if exists "Users can update own trac3 note meta" on trac3_note_meta;
drop policy if exists "Users can delete own trac3 note meta" on trac3_note_meta;

alter table trac3_note_meta enable row level security;

create policy "Users can view own trac3 note meta"
  on trac3_note_meta for select
  using (auth.uid() = user_id);

create policy "Users can insert own trac3 note meta"
  on trac3_note_meta for insert
  with check (auth.uid() = user_id);

create policy "Users can update own trac3 note meta"
  on trac3_note_meta for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own trac3 note meta"
  on trac3_note_meta for delete
  using (auth.uid() = user_id);

-- Verify:
--   select policyname, cmd from pg_policies where tablename = 'trac3_note_meta';
--   select relrowsecurity from pg_class where relname = 'trac3_note_meta';
