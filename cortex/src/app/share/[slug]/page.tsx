import type { Metadata } from "next";
import { SharePageClient } from "./SharePageClient";

/**
 * /share/[slug] — Public read-only view of a shared note.
 * This is a server component that fetches the document data,
 * then renders a client component for interactivity (modals, links).
 */

interface Props {
  params: Promise<{ slug: string }>;
}

// Dynamic metadata (shows note title in the browser tab)
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

  try {
    const res = await fetch(`${baseUrl}/api/share/${slug}`, {
      cache: "no-store",
    });
    if (!res.ok) return { title: "Note not found — Codex" };
    const data = await res.json();
    return {
      title: `${data.title || "Untitled"} — Codex`,
      description: data.subtitle || "A shared note from Codex",
    };
  } catch {
    return { title: "Codex" };
  }
}

export default async function SharePage({ params }: Props) {
  const { slug } = await params;
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

  let data: ShareData | null = null;
  let errorMsg: string | null = null;

  try {
    const res = await fetch(`${baseUrl}/api/share/${slug}`, {
      cache: "no-store",
    });

    if (!res.ok) {
      errorMsg =
        res.status === 404 ? "This note doesn't exist or is no longer shared." : "Something went wrong.";
    } else {
      data = await res.json();
    }
  } catch {
    errorMsg = "Unable to load this note.";
  }

  if (errorMsg || !data) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center space-y-3 px-6">
          <h1 className="text-2xl font-semibold text-gray-900">Note not found</h1>
          <p className="text-gray-500 text-sm max-w-sm">{errorMsg}</p>
        </div>
      </div>
    );
  }

  return <SharePageClient data={data} />;
}

// Keep this here so both server and client can reference the shape
export interface ShareData {
  title: string;
  subtitle: string | null;
  content: string;
  settings: Record<string, unknown>;
  tags: string[];
  updatedAt: string;
  createdAt: string;
  pageLinkMap: Record<string, string | null>;
}
