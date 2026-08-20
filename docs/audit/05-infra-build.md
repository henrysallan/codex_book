# 05 — Infra, Config & Build Health

**Finding IDs:** `INF-C1` … `INF-L5`. Referenced elsewhere as "Infra C1", etc.
**Environment at audit:** Node v24.2.0 · Next 16.1.6 · React 19.2.3 · TS 5.9.3 strict · no test suite.

---

## 1. SPEC — current tooling

- **Framework:** Next 16.1.6 App Router (Turbopack build), React 19.2.3, TS strict. `next.config.ts`
  (18 ln) only aliases `canvas` away (Turbopack `resolveAlias` + webpack `alias.canvas=false`) to keep
  pdf.js's optional dep out of the bundle. No `headers`/`images`/`redirects` config.
- **tsconfig:** `strict`, `target ES2017` (dated default, harmless), `moduleResolution bundler`,
  `@/* → ./src/*`, `skipLibCheck`.
- **postcss:** single `@tailwindcss/postcss` plugin (Tailwind v4, CSS-first, no `tailwind.config`).
- **eslint:** flat config = next core-web-vitals + typescript, then a `globalIgnores([...])` that
  **replaces** the preset defaults with only `.next/ out/ build/ next-env.d.ts` — notably **not**
  `public/` (see INF-H1).
- **globals.css:** 320 ln, well-structured (theme vars → `@theme inline` → labeled third-party
  overrides). Matches convention.
- **package.json:** 4 scripts (`dev`/`build`/`start`/`lint`). **No `engines`, `.nvmrc`, or
  `packageManager`.** npm lockfile present.
- **Deployment:** no `vercel.json`/`vercel.ts`; `.vercel/project.json` links project `codex-book`. All
  function config is per-route via `runtime`/`maxDuration`.
- **Docs:** `DEVGUIDE.md` (accurate), `docs/cortex-architecture-for-ios.md`, `plan/*` specs (all
  consistent). `implementaiton.md` (git-tracked, typo'd name) is confirmed the stale vision doc naming
  assistant-ui / Vercel AI SDK / Yjs / Ollama — none used (zero imports). The only self-contradicting
  doc is the one the DEVGUIDE already disclaims.

---

## 2. Build-health results

| Check | Result |
|---|---|
| `tsc --noEmit` | **Clean** — zero errors |
| `next build` | **Passes** — Turbopack, ~13s, 11/11 static pages. **No bundle-size table printed** → first-load JS is unquantified; no size guardrail |
| `eslint` | 1511 problems, but **1477 come from `public/pdf.worker.min.mjs`** (a 1 MB vendored file). Real src: **16 errors, 18 warnings** |
| `npm audit --omit=dev` | **12 vulns (6 moderate, 6 high)**, all prod deps |
| depcheck (manual) | one dead devDep: `@types/uuid` (uuid v13 ships its own types); `@mantine/core` has 0 direct imports but is a required peer of `@blocknote/mantine` — keep |

**Real ESLint errors (16):** `react-hooks/set-state-in-effect` ×8 (Sidebar ×4, CommandPalette ×2,
BacklinksPanel, auth.tsx); `rules-of-hooks` ×2 (`pageLink.tsx:19`, `shareSchema.tsx:34` — hooks inside
BlockNote render fns); `react-hooks/refs` (`page.tsx:116`); `no-explicit-any` ×3 (DatabaseTable ×2,
NotionImport); `prefer-const` ×2. **Warnings (18):** mostly `no-unused-vars` dead imports;
`ChatPanel.tsx:300` missing deps (`model`, `researchMode` — a real stale-closure candidate);
`DatabaseTable.tsx:269` React-Compiler-incompatible; `alt-text` in DriveFolder.

---

## 3. Findings

### CRITICAL

**INF-C1 — Next.js 16.1.6 carries ~28 published advisories, fixed in 16.3.1.** `npm audit` lists HTTP
request smuggling in rewrites, middleware/proxy bypasses, RSC cache poisoning, CSP-nonce XSS, several
DoS vectors, and "unauthenticated disclosure of internal Server Function endpoints"
(GHSA-955p-x3mx-jcvp). Given the `/api/ai/*` routes are already unauthenticated + service-role
([Security C4](01-security.md)), the framework is the only shield on a deployed instance.
`npm audit fix --force` → next@16.3.1 (also pulls fixed postcss + sharp). **Single highest-value
action in the audit.**

### HIGH

**INF-H1 — ESLint lints the vendored 1 MB worker, drowning real signal 43:1.** `eslint.config.mjs`
omits `public/**` from `globalIgnores`; 1477/1511 problems and 7/23 errors come from that one minified
file. Lint isn't run in CI or build (Next 16 no longer lints during `next build` — confirmed: build
passed with 23 lint errors present). *Fix:* add `"public/**"` to `globalIgnores`.

**INF-H2 — No CI at all.** No `.github/`, no workflows, no pre-commit hooks. With no tests, nothing
gates a broken `tsc`/`build`/`lint` from landing on `main`, which auto-deploys via the linked Vercel
project. Even a 15-line workflow (`tsc --noEmit` + `next build`) would be a step change.

**INF-H3 — Zero error boundaries.** No `error.tsx`, `global-error.tsx`, or `not-found.tsx` under
`src/app/`, and no ErrorBoundary component. Any render throw white-screens the whole app — including
the public `/share/[slug]` page, which should have one at minimum.

**INF-H4 — Prod-dependency vulnerabilities beyond Next (12: 6 high, 6 moderate).** High:
`nanoid ≤3.3.17`, `linkify-it ≤5.0.1` (quadratic DoS — reachable via markdown-it under BlockNote/
react-markdown rendering of user/AI text), `sharp <0.35.0`, `postcss ≤8.5.22` (both via next),
`ws 8.0.0-8.20.1` (Supabase realtime, transitive). Moderate: `markdown-it`, `uuid 13.0.0`
(GHSA-w5hq-g745-h8pq — **direct dep, fixed in 13.0.2, a patch bump**), and blocknote's bundled older
uuid. `npm audit fix` handles ws/linkify-it/markdown-it/nanoid non-breaking; the rest ride the next
upgrade; blocknote's uuid needs blocknote ≥0.48.2.

### MEDIUM

**INF-M1 — Route-config convention broken in 2 of 7 API routes.** DEVGUIDE §9 mandates
`runtime="nodejs"` + explicit `maxDuration`. `ai/usage` has runtime but no maxDuration;
`drive/token` and `share/[slug]` have **neither** (both do network/DB I/O).

**INF-M2 — Debug/dev artifacts ship in prod and git.** `/pdf-test` is a live route (hardcoded mozilla
test PDF URL, unused import); `debug-share.mjs` at repo root is a git-tracked script that parses
`.env.local` and connects with the **service-role key**; `implementaiton.md` is tracked despite being
disclaimed. No secrets committed, but prod surface + repo noise.

**INF-M3 — React 19 hook-correctness errors are bugs-in-waiting.** The 8 `set-state-in-effect` errors
(Sidebar ×4) cause cascading renders; the 2 `rules-of-hooks` + `refs` + `incompatible-library` errors
mean **React Compiler cannot be safely enabled**; `ChatPanel.tsx:300`'s missing deps are a live
stale-closure risk in the send path.

**INF-M4 — No Node version pinning.** No `engines`/`.nvmrc`/`packageManager`. Dev on Node 24;
`@types/node` pinned to `^20` — types and runtime disagree by 2 majors.

**INF-M5 — `@anthropic-ai/sdk` is 42 minor versions behind (0.78 → 0.120).** For the app's core
feature (streaming + 27-tool loop) in a pre-1.0 SDK, deferring makes the eventual jump harder. Also
`@supabase/ssr` 0.9→0.12, `@supabase/supabase-js` 2.98→2.112.

### LOW

**INF-L1 — Bundle red flags, mostly handled.** tldraw (MoodboardCanvas) and react-pdf (FileViewer)
are correctly `next/dynamic` + `ssr:false`. Residuals: the **share page** statically imports
`@blocknote/react` + `@blocknote/mantine` + two CSS bundles, so every public share-link visitor
downloads the whole editor stack to view a read-only doc; and Turbopack prints no size table so none of
it is measured. `INF-L2` console.log noise is modest (21, mostly convention-sanctioned server logs with
`[/api/...]` prefix; one client stray in ChatPanel). `INF-L3` **zero TODO/FIXME/HACK** in src (good).
`INF-L4` hardcoded URLs are all legitimate (Google endpoints + the pdf-test sample); no emails/UUIDs.
`INF-L5` README is untouched create-next-app boilerplate; `blocksToMarkdown.ts` imported nowhere.

**Positives:** tsc clean under strict; build green in 13s; secrets handled correctly (`.env`
untracked, service key server-only, Google secret never shipped, `/api/drive/token` authenticates the
caller); heavy-component dynamic-import convention followed.

---

## 4. Dependency table

| Package | Cur | Latest | Notes |
|---|---|---|---|
| next | 16.1.6 | **16.3.1** | **~28 advisories — upgrade (INF-C1)** |
| react / react-dom | 19.2.3 | 19.2.8 | patch drift |
| @anthropic-ai/sdk | 0.78.0 | 0.120.0 | pre-1.0, 42 minors behind (INF-M5) |
| openai | 6.27.0 | 7.5.0 | whole SDK for one embeddings call — a `fetch` would drop it |
| groq-sdk | 1.1.1 | 1.5.0 | fine |
| @blocknote/* ×4 | 0.47.1 | 0.54.0 | pre-1.0; bundles vulnerable uuid (fixed ≥0.48.2); risky upgrade — the editor is the app's heart |
| @mantine/core | 8.3.16 | 9.5.1 | required peer of @blocknote/mantine — **keep**, don't jump to v9 |
| @supabase/supabase-js | 2.98.0 | 2.112.3 | safe minor bump |
| @supabase/ssr | 0.9.0 | 0.12.4 | one function used |
| tldraw | 4.5.3 | 5.3.2 | major behind; moodboard snapshots need migration care |
| react-pdf | 10.4.1 | — | pairs with the **vendored** 1 MB `public/pdf.worker.min.mjs` — version can silently drift |
| uuid | 13.0.0 | 13.0.2 | **moderate advisory in exactly 13.0.0 — patch** |
| @tanstack/react-table | 8.21.3 | 9.1.2 | v9 is a rewrite; stay on 8 |
| zustand / react-markdown / remark-gfm / dnd-kit | — | — | fine |
| lucide-react | 0.577.0 | 1.33.0 | icon-name churn on major; low urgency |
| @types/uuid (dev) | 10.0.0 | — | **dead — remove** |
| @types/node (dev) | 20.x | 26.x | disagrees with Node 24 (INF-M4) |

**Recommended sequence:** (1) `npm audit fix` (ws/nanoid/linkify-it/markdown-it, non-breaking) →
(2) next + eslint-config-next 16.3.1 & uuid 13.0.2 → (3) add `public/**` to eslint ignores, delete
`@types/uuid`, `--fix` dead imports → (4) minimal GitHub Actions (tsc + build) + `engines`/`.nvmrc` →
(5) `error.tsx`/`global-error.tsx` → (6) fix the 16 real lint errors → (7) schedule the
blocknote/anthropic-sdk upgrades as their own tasks.
