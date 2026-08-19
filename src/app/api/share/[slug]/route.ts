import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabaseServer";

/**
 * GET /api/share/[slug]
 * Public endpoint — returns the shared document's content and metadata.
 * Uses the service-role Supabase client so RLS is bypassed.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  if (!slug || slug.length < 4) {
    return NextResponse.json({ error: "Invalid share link" }, { status: 400 });
  }

  const supabase = getServerSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Database not configured" },
      { status: 500 }
    );
  }

  // 1. Fetch the shared document
  const { data: doc, error } = await supabase
    .from("documents")
    .select(
      "id, title, subtitle, content, settings, updated_at, created_at, tags"
    )
    .eq("share_slug", slug)
    .single();

  if (error || !doc) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }

  // 2. Extract all pageLink docIds referenced in the content
  const pageLinkDocIds = extractPageLinkDocIds(doc.content);

  // 3. For each referenced page, check if it also has a share_slug
  let pageLinkMap: Record<string, string | null> = {};
  if (pageLinkDocIds.length > 0) {
    const { data: linked } = await supabase
      .from("documents")
      .select("id, share_slug, title")
      .in("id", pageLinkDocIds);

    if (linked) {
      for (const l of linked) {
        pageLinkMap[l.id] = l.share_slug;
      }
    }
  }

  return NextResponse.json({
    title: doc.title,
    subtitle: doc.subtitle,
    content: doc.content,
    settings: doc.settings,
    tags: doc.tags,
    updatedAt: doc.updated_at,
    createdAt: doc.created_at,
    pageLinkMap,
  });
}

/**
 * Walk the BlockNote JSON to find all pageLink inline content nodes
 * and collect their docId props.
 */
function extractPageLinkDocIds(contentJson: string): string[] {
  try {
    const blocks = JSON.parse(contentJson);
    const ids = new Set<string>();
    walkForPageLinks(blocks, ids);
    return Array.from(ids);
  } catch {
    return [];
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walkForPageLinks(nodes: any[], ids: Set<string>) {
  for (const node of nodes) {
    if (node.type === "pageLink" && node.props?.docId) {
      ids.add(node.props.docId);
    }
    if (Array.isArray(node.content)) {
      walkForPageLinks(node.content, ids);
    }
    if (Array.isArray(node.children)) {
      walkForPageLinks(node.children, ids);
    }
  }
}
