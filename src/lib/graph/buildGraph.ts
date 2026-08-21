import { DbDocument, DbFolder } from "@/lib/types";
import { hashString } from "./hash";
import {
  KIND_FOLDER,
  KIND_NOTE,
  type BuiltGraph,
  type LayoutCache,
  type SimLink,
} from "./types";

const EXCLUDED_DOC_TYPES = new Set<string>([
  "daily",
  "daily_parent",
  "quick_note_parent",
  "todo",
  "quick_note",
]);

function isExcludedDoc(doc: DbDocument, byId: Map<string, DbDocument>): boolean {
  if (EXCLUDED_DOC_TYPES.has(doc.doc_type)) return true;
  const seen = new Set<string>();
  let pid: string | null = doc.parent_document_id;
  while (pid && !seen.has(pid)) {
    seen.add(pid);
    const parent = byId.get(pid);
    if (!parent) break;
    if (EXCLUDED_DOC_TYPES.has(parent.doc_type)) return true;
    pid = parent.parent_document_id;
  }
  return false;
}

function clamp(n: number, lo: number, hi: number) {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Assemble typed-array graph from in-memory store rows + backlinks.
 * v1.1: tag-relatedness wires / coloring can hang off the same node list.
 */
export function buildGraph(
  documents: DbDocument[],
  folders: DbFolder[],
  backlinks: { source: string; target: string }[]
): BuiltGraph {
  const docsById = new Map(documents.map((d) => [d.id, d]));
  const includedDocs = documents.filter((d) => !isExcludedDoc(d, docsById));

  const ids: string[] = [];
  const labels: string[] = [];
  const kinds: number[] = [];

  for (const f of folders) {
    ids.push(f.id);
    labels.push(f.name || "Untitled folder");
    kinds.push(KIND_FOLDER);
  }
  for (const d of includedDocs) {
    ids.push(d.id);
    labels.push(d.title || "Untitled");
    kinds.push(KIND_NOTE);
  }

  const nodeCount = ids.length;
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < nodeCount; i++) idToIndex.set(ids[i], i);

  const kindsArr = new Uint8Array(kinds);
  const degrees = new Uint16Array(nodeCount);

  const linkPairs: number[] = [];
  let backlinkCount = 0;
  for (const e of backlinks) {
    const s = idToIndex.get(e.source);
    const t = idToIndex.get(e.target);
    if (s === undefined || t === undefined || s === t) continue;
    linkPairs.push(s, t);
    degrees[s]++;
    degrees[t]++;
    backlinkCount++;
  }

  const containPairs: number[] = [];
  const pushContain = (parentId: string | null, childId: string) => {
    if (!parentId) return;
    const p = idToIndex.get(parentId);
    const c = idToIndex.get(childId);
    if (p === undefined || c === undefined || p === c) return;
    containPairs.push(p, c);
  };

  for (const f of folders) {
    pushContain(f.parent_id, f.id);
    pushContain(f.parent_document_id, f.id);
  }
  for (const d of includedDocs) {
    pushContain(d.folder_id, d.id);
    pushContain(d.parent_document_id, d.id);
  }

  const links = new Uint32Array(linkPairs);
  const contains = new Uint32Array(containPairs);
  const linkCount = links.length / 2;
  const containCount = contains.length / 2;

  const radii = new Float32Array(nodeCount);
  let noteRadiusSum = 0;
  let noteCount = 0;
  for (let i = 0; i < nodeCount; i++) {
    if (kindsArr[i] === KIND_NOTE) {
      const r = clamp(3 + 2 * Math.sqrt(degrees[i]), 3, 10);
      radii[i] = r;
      noteRadiusSum += r;
      noteCount++;
    }
  }
  const folderR = noteCount > 0 ? clamp((noteRadiusSum / noteCount) * 1.3, 6, 12) : 7;
  for (let i = 0; i < nodeCount; i++) {
    if (kindsArr[i] === KIND_FOLDER) radii[i] = folderR;
  }

  const orphanFlags = new Uint8Array(nodeCount);
  let orphanCount = 0;
  for (let i = 0; i < nodeCount; i++) {
    if (kindsArr[i] === KIND_NOTE && degrees[i] === 0) {
      orphanFlags[i] = 1;
      orphanCount++;
    }
  }
  const ringRadius = 180 + 10 * Math.sqrt(Math.max(orphanCount, 1));

  const adjCounts = new Uint32Array(nodeCount);
  const bump = (a: number, b: number) => {
    adjCounts[a]++;
    adjCounts[b]++;
  };
  for (let i = 0; i < linkCount; i++) bump(links[i * 2], links[i * 2 + 1]);
  for (let i = 0; i < containCount; i++) bump(contains[i * 2], contains[i * 2 + 1]);

  const adjOffsets = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) adjOffsets[i + 1] = adjOffsets[i] + adjCounts[i];
  const adjIndices = new Uint32Array(adjOffsets[nodeCount]);
  const fillAt = adjOffsets.slice();
  const addAdj = (a: number, b: number) => {
    adjIndices[fillAt[a]++] = b;
    adjIndices[fillAt[b]++] = a;
  };
  for (let i = 0; i < linkCount; i++) addAdj(links[i * 2], links[i * 2 + 1]);
  for (let i = 0; i < containCount; i++) addAdj(contains[i * 2], contains[i * 2 + 1]);

  const simLinks: SimLink[] = [];
  for (let i = 0; i < linkCount; i++) {
    const s = links[i * 2];
    const t = links[i * 2 + 1];
    const hub = Math.min(degrees[s], degrees[t]);
    simLinks.push({
      source: s,
      target: t,
      distance: 60,
      strength: 0.55 / Math.sqrt(hub + 1),
    });
  }
  for (let i = 0; i < containCount; i++) {
    simLinks.push({
      source: contains[i * 2],
      target: contains[i * 2 + 1],
      distance: 38,
      strength: 0.18,
    });
  }

  const edgeKey = [
    ...Array.from({ length: linkCount }, (_, i) => `b:${ids[links[i * 2]]}:${ids[links[i * 2 + 1]]}`),
    ...Array.from({ length: containCount }, (_, i) => `c:${ids[contains[i * 2]]}:${ids[contains[i * 2 + 1]]}`),
  ]
    .sort()
    .join("\n");
  const topologyHash = hashString([...ids].sort().join(",") + "|" + edgeKey);

  return {
    nodeCount,
    ids,
    labels,
    kinds: kindsArr,
    radii,
    positions: new Float32Array(nodeCount * 2),
    orphanFlags,
    degrees,
    idToIndex,
    topologyHash,
    linkCount,
    links,
    containCount,
    contains,
    adjOffsets,
    adjIndices,
    simLinks,
    ringRadius,
    includedNoteCount: noteCount,
    backlinkCount,
  };
}

/** Seed positions from a cache (surviving nodes) + a loose ring for orphans. */
export function seedPositions(graph: BuiltGraph, cache: LayoutCache | null): boolean {
  const { nodeCount, positions, ids, orphanFlags, ringRadius } = graph;
  let hits = 0;
  let orphanI = 0;

  for (let i = 0; i < nodeCount; i++) {
    const cached = cache?.positions[ids[i]];
    if (cached) {
      positions[i * 2] = cached[0];
      positions[i * 2 + 1] = cached[1];
      hits++;
      continue;
    }
    if (orphanFlags[i]) {
      const a = (orphanI++ * 2.399963229728653) % (Math.PI * 2);
      const jitter = 8 + (i % 7);
      positions[i * 2] = Math.cos(a) * (ringRadius + jitter);
      positions[i * 2 + 1] = Math.sin(a) * (ringRadius + jitter);
    } else {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 90;
      positions[i * 2] = Math.cos(a) * r;
      positions[i * 2 + 1] = Math.sin(a) * r;
    }
  }

  return hits === nodeCount && nodeCount > 0;
}

export function positionsToCache(graph: BuiltGraph): LayoutCache {
  const positions: Record<string, [number, number]> = {};
  for (let i = 0; i < graph.nodeCount; i++) {
    positions[graph.ids[i]] = [graph.positions[i * 2], graph.positions[i * 2 + 1]];
  }
  return { hash: graph.topologyHash, positions };
}

export function ancestorFolderIds(folderId: string, folders: DbFolder[]): string[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const ids: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = folderId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    ids.push(cur);
    cur = byId.get(cur)?.parent_id ?? null;
  }
  return ids;
}
