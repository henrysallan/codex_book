"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white flex items-center justify-center px-6">
        <div className="text-center space-y-3 max-w-sm">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="text-sm text-neutral-500">
            {error.message || "An unexpected error occurred."}
          </p>
          <button
            type="button"
            onClick={() => reset()}
            className="text-sm px-3 py-1.5 rounded-lg border border-neutral-200 hover:bg-neutral-50"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
