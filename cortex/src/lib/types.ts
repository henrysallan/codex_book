// Database types for Cortex
export interface DbFolder {
  id: string;
  name: string;
  parent_id: string | null;
  parent_document_id: string | null;
  user_id: string;
  position: number;
  created_at: string;
  updated_at: string;
}

// Note-level settings
export interface NoteSettings {
  font?: string;
  fontSize?: number; // scale factor, default 1
  fullWidth?: boolean;
}

// Document type discriminator
export type DocType = "note" | "todo" | "daily_parent" | "daily" | "quick_note_parent";

export interface DbDocument {
  id: string;
  title: string;
  subtitle: string | null;
  folder_id: string | null;
  parent_document_id: string | null;
  user_id: string;
  content: string; // JSON stringified BlockNote blocks
  tags: string[];
  settings: NoteSettings;
  doc_type: DocType;
  position: number;
  created_at: string;
  updated_at: string;
}

// Client-side types
export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  parentDocumentId: string | null;
  position: number;
  isExpanded: boolean;
  children: Folder[];
  documents: DocumentMeta[];
}

export interface DocumentMeta {
  id: string;
  title: string;
  subtitle: string | null;
  folderId: string | null;
  parentDocumentId: string | null;
  tags: string[];
  docType: DocType;
  position: number;
  createdAt: string;
  updatedAt: string;
  childDocuments?: DocumentMeta[];
  childFolders?: Folder[];
}

export interface Document extends DocumentMeta {
  content: string;
  settings: NoteSettings;
}

// Todo item shape used by the dashboard widget
export interface TodoItem {
  blockId: string;
  text: string;
  checked: boolean;
}

// Quick note item shape used by the dashboard widget
export interface QuickNoteItem {
  docId: string;
  title: string;
  createdAt: string;
}

export interface OpenTab {
  documentId: string;
  title: string;
  /** If set, this tab displays a Google Drive file instead of a document */
  driveFile?: {
    fileId: string;
    mimeType: string;
    webViewLink: string | null;
  };
}

export interface SourceEntry {
  docId: string;
  title: string;
  chunkIndex?: number;
}

export type SourceMap = Record<number, SourceEntry>;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  sourceMap?: SourceMap;
}

// Backlinks
export interface DbBacklink {
  id: string;
  source_document_id: string;
  target_document_id: string;
  created_at: string;
}

export interface Backlink {
  documentId: string;
  documentTitle: string;
}

// Context items for AI chat
export type ContextItem =
  | { type: "document"; docId: string; title: string }
  | { type: "block"; blockId: string; text: string; docTitle: string };

// Search
export interface SearchResult {
  id: string;
  title: string;
  subtitle: string | null;
  tags: string[];
  snippet: string;
  rank: number;
}

// Annotations
export interface AnnotationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface DbAnnotation {
  id: string;
  document_id: string;
  user_id: string;
  block_id: string | null;
  highlighted_text: string;
  messages: AnnotationMessage[];
  created_at: string;
  updated_at: string;
}

export interface Annotation {
  id: string;
  documentId: string;
  blockId: string | null;
  highlightedText: string;
  messages: AnnotationMessage[];
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// AI Integration Types
// ============================================================

export interface DbDocumentChunk {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  content_hash: string;
  heading: string | null;
  block_ids: string[];
  token_count: number;
  summary: string | null;
  tags: string[];
  // embedding is never sent to the client — only used server-side
  created_at: string;
  updated_at: string;
}

export interface ChunkSearchResult {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  summary: string | null;
  tags: string[];
  similarity: number;
}

export interface DocumentSearchResult {
  id: string;
  title: string;
  ai_summary: string | null;
  ai_tags: string[];
  similarity: number;
}

export interface DbUsageLog {
  id: string;
  user_id: string;
  flow: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  document_id: string | null;
  created_at: string;
}

// Attachments (Google Drive–backed files)
export interface DbAttachment {
  id: string;
  document_id: string;
  user_id: string;
  file_name: string;
  mime_type: string;
  file_size: number | null;
  drive_file_id: string;
  drive_web_view_link: string | null;
  created_at: string;
}

export interface Attachment {
  id: string;
  documentId: string;
  fileName: string;
  mimeType: string;
  fileSize: number | null;
  driveFileId: string;
  driveWebViewLink: string | null;
  createdAt: string;
}

// ============================================================
// PDF Annotations (highlights, notes, chats on Drive PDFs)
// ============================================================

export type PdfAnnotationColor = "yellow" | "green" | "blue" | "pink" | "purple";
export type PdfAnnotationType = "highlight" | "note" | "chat";

export interface TextAnchor {
  pageNumber: number;
  exact: string;       // the selected text
  prefix?: string;     // ~30 chars before
  suffix?: string;     // ~30 chars after
}

export interface DbPdfAnnotation {
  id: string;
  drive_file_id: string;
  user_id: string;
  color: PdfAnnotationColor;
  type: PdfAnnotationType;
  page_number: number;
  anchor_exact: string;
  anchor_prefix: string | null;
  anchor_suffix: string | null;
  note: string | null;
  messages: AnnotationMessage[];
  created_at: string;
  updated_at: string;
}

export interface PdfAnnotation {
  id: string;
  driveFileId: string;
  color: PdfAnnotationColor;
  type: PdfAnnotationType;
  anchor: TextAnchor;
  note: string | null;
  messages: AnnotationMessage[];
  createdAt: string;
  updatedAt: string;
}
