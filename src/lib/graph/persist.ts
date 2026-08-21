import type { GraphCamera, GraphLayout } from "@/lib/types";
import type { LayoutCache } from "./types";

const LAYOUT_KEY = "cortex:cache:graphLayout";
const CAMERA_KEY = "cortex:cache:graphCamera";

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // quota — ignore
  }
}

export function loadLocalLayout(): LayoutCache | null {
  const v = read<GraphLayout>(LAYOUT_KEY);
  if (!v?.topologyHash || !v.positions) return null;
  return { hash: v.topologyHash, positions: v.positions };
}

export function saveLocalLayout(layout: LayoutCache) {
  write(LAYOUT_KEY, { topologyHash: layout.hash, positions: layout.positions } satisfies GraphLayout);
}

export function loadCamera(): GraphCamera | null {
  const v = read<GraphCamera>(CAMERA_KEY);
  if (!v || typeof v.k !== "number") return null;
  return v;
}

export function saveCamera(camera: GraphCamera) {
  write(CAMERA_KEY, camera);
}
