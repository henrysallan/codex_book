"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Settings, Minus, Plus, Link, Check, Copy } from "lucide-react";
import { NoteSettings as NoteSettingsType } from "@/lib/types";
import { toggleShareLink } from "@/lib/db";

interface NoteSettingsProps {
  settings: NoteSettingsType;
  onChange: (settings: NoteSettingsType) => void;
  docId?: string;
  shareSlug?: string | null;
}

export function NoteSettingsButton({ settings, onChange, docId, shareSlug: initialShareSlug }: NoteSettingsProps) {
  const [open, setOpen] = useState(false);
  const [shareSlug, setShareSlug] = useState<string | null>(initialShareSlug ?? null);
  const [shareLoading, setShareLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        btnRef.current?.contains(e.target as Node) ||
        panelRef.current?.contains(e.target as Node)
      )
        return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const fontSize = settings.fontSize ?? 1;
  const fullWidth = settings.fullWidth ?? false;
  const font = settings.font ?? "";

  const setFontSize = useCallback(
    (v: number) => {
      const clamped = Math.round(Math.max(0.5, Math.min(2, v)) * 100) / 100;
      onChange({ ...settings, fontSize: clamped });
    },
    [settings, onChange]
  );

  const toggleFullWidth = useCallback(() => {
    onChange({ ...settings, fullWidth: !fullWidth });
  }, [settings, fullWidth, onChange]);

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-black/5 transition-colors pointer-events-auto"
        title="Note settings"
      >
        <Settings size={14} />
      </button>

      {open && (
        <div
          ref={panelRef}
          className="absolute right-3 top-8 w-56 bg-white border border-border rounded-lg shadow-lg p-3 space-y-3 pointer-events-auto z-50"
        >
          <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
            Note Settings
          </h4>

          {/* Font */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Font</label>
            <input
              type="text"
              value={font}
              onChange={(e) => onChange({ ...settings, font: e.target.value })}
              placeholder="Default"
              className="w-full text-xs px-2 py-1.5 rounded-md border border-border bg-white outline-none focus:border-black/20 transition-colors"
            />
          </div>

          {/* Font size */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              Font size{" "}
              <span className="text-muted">({Math.round(fontSize * 100)}%)</span>
            </label>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setFontSize(fontSize - 0.1)}
                className="shrink-0 p-1 rounded-md border border-border hover:bg-black/5 text-muted-foreground hover:text-foreground transition-colors"
              >
                <Minus size={12} />
              </button>
              <input
                type="range"
                min={50}
                max={200}
                value={Math.round(fontSize * 100)}
                onChange={(e) => setFontSize(Number(e.target.value) / 100)}
                className="flex-1 min-w-0 h-1 accent-foreground"
              />
              <button
                onClick={() => setFontSize(fontSize + 0.1)}
                className="shrink-0 p-1 rounded-md border border-border hover:bg-black/5 text-muted-foreground hover:text-foreground transition-colors"
              >
                <Plus size={12} />
              </button>
            </div>
          </div>

          {/* Width toggle */}
          <div className="flex items-center justify-between">
            <label className="text-xs text-muted-foreground">Full width</label>
            <button
              onClick={toggleFullWidth}
              className={`relative w-8 h-[18px] rounded-full transition-colors ${
                fullWidth ? "bg-foreground" : "bg-black/15"
              }`}
            >
              <span
                className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform ${
                  fullWidth ? "left-[15px]" : "left-[2px]"
                }`}
              />
            </button>
          </div>

          {/* Share link */}
          {docId && (
            <>
              <hr className="border-border" />
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-muted-foreground flex items-center gap-1">
                    <Link size={11} />
                    Share link
                  </label>
                  <button
                    disabled={shareLoading}
                    onClick={async () => {
                      setShareLoading(true);
                      try {
                        const slug = await toggleShareLink(docId, !shareSlug);
                        setShareSlug(slug);
                      } finally {
                        setShareLoading(false);
                      }
                    }}
                    className={`relative w-8 h-[18px] rounded-full transition-colors ${
                      shareSlug ? "bg-foreground" : "bg-black/15"
                    } ${shareLoading ? "opacity-50" : ""}`}
                  >
                    <span
                      className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform ${
                        shareSlug ? "left-[15px]" : "left-[2px]"
                      }`}
                    />
                  </button>
                </div>

                {shareSlug && (
                  <button
                    onClick={() => {
                      const url = `${window.location.origin}/share/${shareSlug}`;
                      navigator.clipboard.writeText(url);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                    className="flex items-center gap-1.5 w-full text-xs px-2 py-1.5 rounded-md border border-border hover:bg-black/5 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {copied ? (
                      <>
                        <Check size={11} className="text-green-600" />
                        <span className="text-green-600">Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy size={11} />
                        <span className="truncate">Copy share link</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
