"use client";

/**
 * Google Drive client — lists and downloads files from a synced folder.
 *
 * Token lifecycle:
 *  - On sign-in, Supabase gives us session.provider_token (Google access token)
 *  - That token expires after ~1 hour
 *  - When it's stale, call /api/drive/token to get a fresh one via the stored refresh_token
 */

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const APP_FOLDER_NAME = "Codex";

// ── Token management ──────────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiry = 0;
let tokenEverSet = false;

/**
 * Set the token from the Supabase session (called by components on mount).
 * Only updates when a non-null token is provided — Supabase's auto-refresh
 * sets provider_token to null, and we don't want that to wipe a valid token.
 */
export function setDriveToken(token: string | null) {
  if (token) {
    cachedToken = token;
    tokenExpiry = Date.now() + 55 * 60 * 1000;
    tokenEverSet = true;
  }
}

/** Clear all cached token state (call on sign-out) */
export function clearDriveToken() {
  cachedToken = null;
  tokenExpiry = 0;
  tokenEverSet = false;
  appFolderIdCache = null;
}

/** Get a valid Google access token, refreshing if needed */
export async function getDriveToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  // Get current Supabase session JWT to authenticate the refresh request
  const { supabase } = await import("./supabase");
  const accessToken = supabase
    ? (await supabase.auth.getSession()).data.session?.access_token
    : null;

  if (!accessToken) {
    throw new Error("Not authenticated – please sign in again");
  }

  // Try refreshing via our API route
  const res = await fetch("/api/drive/token", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to refresh Google token: ${err}`);
  }
  const { access_token, expires_in } = await res.json();
  cachedToken = access_token;
  tokenExpiry = Date.now() + (expires_in - 60) * 1000;
  return access_token;
}

/** Check if we have (or can get) a valid Drive token */
export function hasDriveToken(): boolean {
  return tokenEverSet;
}

// ── Helpers ───────────────────────────────────────────────────────────

async function driveHeaders(): Promise<Record<string, string>> {
  const token = await getDriveToken();
  return { Authorization: `Bearer ${token}` };
}

// ── Folder resolution ─────────────────────────────────────────────────

let appFolderIdCache: string | null = null;

/**
 * Find the "Codex" folder in the user's Google Drive root.
 * Returns the folder ID, or null if not found.
 */
export async function findAppFolder(): Promise<string | null> {
  if (appFolderIdCache) return appFolderIdCache;
  const headers = await driveHeaders();

  // Search for existing folder
  const q = `name='${APP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const searchRes = await fetch(
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`,
    { headers }
  );
  if (!searchRes.ok) throw new Error(`Drive search failed: ${searchRes.statusText}`);
  const { files } = await searchRes.json();

  if (files && files.length > 0) {
    appFolderIdCache = files[0].id;
    return appFolderIdCache;
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────────────

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  thumbnailLink: string | null;
  webViewLink: string | null;
  modifiedTime: string;
}

/**
 * List all files in the Codex app folder (non-recursive, non-trashed).
 * Returns empty array if the Codex folder doesn't exist yet.
 */
export async function listDriveFiles(): Promise<DriveFile[]> {
  const folderId = await findAppFolder();
  if (!folderId) return []; // Folder doesn't exist yet
  const headers = await driveHeaders();

  const allFiles: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name,mimeType,size,thumbnailLink,webViewLink,modifiedTime)",
      orderBy: "modifiedTime desc",
      pageSize: "100",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`${DRIVE_API}/files?${params}`, { headers });
    if (!res.ok) throw new Error(`Drive list failed: ${res.statusText}`);
    const data = await res.json();

    for (const f of data.files ?? []) {
      allFiles.push({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        size: f.size ? parseInt(f.size, 10) : null,
        thumbnailLink: f.thumbnailLink ?? null,
        webViewLink: f.webViewLink ?? null,
        modifiedTime: f.modifiedTime,
      });
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  return allFiles;
}

/**
 * Download a file's content from Google Drive as a Blob.
 */
export async function downloadDriveFile(fileId: string): Promise<Blob> {
  const headers = await driveHeaders();
  const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
    headers,
  });
  if (!res.ok) throw new Error(`Drive download failed: ${res.statusText}`);
  return res.blob();
}
