"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useAppStore } from "@/lib/store";
import { searchDocuments } from "@/lib/db";
import { SearchResult } from "@/lib/types";
import { Search, FileText, X } from "lucide-react";

interface SearchDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SearchDialog({ isOpen, onClose }: SearchDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openDocument = useAppStore((s) => s.openDocument);

  // Focus input on open
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setResults([]);
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await searchDocuments(query);
        setResults(res);
        setSelectedIndex(0);
      } catch (err) {
        console.error("Search error:", err);
      } finally {
        setIsSearching(false);
      }
    }, 250);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Scroll selected into view
  useEffect(() => {
    if (listRef.current) {
      const el = listRef.current.children[selectedIndex] as HTMLElement;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const handleSelect = useCallback(
    (result: SearchResult) => {
      openDocument(result.id);
      onClose();
    },
    [openDocument, onClose]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (results[selectedIndex]) {
          handleSelect(results[selectedIndex]);
        }
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    [results, selectedIndex, handleSelect, onClose]
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />

      {/* Dialog */}
      <div className="relative w-[600px] bg-white rounded-xl shadow-2xl border border-border overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Search size={16} className="text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search across all documents..."
            className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="text-muted-foreground hover:text-foreground"
            >
              <X size={14} />
            </button>
          )}
          <kbd className="text-[10px] text-muted-foreground bg-neutral-100 px-1.5 py-0.5 rounded">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[400px] overflow-y-auto py-1">
          {isSearching && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Searching...
            </div>
          )}

          {!isSearching && query && results.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No results for &ldquo;{query}&rdquo;
            </div>
          )}

          {!isSearching &&
            results.map((result, i) => (
              <div
                key={result.id}
                className={`px-4 py-3 cursor-pointer transition-colors ${
                  i === selectedIndex
                    ? "bg-neutral-100"
                    : "hover:bg-neutral-50"
                }`}
                onClick={() => handleSelect(result)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <div className="flex items-center gap-2 mb-1">
                  <FileText
                    size={14}
                    className="text-muted-foreground shrink-0"
                  />
                  <span className="text-sm font-medium text-foreground truncate">
                    {result.title}
                  </span>
                  {result.tags.length > 0 && (
                    <div className="flex gap-1 ml-auto">
                      {result.tags.slice(0, 3).map((tag) => (
                        <span
                          key={tag}
                          className="text-[10px] px-1.5 py-0.5 rounded-full border border-border text-muted-foreground"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {result.snippet && (
                  <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2 pl-5">
                    ...{result.snippet}...
                  </p>
                )}
              </div>
            ))}

          {!query && !isSearching && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Type to search across titles, content, and tags
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
