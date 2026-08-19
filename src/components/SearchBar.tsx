"use client";

import { Search } from "lucide-react";

interface SearchBarProps {
  onOpenSearch?: () => void;
}

export function SearchBar({ onOpenSearch }: SearchBarProps) {
  return (
    <div className="flex items-center justify-center py-2 px-4 border-t border-border bg-white">
      <button
        onClick={onOpenSearch}
        className="flex items-center gap-2 px-5 py-1.5 rounded-full border border-border hover:border-black/20 transition-colors"
      >
        <Search size={12} className="text-muted-foreground" />
        <span className="text-xs text-foreground">search</span>
        <kbd className="text-[10px] text-muted-foreground bg-neutral-100 px-1.5 py-0.5 rounded ml-1">
          ⌘⇧F
        </kbd>
      </button>
    </div>
  );
}
