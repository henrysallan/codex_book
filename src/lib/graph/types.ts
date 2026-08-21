export const KIND_NOTE = 0;
export const KIND_FOLDER = 1;

export interface GraphTheme {
  background: string;
  foreground: string;
  border: string;
  accent: string;
  muted: string;
  mutedFg: string;
  font: string;
}

export interface SimLink {
  source: number;
  target: number;
  distance: number;
  strength: number;
}

export interface BuiltGraph {
  nodeCount: number;
  ids: string[];
  labels: string[];
  kinds: Uint8Array;
  radii: Float32Array;
  positions: Float32Array;
  orphanFlags: Uint8Array;
  degrees: Uint16Array;
  idToIndex: Map<string, number>;
  topologyHash: string;
  linkCount: number;
  links: Uint32Array;
  containCount: number;
  contains: Uint32Array;
  adjOffsets: Uint32Array;
  adjIndices: Uint32Array;
  simLinks: SimLink[];
  ringRadius: number;
  includedNoteCount: number;
  backlinkCount: number;
}

export interface LayoutCache {
  hash: string;
  positions: Record<string, [number, number]>;
}
