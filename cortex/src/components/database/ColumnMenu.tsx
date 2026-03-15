"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { DatabaseColumn, ColumnType } from "@/lib/databaseTypes";
import { ChevronDown, Trash2, Type, Hash, CheckSquare, Calendar, List } from "lucide-react";

const COLUMN_TYPES: { type: ColumnType; label: string; icon: React.ReactNode }[] = [
  { type: "text", label: "Text", icon: <Type size={14} /> },
  { type: "number", label: "Number", icon: <Hash size={14} /> },
  { type: "select", label: "Select", icon: <List size={14} /> },
  { type: "checkbox", label: "Checkbox", icon: <CheckSquare size={14} /> },
  { type: "date", label: "Date", icon: <Calendar size={14} /> },
];

interface ColumnMenuProps {
  column: DatabaseColumn;
  onRename: (newName: string) => void;
  onTypeChange: (newType: ColumnType) => void;
  onDelete: () => void;
  onAddOption?: (option: string) => void;
}

export function ColumnMenu({
  column,
  onRename,
  onTypeChange,
  onDelete,
  onAddOption,
}: ColumnMenuProps) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(column.name);
  const [showTypeMenu, setShowTypeMenu] = useState(false);
  const [showAddOption, setShowAddOption] = useState(false);
  const [newOption, setNewOption] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  // Position the dropdown relative to the button using fixed coords
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, left: rect.left });
    }
  }, [open]);

  // Close on outside click — check both the menu wrapper and the portal dropdown
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current && !menuRef.current.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
        setOpen(false);
        setShowTypeMenu(false);
        setShowAddOption(false);
        setRenaming(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  useEffect(() => {
    if (renaming) renameRef.current?.focus();
  }, [renaming]);

  const commitRename = () => {
    const trimmed = renameDraft.trim();
    if (trimmed && trimmed !== column.name) {
      onRename(trimmed);
    }
    setRenaming(false);
  };

  return (
    <div ref={menuRef} className="relative inline-flex">
      <button
        ref={btnRef}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
          setShowTypeMenu(false);
          setShowAddOption(false);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="p-0.5 rounded hover:bg-gray-200 transition-colors"
      >
        <ChevronDown size={12} />
      </button>

      {open && createPortal(
        <div
          ref={dropdownRef}
          className="fixed bg-white shadow-lg rounded-lg border py-1 min-w-[160px]"
          style={{ zIndex: 99999, top: menuPos.top, left: menuPos.left }}
        >
          {/* Rename */}
          {renaming ? (
            <div className="px-2 py-1">
              <input
                ref={renameRef}
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setRenaming(false);
                  e.stopPropagation();
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className="w-full text-sm px-2 py-1 border rounded outline-none focus:border-blue-400"
              />
            </div>
          ) : (
            <button
              className="block w-full text-left px-3 py-1.5 hover:bg-gray-100 text-sm"
              onClick={(e) => {
                e.stopPropagation();
                setRenameDraft(column.name);
                setRenaming(true);
              }}
            >
              Rename
            </button>
          )}

          {/* Change type */}
          <button
            className="block w-full text-left px-3 py-1.5 hover:bg-gray-100 text-sm"
            onClick={(e) => {
              e.stopPropagation();
              setShowTypeMenu(!showTypeMenu);
            }}
          >
            Type: {COLUMN_TYPES.find((t) => t.type === column.type)?.label}
          </button>
          {showTypeMenu && (
            <div className="border-t border-b my-1 py-1">
              {COLUMN_TYPES.map((ct) => (
                <button
                  key={ct.type}
                  className={`flex items-center gap-2 w-full text-left px-3 py-1 text-sm ${
                    ct.type === column.type
                      ? "bg-blue-50 text-blue-600"
                      : "hover:bg-gray-100"
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTypeChange(ct.type);
                    setShowTypeMenu(false);
                    setOpen(false);
                  }}
                >
                  {ct.icon}
                  {ct.label}
                </button>
              ))}
            </div>
          )}

          {/* Add option (select type only) */}
          {column.type === "select" && (
            <>
              {showAddOption ? (
                <div className="px-2 py-1">
                  <input
                    value={newOption}
                    onChange={(e) => setNewOption(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newOption.trim()) {
                        onAddOption?.(newOption.trim());
                        setNewOption("");
                        setShowAddOption(false);
                      }
                      if (e.key === "Escape") setShowAddOption(false);
                      e.stopPropagation();
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    placeholder="Option name..."
                    className="w-full text-sm px-2 py-1 border rounded outline-none focus:border-blue-400"
                    autoFocus
                  />
                </div>
              ) : (
                <button
                  className="block w-full text-left px-3 py-1.5 hover:bg-gray-100 text-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowAddOption(true);
                  }}
                >
                  + Add option
                </button>
              )}
            </>
          )}

          {/* Delete */}
          <button
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-red-50 text-sm text-red-600"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
              setOpen(false);
            }}
          >
            <Trash2 size={12} />
            Delete column
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}
