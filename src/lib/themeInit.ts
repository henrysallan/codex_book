// ─── Theme bootstrap (server-safe) ───
//
// Shared by the root layout (which inlines the script below so the right theme
// is on <html> before first paint) and src/lib/theme.ts (the client store that
// keeps it in sync afterwards). Keep this file free of React imports: it is
// read from a server component.

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "cortex:theme";
export const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

/**
 * Runs in <head> before the body renders: reads the saved preference, resolves
 * "system" against the OS setting, and puts `dark` on <html>. Without it a
 * dark-mode user would see a white flash on every load.
 */
export const themeInitScript = `(function(){try{var p=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY
)});var d=p==="dark"||(p!=="light"&&window.matchMedia(${JSON.stringify(
  DARK_MEDIA_QUERY
)}).matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})();`;
