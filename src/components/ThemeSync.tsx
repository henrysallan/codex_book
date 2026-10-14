"use client";

import { useResolvedTheme } from "@/lib/theme";

/**
 * Keeps the `dark` class on <html> in sync with the saved preference, the OS
 * setting, and other tabs — on every route, including ones (login, share page)
 * where nothing else reads the theme. Renders nothing.
 */
export function ThemeSync() {
  useResolvedTheme();
  return null;
}
