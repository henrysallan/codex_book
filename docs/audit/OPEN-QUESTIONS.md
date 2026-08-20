# Open Questions

Decisions that change the remediation and that only you can answer. Grouped by how much they move the
plan. Each links the findings it gates.

---

## Load-bearing (answer these first — they reorder the whole plan)

### Q1. Is this instance ever reachable by anyone but you? {#q1}
The entire severity of Phase 0 hinges on this. The anon key is in the browser bundle, so "reachable"
means "anyone who has the Vercel URL." Options as I see them:
- **(a) Truly private, single-user, URL never shared** → the RLS/anon-key findings are latent (still
  worth fixing, but not on fire); make **Phase 1 (data loss)** your top priority instead.
- **(b) Shared with even one other person, or the URL is discoverable** → Phase 0 is an emergency;
  the refresh tokens and full note text are exposed today.
- **(c) You intend to make it multi-user eventually** → Phase 0 is a hard prerequisite and SEC-H4
  (open Google sign-up) plus per-user filtering in every AI path become blocking, not optional.
Gates: all of [Security](01-security.md), DATA-C1/C2.

### Q2. Is multi-user / multi-tenant actually a goal, or is "single-user" permanent?
This decides whether ~15 findings are "fix the isolation properly" or "acceptable simplification."
`create_note` assigning ownership from an arbitrary row (SEC-L3/H4), `user_id` being `text 'local'` on
half the tables (DATA §1), `search_documents` having no user filter — all are fine for permanent
single-user and wrong for multi-user. Tell me which world we're in and I'll scope accordingly.

### Q3. What's the deployment/runtime target — Vercel serverless as-is?
`groqLimiter`'s per-lambda state (AI-H4) and `logUsage` losing writes at teardown (AI-M11) are
serverless-specific. If you're on Vercel Fluid Compute / a long-lived process, the fixes differ (and
some of the 30 RPM pain eases). Also decides whether a shared token bucket (Upstash/Redis) is worth
standing up. Gates: AI-H3, AI-H4, AI-M11.

---

## Product decisions (change scope, not safety)

### Q4. Conflict handling — how much do you want?
Today it's whole-column last-write-wins with no guard (DATA-C3). Phase 1 proposes the cheap version:
a version check that *refuses* a stale write and re-seeds the editor. Full multi-tab live editing
(CRDT/Yjs) is explicitly out of scope per the DEVGUIDE — confirm you want it to stay out, and that
"refuse + reload the newer version" is acceptable UX when two tabs collide.

### Q5. Should the dashboard system-docs (todo, daily, quick-notes) be real editable documents at all?
A lot of the data-layer pain (DATA-H1, H4, H5, the read-modify-write clobbers, the O(days) N+1) comes
from these being normal `documents` rows that are *also* rewritten wholesale by dashboard sync. A
dedicated table (or block-level updates instead of whole-content rewrites) would remove a whole class
of races. Bigger change — worth it?

### Q6. Drive scope — narrow it?
Sign-in requests `drive.readonly` (whole Drive); the app only uses a `Codex` folder (SEC-M4).
Narrowing to `drive.file` is more secure but changes the OAuth consent and may require re-auth for
existing tokens. Do you want that now or later?

### Q7. What's the intended fate of the parked code?
`NotionImport.tsx` (870 ln), `SearchDialog.tsx` (195 ln), `blocksToMarkdown.ts` (182 ln) are imported
nowhere. Delete, or are they staged for imminent use? (`/pdf-test` and `debug-share.mjs` I'd remove
regardless — UI-L1, INF-M2.) Gates cleanup scope in Phase 5.

---

## Lower-stakes / confirmations

### Q8. Product name: "Codex", "Cortex", or "Book"?
Three names ship in the UI (title / chat persona / sidebar) plus `cortex:*` storage keys. Pick one and
I'll make it consistent. (Renaming the localStorage key prefix means a one-time cache reset for you.)

### Q9. Is `NEXT_PUBLIC_TLDRAW_LICENSE_KEY` actually set in production?
MoodboardCanvas hides the tldraw watermark via CSS (UI/moodboard note). If the license key isn't
present, that's a license-terms issue, not styling. Just confirm it's set.

### Q10. Embedding/model stability — are you likely to change embedding models?
There's no model/version column on stored vectors (AI-L8), so switching `text-embedding-3-small`
later would silently mix incompatible vector spaces until a full force-backfill. Cheap to add a column
now if a change is plausible. Worth doing?

### Q11. Migration strategy — greenfield DB or preserve the current one?
The current schema can't be reproduced from any single file (DATA §4). If you're willing to treat the
live DB as the source of truth and generate a fresh baseline from it, hygiene cleanup is much simpler
than reconstructing correct ordering from the 16 hand-run files. Which do you prefer?
