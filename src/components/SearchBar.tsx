"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useAppStore } from "@/lib/store";
import { searchDocuments } from "@/lib/db";
import { SearchResult } from "@/lib/types";
import { Search, FileText, X } from "lucide-react";

function fuzzyScore(title: string, query: string): number {
  const t = title.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const substringIdx = t.indexOf(q);
  if (substringIdx >= 0) return 200 - substringIdx;
  let score = 0;
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found === -1) return -1;
    score += found === 0 || t[found - 1] === " " ? 10 : 1;
    ti = found + 1;
  }
  return score;
}

export function SearchBar() {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [committed, setCommitted] = useState(false);
  const [fullResults, setFullResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const _dbDocuments = useAppStore((s) => s._dbDocuments);
  const openDocument = useAppStore((s) => s.openDocument);

  const fuzzyResults = useMemo(() => {
    const q = query.trim();
    if (!q || committed) return [];
    return _dbDocuments
      .map((d) => ({
        id: d.id,
        title: d.title || "Untitled",
        subtitle: d.subtitle,
        score: fuzzyScore(d.title || "", q),
      }))
      .filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }, [_dbDocuments, query, committed]);

  const visibleResults = committed ? fullResults : fuzzyResults;
  const showPanel = expanded && (query.trim().length > 0 || isSearching);

  const collapse = useCallback(() => {
    setExpanded(false);
    setQuery("");
    setCommitted(false);
    setFullResults([]);
    setIsSearching(false);
    setSelectedIndex(0);
  }, []);

  const expand = useCallback(() => {
    setExpanded(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const openDoc = useCallback(
    (id: string) => {
      openDocument(id);
      collapse();
    },
    [openDocument, collapse]
  );

  const runFullSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setCommitted(true);
    setIsSearching(true);
    setSelectedIndex(0);
    try {
      const res = await searchDocuments(q);
      setFullResults(res);
    } catch (err) {
      console.error("Search error:", err);
      setFullResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        expand();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expand]);

  useEffect(() => {
    if (!expanded) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        collapse();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [expanded, collapse]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [visibleResults.length, committed]);

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      collapse();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, Math.max(visibleResults.length - 1, 0)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (!committed) {
        runFullSearch();
      } else if (fullResults[selectedIndex]) {
        openDoc(fullResults[selectedIndex].id);
      }
    }
  };

  return (
    <div ref={rootRef} className="relative z-20 flex items-center justify-center py-2 px-4">
      <div
        className={`relative transition-[width] duration-200 ease-out ${
          expanded ? "w-[min(28rem,calc(100%-2rem))]" : "w-[8.85rem]"
        }`}
      >
        {showPanel && (
          <div
            className={`absolute bottom-[calc(100%+8px)] left-0 right-0 bg-white rounded-xl border border-border shadow-lg overflow-hidden transition-[max-height] duration-200 ease-out ${
              committed ? "max-h-[min(24rem,50vh)]" : "max-h-52"
            }`}
          >
            <div
              ref={listRef}
              className={`py-1 ${committed ? "overflow-y-auto max-h-[min(24rem,50vh)]" : "overflow-hidden max-h-52"}`}
            >
              {isSearching && (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  Searching…
                </div>
              )}

              {!isSearching && visibleResults.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  No results for &ldquo;{query.trim()}&rdquo;
                </div>
              )}

              {!isSearching &&
                !committed &&
                fuzzyResults.map((item, i) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                      i === selectedIndex ? "bg-neutral-100" : "hover:bg-neutral-50"
                    }`}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onClick={() => openDoc(item.id)}
                  >
                    <FileText size={13} className="text-muted-foreground shrink-0" />
                    <span className="text-xs text-foreground truncate">{item.title}</span>
                  </button>
                ))}

              {!isSearching &&
                committed &&
                fullResults.map((result, i) => (
                  <button
                    key={result.id}
                    type="button"
                    className={`w-full px-3 py-2 text-left transition-colors ${
                      i === selectedIndex ? "bg-neutral-100" : "hover:bg-neutral-50"
                    }`}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onClick={() => openDoc(result.id)}
                  >
                    <div className="flex items-center gap-2">
                      <FileText size={13} className="text-muted-foreground shrink-0" />
                      <span className="text-xs font-medium text-foreground truncate">
                        {result.title}
                      </span>
                      {result.tags.slice(0, 2).map((tag) => (
                        <span
                          key={tag}
                          className="text-[10px] px-1.5 py-0.5 rounded-full border border-border text-muted-foreground shrink-0"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                    {result.snippet && (
                      <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2 pl-5 mt-0.5">
                        …{result.snippet}…
                      </p>
                    )}
                  </button>
                ))}
            </div>
          </div>
        )}

        <div
          className={`flex items-center gap-2 w-full rounded-full border bg-white transition-colors ${
            expanded
              ? "px-4 py-1.5 border-black/20"
              : "px-5 py-1.5 border-border hover:border-black/20 cursor-text"
          }`}
          onClick={() => {
            if (!expanded) expand();
          }}
        >
          <Search size={12} className="text-muted-foreground shrink-0" />
          {expanded ? (
            <>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCommitted(false);
                  setFullResults([]);
                }}
                onKeyDown={handleKeyDown}
                placeholder="Search notes…"
                className="flex-1 min-w-0 text-xs bg-transparent outline-none placeholder:text-muted"
              />
              {query && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setQuery("");
                    setCommitted(false);
                    setFullResults([]);
                    inputRef.current?.focus();
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X size={12} />
                </button>
              )}
              <kbd className="text-[10px] text-muted-foreground bg-neutral-100 px-1.5 py-0.5 rounded shrink-0">
                ESC
              </kbd>
            </>
          ) : (
            <>
              <span className="text-xs text-foreground">search</span>
              <kbd className="text-[10px] text-muted-foreground bg-neutral-100 px-1.5 py-0.5 rounded ml-1">
                ⌘⇧F
              </kbd>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
