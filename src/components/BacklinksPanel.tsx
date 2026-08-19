"use client";

import { useState, useEffect } from "react";
import { useAppStore } from "@/lib/store";
import { getBacklinksForDocument, getOutgoingLinks } from "@/lib/db";
import { Backlink } from "@/lib/types";
import { ArrowUpRight, ArrowDownLeft, Link2 } from "lucide-react";

export function BacklinksPanel() {
  const activeDocument = useAppStore((s) => s.activeDocument);
  const openDocument = useAppStore((s) => s.openDocument);
  const [incoming, setIncoming] = useState<Backlink[]>([]);
  const [outgoing, setOutgoing] = useState<Backlink[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!activeDocument) {
      setIncoming([]);
      setOutgoing([]);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    Promise.all([
      getBacklinksForDocument(activeDocument.id),
      getOutgoingLinks(activeDocument.id),
    ])
      .then(([inc, out]) => {
        if (!cancelled) {
          setIncoming(inc);
          setOutgoing(out);
        }
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeDocument?.id, activeDocument]);

  if (!activeDocument) return null;

  const hasLinks = incoming.length > 0 || outgoing.length > 0;

  return (
    <div className="border-t border-border px-14 py-6 max-w-[800px] mx-auto">
      <div className="flex items-center gap-2 mb-3">
        <Link2 size={14} className="text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Backlinks
        </span>
      </div>

      {isLoading && (
        <p className="text-xs text-muted">Loading links...</p>
      )}

      {!isLoading && !hasLinks && (
        <p className="text-xs text-muted">
          No backlinks yet. Use <code className="bg-neutral-100 px-1 py-0.5 rounded text-[11px]">[[Document Title]]</code> to link between documents.
        </p>
      )}

      {/* Incoming links */}
      {incoming.length > 0 && (
        <div className="mb-3">
          <div className="flex items-center gap-1.5 mb-1.5">
            <ArrowDownLeft size={12} className="text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">
              {incoming.length} incoming
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {incoming.map((link) => (
              <button
                key={link.documentId}
                onClick={() => openDocument(link.documentId)}
                className="text-xs px-2.5 py-1 rounded-full border border-border hover:border-black/20 hover:bg-neutral-50 transition-colors text-foreground"
              >
                {link.documentTitle}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Outgoing links */}
      {outgoing.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 mb-1.5">
            <ArrowUpRight size={12} className="text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">
              {outgoing.length} outgoing
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {outgoing.map((link) => (
              <button
                key={link.documentId}
                onClick={() => openDocument(link.documentId)}
                className="text-xs px-2.5 py-1 rounded-full border border-border hover:border-black/20 hover:bg-neutral-50 transition-colors text-foreground"
              >
                {link.documentTitle}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
