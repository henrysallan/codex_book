/**
 * AI Tools — Anthropic tool-use definitions and executors.
 * Claude can invoke these mid-conversation to query the knowledge base.
 */

import { getServerSupabase } from "@/lib/supabaseServer";
import { blocksToPlainText } from "./context";
import { embedQuery } from "./retrieve";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Hard cap on any single tool result to prevent token budget blowout.
 * ~4000 chars ≈ ~1000 tokens. Each tool round may invoke multiple tools,
 * and results accumulate across rounds, so keep individual results compact.
 */
const MAX_TOOL_RESULT_CHARS = 8000;

/** Truncate a JSON result string, preserving valid JSON by appending a note. */
function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;
  // Try to preserve useful structure: cut and wrap with a truncation note
  const truncated = result.slice(0, MAX_TOOL_RESULT_CHARS - 120);
  // Find a reasonable cut point (end of a JSON value)
  const lastComma = truncated.lastIndexOf(",");
  const cut = lastComma > MAX_TOOL_RESULT_CHARS * 0.5 ? lastComma : truncated.length;
  return (
    truncated.slice(0, cut) +
    '\n... ],"_truncated":true,"_note":"Result was too large and was truncated. Try a more specific query or use a limit parameter."}'
  );
}

// ─── Tool Definitions (Anthropic format) ───

export const TOOL_DEFINITIONS: Anthropic.Messages.Tool[] = [
  {
    name: "search_notes",
    description:
      "Search the user's notes by keyword or topic. Returns matching documents with titles, folder paths, dates, and AI summaries. Use this as the primary way to find relevant notes.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "The search query — keywords, topic, or phrase to look for in note titles, content, and tags.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 10.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_document_info",
    description:
      "Get metadata about a specific document: title, creation date, last updated, folder path, tags, AI summary, and count of child documents. Use when you need details about a known document.",
    input_schema: {
      type: "object" as const,
      properties: {
        documentId: {
          type: "string",
          description: "The UUID of the document.",
        },
      },
      required: ["documentId"],
    },
  },
  {
    name: "read_document_content",
    description:
      "Read the full text content of a document. Use when you need to examine the actual content of a note, not just its summary. Returns plain text converted from the editor's block format.",
    input_schema: {
      type: "object" as const,
      properties: {
        documentId: {
          type: "string",
          description: "The UUID of the document to read.",
        },
      },
      required: ["documentId"],
    },
  },
  {
    name: "list_folder_contents",
    description:
      "List all documents and subfolders inside a folder. Use to explore the structure of a folder or find documents within it. Can search by folder ID or folder name.",
    input_schema: {
      type: "object" as const,
      properties: {
        folderId: {
          type: "string",
          description:
            "The UUID of the folder. If not provided, use folderName to search by name.",
        },
        folderName: {
          type: "string",
          description:
            "The name of the folder to search for (case-insensitive). Used when folderId is not known.",
        },
        recursive: {
          type: "boolean",
          description:
            "If true, include contents of subfolders recursively. Defaults to false.",
        },
      },
    },
  },
  {
    name: "get_backlinks",
    description:
      "Find documents that link TO a given document (incoming backlinks) and documents that this document links FROM (outgoing links). Uses [[wikilink]] references tracked in the backlinks table.",
    input_schema: {
      type: "object" as const,
      properties: {
        documentId: {
          type: "string",
          description: "The UUID of the document to find backlinks for.",
        },
      },
      required: ["documentId"],
    },
  },
  {
    name: "search_by_date",
    description:
      "Find documents created or updated within a date range. Useful for finding notes from a specific time period.",
    input_schema: {
      type: "object" as const,
      properties: {
        from: {
          type: "string",
          description:
            "Start date (inclusive) in ISO format, e.g. '2024-01-01'.",
        },
        to: {
          type: "string",
          description:
            "End date (inclusive) in ISO format, e.g. '2024-12-31'.",
        },
        sort: {
          type: "string",
          enum: ["newest", "oldest"],
          description: "Sort order. Defaults to 'newest'.",
        },
        limit: {
          type: "number",
          description: "Maximum results. Defaults to 20.",
        },
      },
    },
  },
  {
    name: "get_writing_stats",
    description:
      "Get statistics about the user's note-taking activity: how many notes were created per time period, total counts, and activity patterns.",
    input_schema: {
      type: "object" as const,
      properties: {
        groupBy: {
          type: "string",
          enum: ["day", "week", "month"],
          description: "How to group the statistics. Defaults to 'month'.",
        },
        from: {
          type: "string",
          description: "Start date for the stats range in ISO format.",
        },
        to: {
          type: "string",
          description: "End date for the stats range in ISO format.",
        },
      },
    },
  },
  {
    name: "search_by_tags",
    description:
      "Find documents that have specific AI-generated tags or user tags. Can match any or all of the provided tags.",
    input_schema: {
      type: "object" as const,
      properties: {
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags to search for.",
        },
        matchAll: {
          type: "boolean",
          description:
            "If true, documents must have ALL specified tags. If false (default), documents matching ANY tag are returned.",
        },
        limit: {
          type: "number",
          description: "Maximum results. Defaults to 20.",
        },
      },
      required: ["tags"],
    },
  },
  {
    name: "get_folder_tree",
    description:
      "Get the folder structure of the user's knowledge base. Returns a tree of folders and their document counts. Use to understand how notes are organized.",
    input_schema: {
      type: "object" as const,
      properties: {
        parentId: {
          type: "string",
          description:
            "UUID of a parent folder to get subtree for. If omitted, returns the entire top-level structure.",
        },
      },
    },
  },
  {
    name: "count_documents",
    description:
      "Count documents, optionally filtered by folder, tag, or date range. Use for quick statistics without fetching full document lists.",
    input_schema: {
      type: "object" as const,
      properties: {
        folderId: {
          type: "string",
          description: "Count only documents in this folder.",
        },
        tag: {
          type: "string",
          description: "Count only documents with this AI tag.",
        },
        from: {
          type: "string",
          description:
            "Count only documents created after this date (ISO format).",
        },
        to: {
          type: "string",
          description:
            "Count only documents created before this date (ISO format).",
        },
      },
    },
  },
  {
    name: "get_document_lengths",
    description:
      "Get the word count and character count for documents WITHOUT reading their full content. Accepts a list of document IDs or a folder ID to measure all documents in that folder. Use this instead of read_document_content when you only need to know how long notes are.",
    input_schema: {
      type: "object" as const,
      properties: {
        documentIds: {
          type: "array",
          items: { type: "string" },
          description:
            "UUIDs of the documents to measure. Provide this OR folderId, not both.",
        },
        folderId: {
          type: "string",
          description:
            "UUID of a folder — measures all documents in this folder.",
        },
        folderName: {
          type: "string",
          description:
            "Name of a folder to search for (case-insensitive). Used when folderId is not known.",
        },
        recursive: {
          type: "boolean",
          description:
            "If using folderId/folderName, include documents in subfolders recursively. Defaults to false.",
        },
      },
    },
  },
  {
    name: "get_recent_documents",
    description:
      "Get the most recently created or updated documents. Use when the user asks what they've been working on or what's new.",
    input_schema: {
      type: "object" as const,
      properties: {
        sortBy: {
          type: "string",
          enum: ["created_at", "updated_at"],
          description: "Sort by creation date or last update. Defaults to 'updated_at'.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results. Defaults to 15.",
        },
      },
    },
  },
  {
    name: "get_document_children",
    description:
      "List documents nested directly under a parent document (via parent_document_id). Use to explore document-under-document hierarchy, which is separate from folder hierarchy.",
    input_schema: {
      type: "object" as const,
      properties: {
        parentDocumentId: {
          type: "string",
          description: "The UUID of the parent document.",
        },
      },
      required: ["parentDocumentId"],
    },
  },
  {
    name: "get_all_tags",
    description:
      "Return every unique AI-generated tag across the knowledge base with frequency counts. Use when the user asks what topics they write about, or to understand the tag landscape.",
    input_schema: {
      type: "object" as const,
      properties: {
        minCount: {
          type: "number",
          description: "Only return tags that appear at least this many times. Defaults to 1.",
        },
      },
    },
  },
  {
    name: "batch_get_document_info",
    description:
      "Get metadata (title, folder path, dates, tags, AI summary) for multiple documents at once. More efficient than calling get_document_info repeatedly.",
    input_schema: {
      type: "object" as const,
      properties: {
        documentIds: {
          type: "array",
          items: { type: "string" },
          description: "Array of document UUIDs to look up.",
        },
      },
      required: ["documentIds"],
    },
  },
  {
    name: "get_chunk_summaries",
    description:
      "Get the AI-generated chunk summaries and tags for a document. Much lighter than reading full content — gives the gist of each section without the full text.",
    input_schema: {
      type: "object" as const,
      properties: {
        documentId: {
          type: "string",
          description: "The UUID of the document.",
        },
      },
      required: ["documentId"],
    },
  },
  {
    name: "find_similar_documents",
    description:
      "Find the most semantically similar documents to a given document using vector embedding similarity. Use when the user asks 'what else have I written about this topic?' or wants related notes.",
    input_schema: {
      type: "object" as const,
      properties: {
        documentId: {
          type: "string",
          description: "UUID of the document to find similar ones for.",
        },
        limit: {
          type: "number",
          description: "Maximum results. Defaults to 10.",
        },
        threshold: {
          type: "number",
          description: "Minimum similarity score (0-1). Defaults to 0.5.",
        },
      },
      required: ["documentId"],
    },
  },
  {
    name: "search_document_content",
    description:
      "Full-text search specifically within document body content using PostgreSQL tsvector. Use when you need to find specific phrases or terms within the actual prose of notes, not just titles or tags.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query — will be run as a websearch against document content.",
        },
        limit: {
          type: "number",
          description: "Maximum results. Defaults to 15.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_folder_info",
    description:
      "Get metadata about a specific folder: name, full path, parent folder, document count, subfolder count, and creation date.",
    input_schema: {
      type: "object" as const,
      properties: {
        folderId: {
          type: "string",
          description: "UUID of the folder.",
        },
        folderName: {
          type: "string",
          description: "Name of the folder (case-insensitive search). Used when folderId is not known.",
        },
      },
    },
  },
  {
    name: "get_orphan_documents",
    description:
      "Find documents with no folder, no parent document, and no incoming backlinks — i.e. notes that are floating around unorganized.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Maximum results. Defaults to 20.",
        },
      },
    },
  },
  {
    name: "get_annotations",
    description:
      "List annotations (highlighted text + chat threads) on a document. Also searches PDF annotations if a drive_file_id is associated.",
    input_schema: {
      type: "object" as const,
      properties: {
        documentId: {
          type: "string",
          description: "UUID of the document to get annotations for.",
        },
      },
      required: ["documentId"],
    },
  },
  {
    name: "get_daily_note",
    description:
      "Fetch the document for a specific date by matching common daily note title patterns (e.g. '2025-03-14', 'March 14, 2025', 'Mar 14 2025'). Use when the user asks 'what did I write on Tuesday?' or similar.",
    input_schema: {
      type: "object" as const,
      properties: {
        date: {
          type: "string",
          description: "The date to look for, in ISO format (YYYY-MM-DD).",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "get_tag_graph",
    description:
      "Return which AI tags co-occur on the same documents, with frequency. Reveals topic relationships and clusters without reading any content.",
    input_schema: {
      type: "object" as const,
      properties: {
        minCooccurrence: {
          type: "number",
          description: "Only return tag pairs that co-occur at least this many times. Defaults to 2.",
        },
      },
    },
  },
  {
    name: "get_document_hierarchy",
    description:
      "Given a document, return its full ancestry (parent doc → parent's parent → … → root folder path) and all descendants (child documents, their children, etc). Gives the full tree position in one call.",
    input_schema: {
      type: "object" as const,
      properties: {
        documentId: {
          type: "string",
          description: "UUID of the document to get hierarchy for.",
        },
      },
      required: ["documentId"],
    },
  },
  {
    name: "compare_documents",
    description:
      "Compare 2 or more documents side by side: dates, word counts, tags, AI summaries. Use when the user asks how notes differ or wants a comparison without reading full content.",
    input_schema: {
      type: "object" as const,
      properties: {
        documentIds: {
          type: "array",
          items: { type: "string" },
          description: "Array of 2+ document UUIDs to compare.",
        },
      },
      required: ["documentIds"],
    },
  },
  {
    name: "get_recently_modified",
    description:
      "Get documents sorted by last modification date (updated_at). Distinct from get_recent_documents which can sort by created_at — this always focuses on what was most recently edited.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Maximum results. Defaults to 15.",
        },
        from: {
          type: "string",
          description: "Only include documents modified after this date (ISO format).",
        },
      },
    },
  },
];

// ─── Helpers ───

/**
 * Fetch all folders once and return a function that resolves folder IDs to
 * human-readable paths like "School Notes > Classes > Ethics".
 */
async function createFolderPathResolver(): Promise<
  (folderId: string | null) => string
> {
  const supabase = getServerSupabase();
  if (!supabase) return () => "/";

  const { data: folders } = await supabase
    .from("folders")
    .select("id, name, parent_id");
  if (!folders) return () => "/";

  const folderMap = new Map(
    (folders as { id: string; name: string; parent_id: string | null }[]).map(
      (f) => [f.id, f]
    )
  );
  const cache = new Map<string, string>();

  return function resolve(folderId: string | null): string {
    if (!folderId) return "/";
    if (cache.has(folderId)) return cache.get(folderId)!;

    const folder = folderMap.get(folderId);
    if (!folder) return "/";
    const parentPath = folder.parent_id ? resolve(folder.parent_id) : "";
    const path = parentPath ? `${parentPath} > ${folder.name}` : folder.name;
    cache.set(folderId, path);
    return path;
  };
}

// ─── Tool Executors ───

async function searchNotes(input: {
  query: string;
  limit?: number;
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  const limit = input.limit ?? 10;
  const keywords = input.query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  // Run full-text search + title ilike in parallel
  const [ftsRes, titleRes] = await Promise.all([
    supabase
      .rpc("search_documents", { search_query: input.query })
      .then((r) => r.data ?? []),
    keywords.length > 0
      ? supabase
          .from("documents")
          .select(
            "id, title, folder_id, tags, ai_summary, ai_tags, created_at, updated_at"
          )
          .or(keywords.map((k) => `title.ilike.%${k}%`).join(","))
          .limit(limit)
          .then((r) => r.data ?? [])
      : Promise.resolve([]),
  ]);

  const resolve = await createFolderPathResolver();

  // Merge & deduplicate (title matches first for higher relevance)
  const seen = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: any[] = [];

  for (const doc of [...titleRes, ...ftsRes]) {
    if (seen.has(doc.id) || results.length >= limit) continue;
    seen.add(doc.id);
    results.push({
      id: doc.id,
      title: doc.title,
      folderPath: resolve(doc.folder_id),
      createdAt: doc.created_at,
      updatedAt: doc.updated_at,
      tags: doc.ai_tags ?? doc.tags ?? [],
      summary: doc.ai_summary ?? null,
    });
  }

  return JSON.stringify({ count: results.length, results });
}

async function getDocumentInfo(input: {
  documentId: string;
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  const { data: doc, error } = await supabase
    .from("documents")
    .select(
      "id, title, subtitle, folder_id, tags, ai_summary, ai_tags, created_at, updated_at, parent_document_id"
    )
    .eq("id", input.documentId)
    .single();

  if (error || !doc) return JSON.stringify({ error: "Document not found" });

  // Count children in parallel
  const [childDocRes, childFolderRes, resolve] = await Promise.all([
    supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("parent_document_id", input.documentId),
    supabase
      .from("folders")
      .select("id", { count: "exact", head: true })
      .eq("parent_document_id", input.documentId),
    createFolderPathResolver(),
  ]);

  return JSON.stringify({
    id: doc.id,
    title: doc.title,
    subtitle: doc.subtitle,
    folderPath: resolve(doc.folder_id),
    tags: doc.tags ?? [],
    aiTags: doc.ai_tags ?? [],
    aiSummary: doc.ai_summary,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
    childDocuments: childDocRes.count ?? 0,
    childFolders: childFolderRes.count ?? 0,
    parentDocumentId: doc.parent_document_id,
  });
}

async function readDocumentContent(input: {
  documentId: string;
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  const { data: doc, error } = await supabase
    .from("documents")
    .select("id, title, content")
    .eq("id", input.documentId)
    .single();

  if (error || !doc) return JSON.stringify({ error: "Document not found" });

  const plainText = blocksToPlainText(doc.content);
  const trimmed = plainText.slice(0, 20_000);

  return JSON.stringify({
    id: doc.id,
    title: doc.title,
    content: trimmed,
    truncated: plainText.length > 20_000,
  });
}

async function listFolderContents(input: {
  folderId?: string;
  folderName?: string;
  recursive?: boolean;
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  let folderId = input.folderId;

  // Resolve folder by name if no ID provided
  if (!folderId && input.folderName) {
    const { data: folders } = await supabase
      .from("folders")
      .select("id, name")
      .ilike("name", `%${input.folderName}%`)
      .limit(5);

    if (!folders || folders.length === 0) {
      return JSON.stringify({
        error: `No folder found matching "${input.folderName}"`,
      });
    }
    if (folders.length === 1) {
      folderId = folders[0].id;
    } else {
      return JSON.stringify({
        error: "Multiple folders match that name. Please be more specific.",
        matches: (folders as { id: string; name: string }[]).map((f) => ({
          id: f.id,
          name: f.name,
        })),
      });
    }
  }

  if (!folderId) {
    return JSON.stringify({
      error: "Either folderId or folderName is required",
    });
  }

  // Get folder info, documents, and subfolders in parallel
  const [folderRes, docsRes, subfoldersRes] = await Promise.all([
    supabase
      .from("folders")
      .select("id, name")
      .eq("id", folderId)
      .single(),
    supabase
      .from("documents")
      .select("id, title, created_at, updated_at, ai_tags")
      .eq("folder_id", folderId)
      .order("position"),
    supabase
      .from("folders")
      .select("id, name")
      .eq("parent_id", folderId)
      .order("position"),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = {
    folder: folderRes.data
      ? { id: folderRes.data.id, name: folderRes.data.name }
      : null,
    documents: ((docsRes.data ?? []) as {
      id: string;
      title: string;
      created_at: string;
      updated_at: string;
      ai_tags: string[];
    }[]).map((d) => ({
      id: d.id,
      title: d.title,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
      tags: d.ai_tags ?? [],
    })),
    subfolders: ((subfoldersRes.data ?? []) as { id: string; name: string }[]).map(
      (f) => ({ id: f.id, name: f.name })
    ),
  };

  // Recursive expansion — collect flat list with folder paths instead of nesting
  if (input.recursive && result.subfolders.length > 0) {
    const resolve = await createFolderPathResolver();
    const allDocs: { id: string; title: string; folderPath: string; createdAt: string }[] = [];
    const queue = [...result.subfolders.map((sf: { id: string }) => sf.id)];
    const visited = new Set<string>([folderId]);
    while (queue.length > 0) {
      const sfId = queue.shift()!;
      if (visited.has(sfId)) continue;
      visited.add(sfId);
      const [subDocs, subFolders] = await Promise.all([
        supabase.from("documents")
          .select("id, title, folder_id, created_at")
          .eq("folder_id", sfId)
          .order("position")
          .then(r => r.data ?? []),
        supabase.from("folders")
          .select("id")
          .eq("parent_id", sfId)
          .then(r => r.data ?? []),
      ]);
      for (const d of subDocs as { id: string; title: string; folder_id: string; created_at: string }[]) {
        allDocs.push({ id: d.id, title: d.title, folderPath: resolve(d.folder_id), createdAt: d.created_at });
      }
      for (const f of subFolders as { id: string }[]) {
        queue.push(f.id);
      }
    }
    result.recursiveDocuments = allDocs.slice(0, 50);
    result.totalRecursiveDocCount = allDocs.length;
    if (allDocs.length > 50) {
      result._note = `Showing first 50 of ${allDocs.length} recursive documents. Use get_document_lengths or search_notes for details.`;
    }
  }

  return JSON.stringify(result);
}

async function getBacklinks(input: { documentId: string }): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  // Fetch incoming and outgoing backlinks in parallel
  const [inRes, outRes] = await Promise.all([
    supabase
      .from("backlinks")
      .select("source_document_id")
      .eq("target_document_id", input.documentId),
    supabase
      .from("backlinks")
      .select("target_document_id")
      .eq("source_document_id", input.documentId),
  ]);

  // Collect all doc IDs and fetch titles
  const allIds = [
    ...((inRes.data ?? []) as { source_document_id: string }[]).map(
      (b) => b.source_document_id
    ),
    ...((outRes.data ?? []) as { target_document_id: string }[]).map(
      (b) => b.target_document_id
    ),
  ];

  let titleMap = new Map<string, string>();
  if (allIds.length > 0) {
    const { data: docs } = await supabase
      .from("documents")
      .select("id, title")
      .in("id", allIds);
    if (docs) {
      titleMap = new Map(
        (docs as { id: string; title: string }[]).map((d) => [d.id, d.title])
      );
    }
  }

  return JSON.stringify({
    incoming: ((inRes.data ?? []) as { source_document_id: string }[]).map(
      (b) => ({
        documentId: b.source_document_id,
        title: titleMap.get(b.source_document_id) ?? "Unknown",
      })
    ),
    outgoing: ((outRes.data ?? []) as { target_document_id: string }[]).map(
      (b) => ({
        documentId: b.target_document_id,
        title: titleMap.get(b.target_document_id) ?? "Unknown",
      })
    ),
  });
}

async function searchByDate(input: {
  from?: string;
  to?: string;
  sort?: string;
  limit?: number;
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  const limit = input.limit ?? 20;
  const ascending = input.sort === "oldest";

  let query = supabase
    .from("documents")
    .select("id, title, folder_id, created_at, updated_at, ai_tags")
    .order("created_at", { ascending });

  if (input.from) query = query.gte("created_at", input.from);
  if (input.to) query = query.lte("created_at", input.to + "T23:59:59Z");
  query = query.limit(limit);

  const { data, error } = await query;
  if (error) return JSON.stringify({ error: error.message });

  const resolve = await createFolderPathResolver();

  const results = ((data ?? []) as {
    id: string;
    title: string;
    folder_id: string | null;
    created_at: string;
    updated_at: string;
    ai_tags: string[];
  }[]).map((d) => ({
    id: d.id,
    title: d.title,
    folderPath: resolve(d.folder_id),
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    tags: d.ai_tags ?? [],
  }));

  return JSON.stringify({ count: results.length, results });
}

async function getWritingStats(input: {
  groupBy?: string;
  from?: string;
  to?: string;
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  let query = supabase.from("documents").select("created_at");
  if (input.from) query = query.gte("created_at", input.from);
  if (input.to) query = query.lte("created_at", input.to + "T23:59:59Z");

  const { data, error } = await query;
  if (error) return JSON.stringify({ error: error.message });
  if (!data) return JSON.stringify({ totalDocuments: 0, periods: [] });

  const groupBy = input.groupBy ?? "month";

  const groups = new Map<string, number>();
  for (const doc of data as { created_at: string }[]) {
    const date = new Date(doc.created_at);
    let key: string;
    if (groupBy === "day") {
      key = date.toISOString().slice(0, 10);
    } else if (groupBy === "week") {
      const monday = new Date(date);
      monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
      key = `week of ${monday.toISOString().slice(0, 10)}`;
    } else {
      key = date.toISOString().slice(0, 7); // YYYY-MM
    }
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }

  const periods = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, count]) => ({ period, count }));

  return JSON.stringify({ totalDocuments: data.length, groupBy, periods });
}

async function searchByTags(input: {
  tags: string[];
  matchAll?: boolean;
  limit?: number;
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  const limit = input.limit ?? 20;
  let query = supabase
    .from("documents")
    .select("id, title, folder_id, ai_tags, ai_summary, created_at")
    .limit(limit);

  if (input.matchAll) {
    query = query.contains("ai_tags", input.tags);
  } else {
    query = query.overlaps("ai_tags", input.tags);
  }

  const { data, error } = await query;
  if (error) return JSON.stringify({ error: error.message });

  const resolve = await createFolderPathResolver();

  const results = ((data ?? []) as {
    id: string;
    title: string;
    folder_id: string | null;
    ai_tags: string[];
    ai_summary: string | null;
    created_at: string;
  }[]).map((d) => ({
    id: d.id,
    title: d.title,
    folderPath: resolve(d.folder_id),
    tags: d.ai_tags ?? [],
    summary: d.ai_summary,
    createdAt: d.created_at,
  }));

  return JSON.stringify({ count: results.length, results });
}

async function getFolderTree(input: { parentId?: string }): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  const [foldersRes, docsRes] = await Promise.all([
    supabase
      .from("folders")
      .select("id, name, parent_id, parent_document_id")
      .order("position"),
    supabase.from("documents").select("folder_id"),
  ]);

  if (!foldersRes.data)
    return JSON.stringify({ error: "Failed to fetch folders" });

  const folders = foldersRes.data as {
    id: string;
    name: string;
    parent_id: string | null;
    parent_document_id: string | null;
  }[];

  // Count docs per folder
  const docCounts = new Map<string, number>();
  for (const doc of (docsRes.data ?? []) as { folder_id: string | null }[]) {
    if (doc.folder_id) {
      docCounts.set(doc.folder_id, (docCounts.get(doc.folder_id) ?? 0) + 1);
    }
  }

  type FolderNode = {
    id: string;
    name: string;
    documentCount: number;
    children: FolderNode[];
  };

  function buildChildren(parentId: string | null): FolderNode[] {
    return folders
      .filter((f) => f.parent_id === parentId && !f.parent_document_id)
      .map((f) => ({
        id: f.id,
        name: f.name,
        documentCount: docCounts.get(f.id) ?? 0,
        children: buildChildren(f.id),
      }));
  }

  const tree = input.parentId
    ? buildChildren(input.parentId)
    : buildChildren(null);

  return JSON.stringify({ tree });
}

async function countDocuments(input: {
  folderId?: string;
  tag?: string;
  from?: string;
  to?: string;
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  let query = supabase
    .from("documents")
    .select("id", { count: "exact", head: true });

  if (input.folderId) query = query.eq("folder_id", input.folderId);
  if (input.tag) query = query.contains("ai_tags", [input.tag]);
  if (input.from) query = query.gte("created_at", input.from);
  if (input.to) query = query.lte("created_at", input.to + "T23:59:59Z");

  const { count, error } = await query;
  if (error) return JSON.stringify({ error: error.message });

  return JSON.stringify({
    count: count ?? 0,
    filters: {
      folderId: input.folderId ?? null,
      tag: input.tag ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
    },
  });
}

async function getDocumentLengths(input: {
  documentIds?: string[];
  folderId?: string;
  folderName?: string;
  recursive?: boolean;
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  let docIds: string[] | null = input.documentIds ?? null;

  // Resolve folder by name if needed
  let folderId = input.folderId;
  if (!docIds && !folderId && input.folderName) {
    const { data: folders } = await supabase
      .from("folders")
      .select("id, name")
      .ilike("name", `%${input.folderName}%`)
      .limit(5);
    if (!folders || folders.length === 0)
      return JSON.stringify({ error: `No folder found matching "${input.folderName}"` });
    if (folders.length > 1)
      return JSON.stringify({
        error: "Multiple folders match. Please be more specific.",
        matches: (folders as { id: string; name: string }[]).map(f => ({ id: f.id, name: f.name })),
      });
    folderId = folders[0].id;
  }

  // Collect folder IDs (recursive if requested)
  if (!docIds && folderId) {
    const folderIds = [folderId];
    if (input.recursive) {
      const { data: allFolders } = await supabase
        .from("folders")
        .select("id, parent_id");
      if (allFolders) {
        const childMap = new Map<string, string[]>();
        for (const f of allFolders as { id: string; parent_id: string | null }[]) {
          if (f.parent_id) {
            const arr = childMap.get(f.parent_id) ?? [];
            arr.push(f.id);
            childMap.set(f.parent_id, arr);
          }
        }
        const queue = [folderId];
        while (queue.length > 0) {
          const current = queue.shift()!;
          const children = childMap.get(current) ?? [];
          for (const c of children) {
            if (!folderIds.includes(c)) {
              folderIds.push(c);
              queue.push(c);
            }
          }
        }
      }
    }
    // Fetch doc IDs from those folders
    const { data: docs } = await supabase
      .from("documents")
      .select("id")
      .in("folder_id", folderIds);
    docIds = ((docs ?? []) as { id: string }[]).map(d => d.id);
  }

  if (!docIds || docIds.length === 0)
    return JSON.stringify({ error: "No documents found. Provide documentIds, folderId, or folderName." });

  // Fetch content for all docs — only select id, title, content
  const { data: docs, error } = await supabase
    .from("documents")
    .select("id, title, content, folder_id")
    .in("id", docIds);

  if (error) return JSON.stringify({ error: error.message });
  if (!docs || docs.length === 0) return JSON.stringify({ error: "No documents found" });

  const resolve = await createFolderPathResolver();

  let totalWords = 0;
  let totalChars = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results = (docs as { id: string; title: string; content: any; folder_id: string | null }[]).map(d => {
    const text = blocksToPlainText(d.content);
    const chars = text.length;
    const words = text.split(/\s+/).filter(w => w.length > 0).length;
    totalWords += words;
    totalChars += chars;
    return {
      id: d.id,
      title: d.title,
      folderPath: resolve(d.folder_id),
      wordCount: words,
      characterCount: chars,
    };
  });

  // Sort longest first
  results.sort((a, b) => b.wordCount - a.wordCount);

  const MAX_ITEMS = 30;
  const shown = results.slice(0, MAX_ITEMS);

  return JSON.stringify({
    documentCount: results.length,
    totalWords,
    totalCharacters: totalChars,
    showing: shown.length,
    documents: shown,
    ...(results.length > MAX_ITEMS
      ? { _note: `Showing top ${MAX_ITEMS} of ${results.length} documents by word count. Use a more specific folder or documentIds for the rest.` }
      : {}),
  });
}

// ─── New Executor Functions (Batch 2) ───

async function getRecentDocuments(input: {
  sortBy?: string;
  limit?: number;
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  const sortField = input.sortBy === "created_at" ? "created_at" : "updated_at";
  const limit = input.limit ?? 15;

  const { data, error } = await supabase
    .from("documents")
    .select("id, title, folder_id, ai_tags, ai_summary, created_at, updated_at")
    .order(sortField, { ascending: false })
    .limit(limit);

  if (error) return JSON.stringify({ error: error.message });

  const resolve = await createFolderPathResolver();

  const results = ((data ?? []) as {
    id: string; title: string; folder_id: string | null;
    ai_tags: string[]; ai_summary: string | null;
    created_at: string; updated_at: string;
  }[]).map(d => ({
    id: d.id,
    title: d.title,
    folderPath: resolve(d.folder_id),
    tags: d.ai_tags ?? [],
    summary: d.ai_summary,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  }));

  return JSON.stringify({ count: results.length, sortedBy: sortField, results });
}

async function getDocumentChildren(input: {
  parentDocumentId: string;
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  // Get child documents + child folders (folders can also nest under docs)
  const [childDocs, childFolders, parentDoc] = await Promise.all([
    supabase
      .from("documents")
      .select("id, title, ai_tags, ai_summary, created_at, updated_at")
      .eq("parent_document_id", input.parentDocumentId)
      .order("position"),
    supabase
      .from("folders")
      .select("id, name")
      .eq("parent_document_id", input.parentDocumentId)
      .order("position"),
    supabase
      .from("documents")
      .select("id, title")
      .eq("id", input.parentDocumentId)
      .single(),
  ]);

  return JSON.stringify({
    parent: parentDoc.data ? { id: parentDoc.data.id, title: parentDoc.data.title } : null,
    childDocuments: ((childDocs.data ?? []) as {
      id: string; title: string; ai_tags: string[];
      ai_summary: string | null; created_at: string; updated_at: string;
    }[]).map(d => ({
      id: d.id,
      title: d.title,
      tags: d.ai_tags ?? [],
      summary: d.ai_summary,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    })),
    childFolders: ((childFolders.data ?? []) as { id: string; name: string }[]).map(f => ({
      id: f.id,
      name: f.name,
    })),
  });
}

async function getAllTags(input: { minCount?: number }): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  const { data, error } = await supabase
    .from("documents")
    .select("ai_tags");

  if (error) return JSON.stringify({ error: error.message });
  if (!data) return JSON.stringify({ tags: [] });

  const counts = new Map<string, number>();
  for (const doc of data as { ai_tags: string[] | null }[]) {
    for (const tag of doc.ai_tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  const minCount = input.minCount ?? 1;
  const tags = [...counts.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));

  return JSON.stringify({ uniqueTagCount: tags.length, tags });
}

async function batchGetDocumentInfo(input: {
  documentIds: string[];
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  const { data, error } = await supabase
    .from("documents")
    .select("id, title, subtitle, folder_id, tags, ai_summary, ai_tags, created_at, updated_at, parent_document_id")
    .in("id", input.documentIds);

  if (error) return JSON.stringify({ error: error.message });
  if (!data) return JSON.stringify({ documents: [] });

  const resolve = await createFolderPathResolver();

  const documents = (data as {
    id: string; title: string; subtitle: string | null;
    folder_id: string | null; tags: string[]; ai_summary: string | null;
    ai_tags: string[]; created_at: string; updated_at: string;
    parent_document_id: string | null;
  }[]).map(d => ({
    id: d.id,
    title: d.title,
    subtitle: d.subtitle,
    folderPath: resolve(d.folder_id),
    tags: d.tags ?? [],
    aiTags: d.ai_tags ?? [],
    aiSummary: d.ai_summary,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    parentDocumentId: d.parent_document_id,
  }));

  return JSON.stringify({ count: documents.length, documents });
}

async function getChunkSummaries(input: {
  documentId: string;
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  const [docRes, chunksRes] = await Promise.all([
    supabase.from("documents").select("id, title").eq("id", input.documentId).single(),
    supabase
      .from("document_chunks")
      .select("chunk_index, heading, summary, tags, token_count")
      .eq("document_id", input.documentId)
      .order("chunk_index"),
  ]);

  if (!docRes.data) return JSON.stringify({ error: "Document not found" });

  const chunks = ((chunksRes.data ?? []) as {
    chunk_index: number; heading: string | null;
    summary: string | null; tags: string[]; token_count: number;
  }[]).map(c => ({
    chunkIndex: c.chunk_index,
    heading: c.heading,
    summary: c.summary,
    tags: c.tags ?? [],
    tokenCount: c.token_count,
  }));

  return JSON.stringify({
    document: { id: docRes.data.id, title: docRes.data.title },
    chunkCount: chunks.length,
    totalTokens: chunks.reduce((sum, c) => sum + c.tokenCount, 0),
    chunks,
  });
}

async function findSimilarDocuments(input: {
  documentId: string;
  limit?: number;
  threshold?: number;
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  // Get source document's embedding
  const { data: doc } = await supabase
    .from("documents")
    .select("id, title, embedding")
    .eq("id", input.documentId)
    .single();

  if (!doc) return JSON.stringify({ error: "Document not found" });
  if (!doc.embedding) return JSON.stringify({ error: "Document has no embedding — it may not be indexed yet" });

  const limit = input.limit ?? 10;
  const threshold = input.threshold ?? 0.5;

  // Use match_documents RPC with the doc's own embedding
  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: doc.embedding,
    match_threshold: threshold,
    match_count: limit + 1, // +1 to exclude self
  });

  if (error) return JSON.stringify({ error: error.message });

  const resolve = await createFolderPathResolver();

  // Fetch folder_ids for the matched docs
  const matchedIds = ((data ?? []) as { id: string }[])
    .filter(d => d.id !== input.documentId)
    .map(d => d.id)
    .slice(0, limit);

  if (matchedIds.length === 0) return JSON.stringify({ results: [] });

  const { data: fullDocs } = await supabase
    .from("documents")
    .select("id, title, folder_id, ai_tags, ai_summary, created_at")
    .in("id", matchedIds);

  const simMap = new Map(
    ((data ?? []) as { id: string; similarity: number }[]).map(d => [d.id, d.similarity])
  );

  const results = ((fullDocs ?? []) as {
    id: string; title: string; folder_id: string | null;
    ai_tags: string[]; ai_summary: string | null; created_at: string;
  }[]).map(d => ({
    id: d.id,
    title: d.title,
    folderPath: resolve(d.folder_id),
    similarity: simMap.get(d.id) ?? 0,
    tags: d.ai_tags ?? [],
    summary: d.ai_summary,
    createdAt: d.created_at,
  })).sort((a, b) => b.similarity - a.similarity);

  return JSON.stringify({ sourceDocument: doc.title, count: results.length, results });
}

async function searchDocumentContent(input: {
  query: string;
  limit?: number;
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  const limit = input.limit ?? 15;

  const { data, error } = await supabase.rpc("search_documents", {
    search_query: input.query,
  });

  if (error) return JSON.stringify({ error: error.message });

  const resolve = await createFolderPathResolver();

  const results = ((data ?? []) as {
    id: string; title: string; folder_id: string;
    rank: number; created_at: string; updated_at: string;
  }[]).slice(0, limit).map(d => ({
    id: d.id,
    title: d.title,
    folderPath: resolve(d.folder_id),
    relevanceRank: d.rank,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  }));

  return JSON.stringify({ count: results.length, results });
}

async function getFolderInfo(input: {
  folderId?: string;
  folderName?: string;
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  let folderId = input.folderId;

  if (!folderId && input.folderName) {
    const { data: folders } = await supabase
      .from("folders")
      .select("id, name")
      .ilike("name", `%${input.folderName}%`)
      .limit(5);
    if (!folders || folders.length === 0)
      return JSON.stringify({ error: `No folder found matching "${input.folderName}"` });
    if (folders.length > 1)
      return JSON.stringify({
        error: "Multiple folders match. Please be more specific.",
        matches: (folders as { id: string; name: string }[]).map(f => ({ id: f.id, name: f.name })),
      });
    folderId = folders[0].id;
  }

  if (!folderId) return JSON.stringify({ error: "Either folderId or folderName is required" });

  const [folderRes, docCountRes, subfolderCountRes, resolve] = await Promise.all([
    supabase.from("folders").select("id, name, parent_id, created_at").eq("id", folderId).single(),
    supabase.from("documents").select("id", { count: "exact", head: true }).eq("folder_id", folderId),
    supabase.from("folders").select("id", { count: "exact", head: true }).eq("parent_id", folderId),
    createFolderPathResolver(),
  ]);

  if (!folderRes.data) return JSON.stringify({ error: "Folder not found" });

  return JSON.stringify({
    id: folderRes.data.id,
    name: folderRes.data.name,
    fullPath: resolve(folderRes.data.id),
    parentPath: folderRes.data.parent_id ? resolve(folderRes.data.parent_id) : null,
    documentCount: docCountRes.count ?? 0,
    subfolderCount: subfolderCountRes.count ?? 0,
    createdAt: folderRes.data.created_at,
  });
}

async function getOrphanDocuments(input: { limit?: number }): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  const limit = input.limit ?? 20;

  // Get docs with no folder and no parent document
  const { data: docs, error } = await supabase
    .from("documents")
    .select("id, title, ai_tags, ai_summary, created_at, updated_at")
    .is("folder_id", null)
    .is("parent_document_id", null)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) return JSON.stringify({ error: error.message });
  if (!docs || docs.length === 0) return JSON.stringify({ count: 0, documents: [] });

  // Check which of these also have no incoming backlinks
  const docIds = (docs as { id: string }[]).map(d => d.id);
  const { data: backlinked } = await supabase
    .from("backlinks")
    .select("target_document_id")
    .in("target_document_id", docIds);

  const backlinkSet = new Set(
    ((backlinked ?? []) as { target_document_id: string }[]).map(b => b.target_document_id)
  );

  const results = (docs as {
    id: string; title: string; ai_tags: string[];
    ai_summary: string | null; created_at: string; updated_at: string;
  }[]).map(d => ({
    id: d.id,
    title: d.title,
    tags: d.ai_tags ?? [],
    summary: d.ai_summary,
    hasIncomingBacklinks: backlinkSet.has(d.id),
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  }));

  // True orphans (no folder, no parent, no backlinks) first
  const trueOrphans = results.filter(r => !r.hasIncomingBacklinks);
  const withBacklinks = results.filter(r => r.hasIncomingBacklinks);

  return JSON.stringify({
    trueOrphanCount: trueOrphans.length,
    totalUnfiled: results.length,
    documents: [...trueOrphans, ...withBacklinks],
  });
}

async function getAnnotations(input: { documentId: string }): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  // Fetch document annotations and check for linked PDF
  const [annotRes, attachmentRes] = await Promise.all([
    supabase
      .from("annotations")
      .select("id, block_id, highlighted_text, summary, created_at, updated_at")
      .eq("document_id", input.documentId)
      .order("created_at"),
    supabase
      .from("attachments")
      .select("drive_file_id")
      .eq("document_id", input.documentId)
      .limit(1),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = {
    documentAnnotations: ((annotRes.data ?? []) as {
      id: string; block_id: string | null; highlighted_text: string;
      summary: string | null; created_at: string; updated_at: string;
    }[]).map(a => ({
      id: a.id,
      blockId: a.block_id,
      highlightedText: a.highlighted_text,
      summary: a.summary,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
    })),
  };

  // If there's a linked PDF, also fetch PDF annotations
  const driveFileId = (attachmentRes.data as { drive_file_id: string }[] | null)?.[0]?.drive_file_id;
  if (driveFileId) {
    const { data: pdfAnnots } = await supabase
      .from("pdf_annotations")
      .select("id, color, type, page_number, anchor_exact, note, created_at")
      .eq("drive_file_id", driveFileId)
      .order("page_number")
      .order("created_at");

    result.pdfAnnotations = ((pdfAnnots ?? []) as {
      id: string; color: string; type: string; page_number: number;
      anchor_exact: string; note: string | null; created_at: string;
    }[]).map(a => ({
      id: a.id,
      color: a.color,
      type: a.type,
      pageNumber: a.page_number,
      highlightedText: a.anchor_exact,
      note: a.note,
      createdAt: a.created_at,
    }));
  }

  return JSON.stringify(result);
}

async function getDailyNote(input: { date: string }): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  const d = new Date(input.date + "T00:00:00Z");
  if (isNaN(d.getTime())) return JSON.stringify({ error: "Invalid date format" });

  const iso = input.date; // YYYY-MM-DD
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const monthShort = months[d.getUTCMonth()].slice(0, 3);
  const monthLong = months[d.getUTCMonth()];
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();

  // Try several common daily note title patterns
  const patterns = [
    iso,                                      // 2025-03-14
    `${monthLong} ${day}, ${year}`,           // March 14, 2025
    `${monthShort} ${day}, ${year}`,          // Mar 14, 2025
    `${monthShort} ${day} ${year}`,           // Mar 14 2025
    `${d.getUTCMonth() + 1}/${day}/${year}`,  // 3/14/2025
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`, // 03/14/2025
  ];

  const orFilter = patterns.map(p => `title.eq.${p}`).join(",");
  const { data: exact } = await supabase
    .from("documents")
    .select("id, title, folder_id, ai_summary, ai_tags, created_at, updated_at")
    .or(orFilter)
    .limit(5);

  if (exact && exact.length > 0) {
    const resolve = await createFolderPathResolver();
    return JSON.stringify({
      found: true,
      documents: (exact as {
        id: string; title: string; folder_id: string | null;
        ai_summary: string | null; ai_tags: string[]; created_at: string; updated_at: string;
      }[]).map(dd => ({
        id: dd.id,
        title: dd.title,
        folderPath: resolve(dd.folder_id),
        summary: dd.ai_summary,
        tags: dd.ai_tags ?? [],
        createdAt: dd.created_at,
        updatedAt: dd.updated_at,
      })),
    });
  }

  // Fallback: look for docs created on that date
  const { data: byDate } = await supabase
    .from("documents")
    .select("id, title, folder_id, ai_summary, created_at")
    .gte("created_at", iso + "T00:00:00Z")
    .lte("created_at", iso + "T23:59:59Z")
    .order("created_at")
    .limit(10);

  if (byDate && byDate.length > 0) {
    const resolve = await createFolderPathResolver();
    return JSON.stringify({
      found: false,
      message: `No note titled "${iso}" but ${byDate.length} document(s) were created that day:`,
      documents: (byDate as {
        id: string; title: string; folder_id: string | null;
        ai_summary: string | null; created_at: string;
      }[]).map(dd => ({
        id: dd.id,
        title: dd.title,
        folderPath: resolve(dd.folder_id),
        summary: dd.ai_summary,
        createdAt: dd.created_at,
      })),
    });
  }

  return JSON.stringify({ found: false, message: `No notes found for ${iso}` });
}

async function getTagGraph(input: { minCooccurrence?: number }): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  const { data, error } = await supabase
    .from("documents")
    .select("ai_tags");

  if (error) return JSON.stringify({ error: error.message });
  if (!data) return JSON.stringify({ edges: [] });

  const minCo = input.minCooccurrence ?? 2;
  const pairCounts = new Map<string, number>();

  for (const doc of data as { ai_tags: string[] | null }[]) {
    const tags = doc.ai_tags ?? [];
    // Generate all pairs
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        const pair = [tags[i], tags[j]].sort().join("|||");
        pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
      }
    }
  }

  const edges = [...pairCounts.entries()]
    .filter(([, count]) => count >= minCo)
    .sort((a, b) => b[1] - a[1])
    .map(([pair, count]) => {
      const [tag1, tag2] = pair.split("|||");
      return { tag1, tag2, cooccurrences: count };
    });

  return JSON.stringify({ edgeCount: edges.length, edges });
}

async function getDocumentHierarchy(input: {
  documentId: string;
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  // Get the document
  const { data: doc } = await supabase
    .from("documents")
    .select("id, title, folder_id, parent_document_id, created_at")
    .eq("id", input.documentId)
    .single();

  if (!doc) return JSON.stringify({ error: "Document not found" });

  const resolve = await createFolderPathResolver();

  // Build ancestry chain (walk up parent_document_id)
  const ancestors: { id: string; title: string }[] = [];
  let currentParent = (doc as { parent_document_id: string | null }).parent_document_id;
  const visited = new Set<string>();
  while (currentParent && !visited.has(currentParent)) {
    visited.add(currentParent);
    const { data: parent } = await supabase
      .from("documents")
      .select("id, title, parent_document_id")
      .eq("id", currentParent)
      .single();
    if (!parent) break;
    ancestors.unshift({ id: parent.id, title: parent.title });
    currentParent = (parent as { parent_document_id: string | null }).parent_document_id;
  }

  // Build descendants tree recursively
  type DescNode = { id: string; title: string; children: DescNode[] };

  async function getDescendants(parentId: string): Promise<DescNode[]> {
    const { data: children } = await supabase!
      .from("documents")
      .select("id, title")
      .eq("parent_document_id", parentId)
      .order("position");
    if (!children || children.length === 0) return [];
    const nodes: DescNode[] = [];
    for (const child of children as { id: string; title: string }[]) {
      nodes.push({
        id: child.id,
        title: child.title,
        children: await getDescendants(child.id),
      });
    }
    return nodes;
  }

  const descendants = await getDescendants(input.documentId);

  return JSON.stringify({
    document: { id: doc.id, title: doc.title },
    folderPath: resolve((doc as { folder_id: string | null }).folder_id),
    ancestors,
    descendants,
  });
}

async function compareDocuments(input: {
  documentIds: string[];
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  if (input.documentIds.length < 2)
    return JSON.stringify({ error: "Need at least 2 document IDs" });

  const { data, error } = await supabase
    .from("documents")
    .select("id, title, subtitle, folder_id, tags, ai_summary, ai_tags, content, created_at, updated_at")
    .in("id", input.documentIds);

  if (error) return JSON.stringify({ error: error.message });
  if (!data || data.length === 0) return JSON.stringify({ error: "No documents found" });

  const resolve = await createFolderPathResolver();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const documents = (data as any[]).map(d => {
    const text = blocksToPlainText(d.content);
    const words = text.split(/\s+/).filter((w: string) => w.length > 0).length;
    return {
      id: d.id,
      title: d.title,
      subtitle: d.subtitle,
      folderPath: resolve(d.folder_id),
      tags: d.ai_tags ?? [],
      summary: d.ai_summary,
      wordCount: words,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    };
  });

  // Find common and unique tags
  const allTagSets = documents.map(d => new Set(d.tags as string[]));
  const commonTags = allTagSets.length > 0
    ? [...allTagSets[0]].filter(t => allTagSets.every(s => s.has(t)))
    : [];

  return JSON.stringify({
    documentCount: documents.length,
    commonTags,
    documents,
  });
}

async function getRecentlyModified(input: {
  limit?: number;
  from?: string;
}): Promise<string> {
  const supabase = getServerSupabase();
  if (!supabase) return JSON.stringify({ error: "Database not available" });

  const limit = input.limit ?? 15;

  let query = supabase
    .from("documents")
    .select("id, title, folder_id, ai_tags, ai_summary, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (input.from) query = query.gte("updated_at", input.from);

  const { data, error } = await query;
  if (error) return JSON.stringify({ error: error.message });

  const resolve = await createFolderPathResolver();

  const results = ((data ?? []) as {
    id: string; title: string; folder_id: string | null;
    ai_tags: string[]; ai_summary: string | null;
    created_at: string; updated_at: string;
  }[]).map(d => ({
    id: d.id,
    title: d.title,
    folderPath: resolve(d.folder_id),
    tags: d.ai_tags ?? [],
    summary: d.ai_summary,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  }));

  return JSON.stringify({ count: results.length, results });
}

// ─── Dispatcher ───

/**
 * Execute a tool by name, returning the JSON result string.
 * All errors are caught and returned as JSON to Claude (never throws).
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  console.log(`[tools] Executing: ${name}`, JSON.stringify(input).slice(0, 200));
  const start = Date.now();

  try {
    let result: string;
    switch (name) {
      case "search_notes":
        result = await searchNotes(input as { query: string; limit?: number });
        break;
      case "get_document_info":
        result = await getDocumentInfo(input as { documentId: string });
        break;
      case "read_document_content":
        result = await readDocumentContent(input as { documentId: string });
        break;
      case "list_folder_contents":
        result = await listFolderContents(
          input as {
            folderId?: string;
            folderName?: string;
            recursive?: boolean;
          }
        );
        break;
      case "get_backlinks":
        result = await getBacklinks(input as { documentId: string });
        break;
      case "search_by_date":
        result = await searchByDate(
          input as {
            from?: string;
            to?: string;
            sort?: string;
            limit?: number;
          }
        );
        break;
      case "get_writing_stats":
        result = await getWritingStats(
          input as { groupBy?: string; from?: string; to?: string }
        );
        break;
      case "search_by_tags":
        result = await searchByTags(
          input as { tags: string[]; matchAll?: boolean; limit?: number }
        );
        break;
      case "get_folder_tree":
        result = await getFolderTree(input as { parentId?: string });
        break;
      case "count_documents":
        result = await countDocuments(
          input as {
            folderId?: string;
            tag?: string;
            from?: string;
            to?: string;
          }
        );
        break;
      case "get_document_lengths":
        result = await getDocumentLengths(
          input as {
            documentIds?: string[];
            folderId?: string;
            folderName?: string;
            recursive?: boolean;
          }
        );
        break;
      case "get_recent_documents":
        result = await getRecentDocuments(
          input as { sortBy?: string; limit?: number }
        );
        break;
      case "get_document_children":
        result = await getDocumentChildren(
          input as { parentDocumentId: string }
        );
        break;
      case "get_all_tags":
        result = await getAllTags(input as { minCount?: number });
        break;
      case "batch_get_document_info":
        result = await batchGetDocumentInfo(
          input as { documentIds: string[] }
        );
        break;
      case "get_chunk_summaries":
        result = await getChunkSummaries(input as { documentId: string });
        break;
      case "find_similar_documents":
        result = await findSimilarDocuments(
          input as { documentId: string; limit?: number; threshold?: number }
        );
        break;
      case "search_document_content":
        result = await searchDocumentContent(
          input as { query: string; limit?: number }
        );
        break;
      case "get_folder_info":
        result = await getFolderInfo(
          input as { folderId?: string; folderName?: string }
        );
        break;
      case "get_orphan_documents":
        result = await getOrphanDocuments(input as { limit?: number });
        break;
      case "get_annotations":
        result = await getAnnotations(input as { documentId: string });
        break;
      case "get_daily_note":
        result = await getDailyNote(input as { date: string });
        break;
      case "get_tag_graph":
        result = await getTagGraph(input as { minCooccurrence?: number });
        break;
      case "get_document_hierarchy":
        result = await getDocumentHierarchy(input as { documentId: string });
        break;
      case "compare_documents":
        result = await compareDocuments(
          input as { documentIds: string[] }
        );
        break;
      case "get_recently_modified":
        result = await getRecentlyModified(
          input as { limit?: number; from?: string }
        );
        break;
      default:
        result = JSON.stringify({ error: `Unknown tool: ${name}` });
    }

    const elapsed = Date.now() - start;
    const finalResult = truncateToolResult(result);
    if (finalResult.length < result.length) {
      console.log(`[tools] ${name} completed in ${elapsed}ms (truncated ${result.length} → ${finalResult.length} chars)`);
    } else {
      console.log(`[tools] ${name} completed in ${elapsed}ms (${result.length} chars)`);
    }
    return finalResult;
  } catch (err) {
    console.error(`[tools] ${name} error:`, err);
    return JSON.stringify({
      error: `Tool execution failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}
