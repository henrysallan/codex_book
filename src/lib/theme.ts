"use client";

import { useSyncExternalStore } from "react";
import {
  DARK_MEDIA_QUERY,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/themeInit";

export type { ResolvedTheme, ThemePreference };

// ─── Theme store ───
//
// A tiny external store rather than a slice of the app store: the preference
// is a per-device setting (localStorage, like the sidebar's), it is needed on
// the public share page where the app store is never initialised, and it has
// to react to the OS setting and to other tabs.
//
// The `dark` class on <html> is the source of truth for styling. The inline
// script in layout.tsx sets it before paint; this module keeps it in sync.

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

const SERVER_STATE: ThemeState = { preference: "system", resolved: "light" };

let state: ThemeState | null = null;
const listeners = new Set<() => void>();
let media: MediaQueryList | null = null;

function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // localStorage unavailable
  }
  return "system";
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.(DARK_MEDIA_QUERY).matches ?? false;
}

function resolve(preference: ThemePreference): ResolvedTheme {
  if (preference === "system") return systemPrefersDark() ? "dark" : "light";
  return preference;
}

function applyToDocument(resolved: ResolvedTheme) {
  const root = document.documentElement;
  const isDark = resolved === "dark";
  if (root.classList.contains("dark") === isDark) return;

  // Without this every `transition-colors` element animates on its own
  // schedule and the switch looks smeared. Disable transitions for one frame.
  const freeze = document.createElement("style");
  freeze.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.appendChild(freeze);
  root.classList.toggle("dark", isDark);
  void window.getComputedStyle(document.body).opacity; // flush styles
  setTimeout(() => freeze.remove(), 1);
}

function setState(next: ThemeState) {
  if (state && state.preference === next.preference && state.resolved === next.resolved) return;
  state = next;
  applyToDocument(next.resolved);
  listeners.forEach((l) => l());
}

function getSnapshot(): ThemeState {
  if (!state) {
    const preference = readPreference();
    state = { preference, resolved: resolve(preference) };
  }
  return state;
}

function getServerSnapshot(): ThemeState {
  return SERVER_STATE;
}

const onSystemChange = () => {
  const current = getSnapshot();
  if (current.preference === "system") setState({ preference: "system", resolved: resolve("system") });
};

const onStorage = (e: StorageEvent) => {
  // Another tab changed the preference (or cleared storage).
  if (e.key !== THEME_STORAGE_KEY && e.key !== null) return;
  const preference = readPreference();
  setState({ preference, resolved: resolve(preference) });
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    media = window.matchMedia?.(DARK_MEDIA_QUERY) ?? null;
    media?.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    // Catch up on first subscribe: the OS setting or another tab may have
    // changed things while nothing was listening, and the inline script may
    // not have run (e.g. global-error, which has no root layout).
    const preference = readPreference();
    setState({ preference, resolved: resolve(preference) });
    applyToDocument(getSnapshot().resolved);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      media?.removeEventListener("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
      media = null;
    }
  };
}

export function setThemePreference(preference: ThemePreference) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // localStorage unavailable — still apply for this session
  }
  setState({ preference, resolved: resolve(preference) });
}

/**
 * Current theme preference and the theme actually in effect. During
 * server render and hydration this reports the light/system default; the
 * real value arrives on the next render (the page itself is already styled
 * correctly by the class the inline script set).
 */
export function useTheme(): ThemeState & { setPreference: (p: ThemePreference) => void } {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { ...current, setPreference: setThemePreference };
}

/** Just the theme in effect — "light" or "dark". */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, () => getSnapshot().resolved, () => SERVER_STATE.resolved);
}
