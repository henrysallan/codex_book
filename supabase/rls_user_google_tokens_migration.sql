-- =============================================================================
-- RLS for user_google_tokens
--
-- WHY THIS IS URGENT
-- ------------------
-- `user_google_tokens` stores live Google **refresh tokens**. It was created
-- with plain `create table`, so RLS was never enabled (unlike documents /
-- folders / backlinks, which auth_migration.sql protects).
--
-- Supabase grants the `anon` and `authenticated` roles SELECT on public-schema
-- tables by default; RLS is the only thing that gates rows. With RLS off, any
-- holder of the anon key can read every row in this table. The anon key is
-- public by design — it already ships in the Next.js bundle as
-- NEXT_PUBLIC_SUPABASE_ANON_KEY, and the trac3 iOS app is about to embed it in
-- a distributable binary. A Google refresh token is not something the anon key
-- should reach.
--
-- WHAT THIS DOES NOT BREAK
-- ------------------------
-- `/api/drive/token` (and the new `/api/google/token`) read this table with the
-- SERVICE ROLE key, which bypasses RLS entirely. Server-side token exchange is
-- unaffected.
--
-- The browser client in src/lib/auth.tsx upserts its own row on every auth
-- state change. An upsert is INSERT ... ON CONFLICT DO UPDATE, so it needs both
-- an insert and an update policy — both are below.
--
-- TYPE NOTE
-- ---------
-- `user_google_tokens.user_id` is `text`, while `documents.user_id` is `uuid`.
-- That split is pre-existing (see §11 of docs/cortex-architecture-for-ios.md).
-- These policies cast with `auth.uid()::text` to match the column as it is.
-- Do not change the column type here — attachments/annotations/usage_logs share
-- the text convention and should be unified in one deliberate pass, not as a
-- side effect of a security fix.
--
-- Apply in the Supabase SQL editor. Idempotent — safe to re-run.
-- =============================================================================

-- 1. Drop any prior versions of these policies so the script can be re-run.
drop policy if exists "Users can view own google tokens" on user_google_tokens;
drop policy if exists "Users can insert own google tokens" on user_google_tokens;
drop policy if exists "Users can update own google tokens" on user_google_tokens;
drop policy if exists "Users can delete own google tokens" on user_google_tokens;

-- 2. Enable RLS. Once this runs, anon/authenticated see only rows the policies
--    below admit; with no policies at all they would see nothing.
alter table user_google_tokens enable row level security;

-- 3. Per-user policies.
create policy "Users can view own google tokens"
  on user_google_tokens for select
  using (auth.uid()::text = user_id);

create policy "Users can insert own google tokens"
  on user_google_tokens for insert
  with check (auth.uid()::text = user_id);

create policy "Users can update own google tokens"
  on user_google_tokens for update
  using (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id);

create policy "Users can delete own google tokens"
  on user_google_tokens for delete
  using (auth.uid()::text = user_id);

-- 4. Verify. Expect rowsecurity = true and four policies.
--
--   select relname, relrowsecurity
--     from pg_class where relname = 'user_google_tokens';
--
--   select policyname, cmd from pg_policies
--    where tablename = 'user_google_tokens';
--
-- Then confirm the web app still signs in and Drive still lists files. If Drive
-- breaks, the cause is the service-role key being absent from the environment
-- (getServerSupabase() falls back to anon and warns) — not these policies.
