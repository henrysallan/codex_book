"use client";

import { ThemeSync } from "@/components/ThemeSync";
import "./globals.css";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    // Replaces the root layout, so there is no inline theme script here;
    // ThemeSync applies the saved theme on mount instead.
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background flex items-center justify-center px-6">
        <ThemeSync />
        <div className="text-center space-y-3 max-w-sm">
          <h1 className="text-xl font-semibold text-foreground">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            {error.message || "An unexpected error occurred."}
          </p>
          <button
            type="button"
            onClick={() => reset()}
            className="text-sm px-3 py-1.5 rounded-lg border border-border hover:bg-ink/2"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
