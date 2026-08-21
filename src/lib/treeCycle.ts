/**
 * Detect parent/child cycles in the sidebar tree.
 *
 * Documents nest via `parent_document_id` (and sit in a folder via `folder_id`).
 * Folders nest via `parent_id` or under a document via `parent_document_id`.
 * A drop that makes a node an ancestor of itself removes it from the visible
 * tree (`buildFolderTree` / `getRootDocuments` skip the cycle).
 */

type FolderRow = {
  id: string;
  parent_id: string | null;
  parent_document_id: string | null;
};

type DocRow = {
  id: string;
  folder_id: string | null;
  parent_document_id: string | null;
};

export type NestingMove =
  | {
      kind: "doc";
      id: string;
      parentDocId: string | null;
      folderId?: string | null;
    }
  | {
      kind: "folder";
      id: string;
      parentId: string | null;
      parentDocumentId: string | null;
    };

export function wouldCreateNestingCycle(
  folders: FolderRow[],
  docs: DocRow[],
  move: NestingMove
): boolean {
  const folderParent = new Map(
    folders.map((f) => [
      f.id,
      { parent_id: f.parent_id, parent_document_id: f.parent_document_id },
    ])
  );
  const docParent = new Map(
    docs.map((d) => [
      d.id,
      { folder_id: d.folder_id, parent_document_id: d.parent_document_id },
    ])
  );

  if (move.kind === "doc") {
    if (move.parentDocId === move.id) return true;
    const cur = docParent.get(move.id);
    if (!cur) return false;
    docParent.set(move.id, {
      folder_id: move.folderId !== undefined ? move.folderId : cur.folder_id,
      parent_document_id: move.parentDocId,
    });
    return walkHitsSelf("d", move.id, folderParent, docParent);
  }

  if (move.id === move.parentId) return true;
  folderParent.set(move.id, {
    parent_id: move.parentId,
    parent_document_id: move.parentDocumentId,
  });
  return walkHitsSelf("f", move.id, folderParent, docParent);
}

function walkHitsSelf(
  startType: "f" | "d",
  startId: string,
  folderParent: Map<
    string,
    { parent_id: string | null; parent_document_id: string | null }
  >,
  docParent: Map<
    string,
    { folder_id: string | null; parent_document_id: string | null }
  >
): boolean {
  const seenF = new Set<string>();
  const seenD = new Set<string>();
  let node: { t: "f" | "d"; id: string } | null = { t: startType, id: startId };

  while (node) {
    if (node.t === "f") {
      if (seenF.has(node.id)) return true;
      seenF.add(node.id);
      const f = folderParent.get(node.id);
      if (!f) return false;
      if (f.parent_document_id) node = { t: "d", id: f.parent_document_id };
      else if (f.parent_id) node = { t: "f", id: f.parent_id };
      else return false;
    } else {
      if (seenD.has(node.id)) return true;
      seenD.add(node.id);
      const d = docParent.get(node.id);
      if (!d) return false;
      if (d.parent_document_id) node = { t: "d", id: d.parent_document_id };
      else if (d.folder_id) node = { t: "f", id: d.folder_id };
      else return false;
    }
  }
  return false;
}
