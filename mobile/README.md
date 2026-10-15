# Cortex iOS

Expo (SDK 57) app for reading and editing Cortex notes on iPhone. Scope is the
BlockNote editor and the file tree — no AI chat, moodboards, Drive, or PDFs.
Online-only: every read and write goes straight to Supabase.

## Setup

1. **Xcode 26.4+** (SDK 57's minimum).
2. `cp .env.example .env.local` and fill in the same Supabase URL + anon key
   the web app uses. `EXPO_PUBLIC_CORTEX_API_URL` is the deployed web origin
   (used to request AI indexing after edits; leave empty to skip).
3. Supabase dashboard → Authentication → URL Configuration → Redirect URLs:
   add `cortex://auth-callback`. Without it, Google sign-in bounces to the web
   app's Site URL.
4. `npm install`, then `npx expo run:ios` (first build compiles native code;
   after that `npm start` + the installed dev build is enough).

`/playground` (dev builds, linked from the sign-in screen) opens the editor on
a sample note covering every custom block, no sign-in needed.

## How it fits together

- **Navigation:** iOS 26 native tab bar (`expo-router/unstable-native-tabs`)
  with two tabs — **Root** (file tree) and **Notes** (the one open note).
  Tapping a note in Root opens it in Notes; page links inside a note push onto
  a back stack (`src/lib/store.ts`).
- **Editor:** BlockNote runs in a web view via an Expo DOM component
  (`src/components/editor/NoteEditor.tsx`, `"use dom"`). It must keep the web
  editor's content format exactly, so custom node shapes come from the web
  app's `src/lib/editorSpecConfigs.ts`; only their renders differ. Notes that
  contain a node type the mobile schema lacks open as a notice instead of an
  editor, so a save can never strip them.
- **Shared code:** `@cortex/*` resolves to `../src/lib/*` (tsconfig paths +
  `metro.config.js` watchFolders). Only dependency-free modules are shared —
  types, `fileTree.ts`, `editorSpecConfigs.ts`, `databaseTypes.ts`.
- **Saving:** `src/lib/noteSaver.ts`. Whole-body saves, debounced, guarded by
  `updated_at` like the web editor. A rejected save asks the user to load the
  latest copy or overwrite it. Returning to the foreground re-fetches the open
  note when this device has nothing unsaved.

## Not built yet

Create / rename / move / delete in the tree, title editing, a formatting bar
above the keyboard, search, and backlink sync for mobile edits.
