"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useAppStore } from "@/lib/store";
import { Document } from "@/lib/types";
import { parseBacklinks, syncBacklinks } from "@/lib/db";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { Block } from "@blocknote/core";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { X } from "lucide-react";

interface DocumentEditorProps {
  document: Document;
}

export function DocumentEditor({ document }: DocumentEditorProps) {
  const saveDocument = useAppStore((s) => s.saveDocument);
  const _dbDocuments = useAppStore((s) => s._dbDocuments);
  const [title, setTitle] = useState(document.title);
  const [subtitle, setSubtitle] = useState(document.subtitle || "");
  const [tags, setTags] = useState<string[]>(document.tags || []);
  const [tagInput, setTagInput] = useState("");
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Parse initial content for BlockNote
  let initialContent: Block[] | undefined;
  try {
    const parsed = JSON.parse(document.content);
    if (Array.isArray(parsed) && parsed.length > 0) {
      initialContent = parsed;
    }
  } catch {
    initialContent = undefined;
  }

  const editor = useCreateBlockNote({
    initialContent,
  });

  // Auto-save on content change
  const handleEditorChange = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(async () => {
      const blocks = editor.document;
      const content = JSON.stringify(blocks);
      saveDocument(document.id, { content });

      // Parse and sync backlinks
      try {
        const targetIds = parseBacklinks(content, _dbDocuments);
        await syncBacklinks(document.id, targetIds);
      } catch (err) {
        console.error("Failed to sync backlinks:", err);
      }
    }, 1000);
  }, [editor, document.id, saveDocument, _dbDocuments]);

  // Auto-save title changes
  const handleTitleBlur = useCallback(() => {
    const trimmed = title.trim() || "Untitled";
    if (trimmed !== document.title) {
      saveDocument(document.id, { title: trimmed });
    }
  }, [title, document.id, document.title, saveDocument]);

  // Auto-save subtitle changes
  const handleSubtitleBlur = useCallback(() => {
    if (subtitle !== (document.subtitle || "")) {
      saveDocument(document.id, { subtitle: subtitle || null });
    }
  }, [subtitle, document.id, document.subtitle, saveDocument]);

  // Tag management
  const addTag = useCallback(() => {
    const tag = tagInput.trim();
    if (tag && !tags.includes(tag)) {
      const newTags = [...tags, tag];
      setTags(newTags);
      setTagInput("");
      saveDocument(document.id, { tags: newTags });
    }
  }, [tagInput, tags, document.id, saveDocument]);

  const removeTag = useCallback(
    (tagToRemove: string) => {
      const newTags = tags.filter((t) => t !== tagToRemove);
      setTags(newTags);
      saveDocument(document.id, { tags: newTags });
    },
    [tags, document.id, saveDocument]
  );

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div className="max-w-[800px] mx-auto px-14 py-12">
      {/* Title */}
      <div className="mb-6">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleTitleBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder="Title"
          className="w-full text-[39px] font-normal text-foreground bg-transparent border-none outline-none placeholder:text-muted leading-tight"
        />
      </div>

      {/* Subtitle + Tags */}
      <div className="mb-8 pl-14 space-y-2">
        <input
          type="text"
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          onBlur={handleSubtitleBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder="Subtitle"
          className="w-full text-lg text-foreground bg-transparent border-none outline-none placeholder:text-muted"
        />

        {/* Tags row */}
        <div className="flex items-center gap-4">
          <span className="text-lg text-foreground">Tags:</span>
          <div className="flex items-center gap-2 flex-wrap">
            {tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 px-3 py-0.5 rounded-full border border-border text-[13px] text-foreground bg-white"
              >
                {tag}
                <button
                  onClick={() => removeTag(tag)}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addTag();
                if (
                  e.key === "Backspace" &&
                  !tagInput &&
                  tags.length > 0
                ) {
                  removeTag(tags[tags.length - 1]);
                }
              }}
              placeholder="Add tag..."
              className="text-[13px] bg-transparent border-none outline-none placeholder:text-muted w-[80px]"
            />
          </div>
        </div>
      </div>

      {/* BlockNote Editor */}
      <div className="min-h-[400px]">
        <BlockNoteView
          editor={editor}
          onChange={handleEditorChange}
          theme="light"
        />
      </div>
    </div>
  );
}
