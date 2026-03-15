"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { useAppStore } from "@/lib/store";
import {
  listDriveFiles,
  setDriveToken,
  clearDriveToken,
  hasDriveToken,
  type DriveFile,
} from "@/lib/googleDrive";
import {
  ChevronRight,
  ChevronDown,
  HardDrive,
  FileText,
  Image,
  File,
  RefreshCw,
  Loader2,
} from "lucide-react";

function fileIcon(mimeType: string) {
  if (mimeType === "application/pdf") return <FileText size={13} className="text-red-400 shrink-0" />;
  if (mimeType.startsWith("image/")) return <Image size={13} className="text-blue-400 shrink-0" />;
  return <File size={13} className="text-muted-foreground shrink-0" />;
}

export function DriveFolder() {
  const { providerToken, user } = useAuth();
  const openDriveFile = useAppStore((s) => s.openDriveFile);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);

  const [isExpanded, setIsExpanded] = useState(false);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  // Set Drive token on sign-in; clear everything on sign-out
  useEffect(() => {
    if (providerToken) {
      setDriveToken(providerToken);
    }
  }, [providerToken]);

  useEffect(() => {
    if (!user) {
      clearDriveToken();
      setFiles([]);
      setHasLoaded(false);
      setError(null);
    }
  }, [user]);

  const loadFiles = useCallback(async () => {
    if (!hasDriveToken()) return;
    setIsLoading(true);
    setError(null);
    try {
      const result = await listDriveFiles();
      setFiles(result);
      setHasLoaded(true);
    } catch (err) {
      console.error("Failed to list Drive files:", err);
      setError(err instanceof Error ? err.message : "Failed to load files");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load files when folder is first expanded
  useEffect(() => {
    if (isExpanded && !hasLoaded && !isLoading) {
      loadFiles();
    }
  }, [isExpanded, hasLoaded, isLoading, loadFiles]);

  // Don't show if not signed in
  if (!user) return null;

  return (
    <div className="mt-1">
      {/* Folder header */}
      <div
        className="group flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer transition-colors hover:bg-black/[0.03]"
        style={{ paddingLeft: "8px" }}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span className="text-muted-foreground shrink-0">
          {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <HardDrive size={13} className="text-muted-foreground shrink-0" />
        <span className="text-xs text-foreground truncate flex-1">
          Google Drive
        </span>
        {isExpanded && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              loadFiles();
            }}
            className="p-0.5 rounded hover:bg-black/10 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
            title="Refresh"
          >
            {isLoading ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <RefreshCw size={11} />
            )}
          </button>
        )}
      </div>

      {/* Files list */}
      {isExpanded && (
        <div>
          {isLoading && !hasLoaded && (
            <div className="flex items-center gap-2 px-2 py-2" style={{ paddingLeft: "32px" }}>
              <Loader2 size={12} className="animate-spin text-muted-foreground" />
              <span className="text-[11px] text-muted-foreground">Loading…</span>
            </div>
          )}

          {error && (
            <div className="px-2 py-1" style={{ paddingLeft: "32px" }}>
              <span className="text-[11px] text-red-500">{error}</span>
            </div>
          )}

          {hasLoaded && files.length === 0 && !isLoading && (
            <div className="px-2 py-1" style={{ paddingLeft: "32px" }}>
              <span className="text-[11px] text-muted-foreground">
                Create a folder called &quot;Codex&quot; in your Google Drive and add files to it.
              </span>
            </div>
          )}

          {files.map((file) => {
            const tabId = `drive:${file.id}`;
            const isActive = activeDocumentId === tabId;

            return (
              <div
                key={file.id}
                className={`flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer transition-colors ${
                  isActive ? "bg-black/5" : "hover:bg-black/[0.03]"
                }`}
                style={{ paddingLeft: "32px" }}
                onClick={() =>
                  openDriveFile({
                    id: file.id,
                    name: file.name,
                    mimeType: file.mimeType,
                    webViewLink: file.webViewLink,
                  })
                }
                title={file.name}
              >
                {fileIcon(file.mimeType)}
                <span className="text-xs text-foreground truncate flex-1">
                  {file.name}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
