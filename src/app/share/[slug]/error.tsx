"use client";

export default function ShareError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-6">
      <div className="text-center space-y-3 max-w-sm">
        <h1 className="text-xl font-semibold text-gray-900">
          Couldn’t load this note
        </h1>
        <p className="text-sm text-gray-500">
          The shared page hit an error. You can try again, or check that the
          link is still valid.
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
