"use client";

import { useState, useRef, useEffect } from "react";
import { ColumnType, CellValue } from "@/lib/databaseTypes";

interface CellEditorProps {
  type: ColumnType;
  value: CellValue;
  config?: Record<string, unknown>;
  onChange: (newValue: CellValue) => void;
  /** If this is a title cell, the linked document ID */
  docId?: string;
  /** Callback to open a linked document */
  onOpenDoc?: (docId: string) => void;
}

export function CellEditor({ type, value, config, onChange, docId, onOpenDoc }: CellEditorProps) {
  // Title cell: first column with a linked doc
  if (docId && onOpenDoc && type === "text") {
    return <TitleCell value={value as string} onChange={onChange} docId={docId} onOpenDoc={onOpenDoc} />;
  }

  switch (type) {
    case "text":
      return <TextCell value={value as string} onChange={onChange} />;
    case "number":
      return <NumberCell value={value as number | null} onChange={onChange} />;
    case "select":
      return (
        <SelectCell
          value={value as string}
          options={(config?.options as string[]) ?? []}
          onChange={onChange}
          onAddOption={() => {
            // This is handled by parent via config update
          }}
        />
      );
    case "checkbox":
      return <CheckboxCell value={value as boolean} onChange={onChange} />;
    case "date":
      return <DateCell value={value as string | null} onChange={onChange} />;
    default:
      return <TextCell value={String(value ?? "")} onChange={onChange} />;
  }
}

// ─── Text Cell ───

function TextCell({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (!editing) {
    return (
      <span
        className="block w-full cursor-text min-h-[20px] text-sm"
        onClick={() => {
          setDraft(value ?? "");
          setEditing(true);
        }}
      >
        {value || <span className="text-gray-300">Empty</span>}
      </span>
    );
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        onChange(draft);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          onChange(draft);
          setEditing(false);
        }
        if (e.key === "Escape") setEditing(false);
        e.stopPropagation();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      className="w-full bg-transparent outline-none text-sm"
    />
  );
}

// ─── Number Cell ───

function NumberCell({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value != null ? String(value) : "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    const n = parseFloat(draft);
    onChange(isNaN(n) ? null : n);
    setEditing(false);
  };

  if (!editing) {
    return (
      <span
        className="block w-full cursor-text min-h-[20px] text-sm text-right"
        onClick={() => {
          setDraft(value != null ? String(value) : "");
          setEditing(true);
        }}
      >
        {value != null ? value : <span className="text-gray-300">Empty</span>}
      </span>
    );
  }

  return (
    <input
      ref={inputRef}
      type="number"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
        e.stopPropagation();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      className="w-full bg-transparent outline-none text-sm text-right"
    />
  );
}

// ─── Select Cell ───

function SelectCell({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  onAddOption?: (opt: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const hue = (str: string) =>
    [...str].reduce((h, c) => c.charCodeAt(0) + ((h << 5) - h), 0) % 360;

  return (
    <div ref={ref} className="relative" onMouseDown={(e) => e.stopPropagation()}>
      <span
        className="inline-block px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer"
        style={
          value
            ? {
                backgroundColor: `hsl(${hue(value)}, 60%, 92%)`,
                color: `hsl(${hue(value)}, 60%, 30%)`,
              }
            : { color: "#d1d5db" }
        }
        onClick={() => setOpen(!open)}
      >
        {value || "—"}
      </span>
      {open && (
        <div className="absolute z-50 mt-1 bg-white shadow-lg rounded-lg border py-1 min-w-[120px]">
          {options.map((opt) => (
            <button
              key={opt}
              className="block w-full text-left px-3 py-1 hover:bg-gray-100 text-sm"
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
            >
              <span
                className="inline-block px-2 py-0.5 rounded-full text-xs font-medium"
                style={{
                  backgroundColor: `hsl(${hue(opt)}, 60%, 92%)`,
                  color: `hsl(${hue(opt)}, 60%, 30%)`,
                }}
              >
                {opt}
              </span>
            </button>
          ))}
          {options.length === 0 && (
            <span className="block px-3 py-1 text-xs text-gray-400">
              No options yet
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Checkbox Cell ───

function CheckboxCell({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      className="flex justify-center"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={!!value}
        onChange={() => onChange(!value)}
        className="w-4 h-4 cursor-pointer accent-blue-500"
      />
    </div>
  );
}

// ─── Date Cell ───

function DateCell({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <input
      type="date"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className="bg-transparent outline-none text-sm w-full cursor-pointer"
    />
  );
}

// ─── Title Cell (first column — editable name + clickable link to doc) ───

function TitleCell({
  value,
  onChange,
  docId,
  onOpenDoc,
}: {
  value: string;
  onChange: (v: string) => void;
  docId: string;
  onOpenDoc: (docId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (!editing) {
    return (
      <span className="flex items-center gap-1 min-h-[20px] text-sm">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenDoc(docId);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="text-blue-600 hover:text-blue-800 hover:underline truncate text-left"
          title="Open note"
        >
          {value || "Untitled"}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setDraft(value ?? "");
            setEditing(true);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-gray-400 flex-shrink-0 transition-opacity"
          title="Rename"
        >
          ✎
        </button>
      </span>
    );
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        onChange(draft);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          onChange(draft);
          setEditing(false);
        }
        if (e.key === "Escape") setEditing(false);
        e.stopPropagation();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      className="w-full bg-transparent outline-none text-sm"
    />
  );
}
