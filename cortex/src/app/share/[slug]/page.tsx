import type { Metadata } from "next";
import { getServerSupabase } from "@/lib/supabaseServer";
import { SharePageClient } from "./SharePageClient";

/**
 * /share/[slug] — Public read-only view of a shared note.
 * Queries Supabase directly (server component) then renders a client component.
 */

interface Props {
  params: Promise<{ slug: string }>;
}

/** Fetch the shared doc + pageLink map directly from Supabase */
async function getShareData(slug: string): Promise<ShareData | null> {
  const supabase = getServerSupabase();
  if (!supabase) return null;

  const { data: doc, error } = await supabase
    .from("documents")
    .select("id, title, subtitle, content, settings, updated_at, created_at, tags")
    .eq("share_slug", slug)
    .single();

  if (error || !doc) return null;

  // Find all pageLink references and check which are also shared
  let pageLinkMap: Record<string, string | null> = {};
  const pageLinkDocIds = extractPageLinkDocIds(doc.content);
  if (pageLinkDocIds.length > 0) {
    const { data: linked } = await supabase
      .from("documents")
      .select("id, share_slug")
      .in("id", pageLinkDocIds);

    if (linked) {
      for (const l of linked) {
        pageLinkMap[l.id] = l.share_slug;
      }
    }
  }

  return {
    title: doc.title,
    subtitle: doc.subtitle,
    content: doc.content,
    settings: doc.settings ?? {},
    tags: doc.tags ?? [],
    updatedAt: doc.updated_at,
    createdAt: doc.created_at,
    pageLinkMap,
  };
}

// Dynamic metadata (shows note title in the browser tab)
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const data = await getShareData(slug);
  if (!data) return { title: "Note not found — Codex" };
  return {
    title: `${data.title || "Untitled"} — Codex`,
    description: data.subtitle || "A shared note from Codex",
  };
}

export default async function SharePage({ params }: Props) {
  const { slug } = await params;
  const data = await getShareData(slug);

  if (!data) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center space-y-3 px-6">
          <h1 className="text-2xl font-semibold text-gray-900">Note not found</h1>
          <p className="text-gray-500 text-sm max-w-sm">
            This note doesn&apos;t exist or is no longer shared.
          </p>
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

/** Walk BlockNote JSON to collect all pageLink docIds */
function extractPageLinkDocIds(contentJson: string): string[] {
  try {
    const blocks = JSON.parse(contentJson);
    const ids = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (function walk(nodes: any[]) {
      for (const n of nodes) {
        if (n.type === "pageLink" && n.props?.docId) ids.add(n.props.docId);
        if (Array.isArray(n.content)) walk(n.content);
        if (Array.isArray(n.children)) walk(n.children);
      }
    })(Array.isArray(blocks) ? blocks : []);
    return Array.from(ids);
  } catch {
    return [];
  }
}
