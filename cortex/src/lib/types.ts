// Database types for Cortex
export interface DbFolder {
  id: string;
  name: string;
  parent_id: string | null;
  user_id: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface DbDocument {
  id: string;
  title: string;
  subtitle: string | null;
  folder_id: string | null;
  user_id: string;
  content: string; // JSON stringified BlockNote blocks
  tags: string[];
  position: number;
  created_at: string;
  updated_at: string;
}

// Client-side types
export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
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
  tags: string[];
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface Document extends DocumentMeta {
  content: string;
}

export interface OpenTab {
  documentId: string;
  title: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
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

// Search
export interface SearchResult {
  id: string;
  title: string;
  subtitle: string | null;
  tags: string[];
  snippet: string;
  rank: number;
}
