# Database Block — Column Types & Cell Editors

## Overview

Each column has a `type` that determines:
1. How the cell **displays** its value
2. How the cell **edits** its value (input widget)
3. How sorting compares values

All types share a common `CellEditor` component that switches on type.

---

## `CellEditor` component (`src/components/database/CellEditor.tsx`)

```tsx
interface CellEditorProps {
  type: ColumnType;
  value: CellValue;
  config?: Record<string, unknown>;
  onChange: (newValue: CellValue) => void;
}

export function CellEditor({ type, value, config, onChange }: CellEditorProps) {
  switch (type) {
    case "text":     return <TextCell     value={value as string}  onChange={onChange} />;
    case "number":   return <NumberCell   value={value as number}  onChange={onChange} />;
    case "select":   return <SelectCell   value={value as string}  options={(config?.options as string[]) ?? []} onChange={onChange} />;
    case "checkbox": return <CheckboxCell value={value as boolean} onChange={onChange} />;
    case "date":     return <DateCell     value={value as string}  onChange={onChange} />;
    default:         return <TextCell     value={String(value ?? "")} onChange={onChange} />;
  }
}
```

---

## Type specifications

### 1. Text (`"text"`)

**Storage**: `string`

**Display**: Plain text, truncated with ellipsis if too long.

**Edit**: Click to activate an `<input type="text">`. Blur or Enter to commit.

```tsx
function TextCell({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  if (!editing) {
    return (
      <span className="block w-full cursor-text" onClick={() => { setDraft(value ?? ""); setEditing(true); }}>
        {value || <span className="text-gray-300">Empty</span>}
      </span>
    );
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { onChange(draft); setEditing(false); }}
      onKeyDown={(e) => { if (e.key === "Enter") { onChange(draft); setEditing(false); } if (e.key === "Escape") setEditing(false); }}
      onMouseDown={(e) => e.stopPropagation()}
      className="w-full bg-transparent outline-none"
    />
  );
}
```

**Sort**: Lexicographic (default TanStack string sort).

---

### 2. Number (`"number"`)

**Storage**: `number | null`

**Display**: Right-aligned number.

**Edit**: `<input type="number">`, same click-to-edit pattern.

```tsx
function NumberCell({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  // Same editing pattern as TextCell but with:
  // - type="number"
  // - parseFloat on commit (NaN → null)
  // - right-aligned text
}
```

**Sort**: Numeric sort (TanStack auto-detects).

---

### 3. Select (`"select"`)

**Storage**: `string` (one of `config.options`)

**Display**: Coloured pill/badge.

**Edit**: Click to show a dropdown of options. Clicking an option commits immediately.

```tsx
function SelectCell({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);

  // Pill colour: derive a stable hue from the option string
  const hue = (str: string) => [...str].reduce((h, c) => c.charCodeAt(0) + ((h << 5) - h), 0) % 360;

  return (
    <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
      <span
        className="inline-block px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer"
        style={{ backgroundColor: `hsl(${hue(value || "")}, 60%, 92%)`, color: `hsl(${hue(value || "")}, 60%, 30%)` }}
        onClick={() => setOpen(!open)}
      >
        {value || "—"}
      </span>
      {open && (
        <div className="absolute z-50 mt-1 bg-white shadow-lg rounded-lg border py-1 min-w-[120px]">
          {options.map((opt) => (
            <button key={opt} className="block w-full text-left px-3 py-1 hover:bg-gray-100 text-sm"
              onClick={() => { onChange(opt); setOpen(false); }}>
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

**Sort**: Alphabetical on the string value.

---

### 4. Checkbox (`"checkbox"`)

**Storage**: `boolean`

**Display**: Centred checkbox icon.

**Edit**: Single click toggles.

```tsx
function CheckboxCell({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex justify-center" onMouseDown={(e) => e.stopPropagation()}>
      <input
        type="checkbox"
        checked={!!value}
        onChange={() => onChange(!value)}
        className="w-4 h-4 cursor-pointer accent-blue-500"
      />
    </div>
  );
}
```

**Sort**: `false` < `true`.

---

### 5. Date (`"date"`)

**Storage**: ISO-8601 string (`"2025-07-15"`) or `null`.

**Display**: Formatted date string (e.g. "Jul 15, 2025").

**Edit**: Native `<input type="date">` — simple, accessible, no extra deps.

```tsx
function DateCell({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return (
    <input
      type="date"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      onMouseDown={(e) => e.stopPropagation()}
      className="bg-transparent outline-none text-sm w-full cursor-pointer"
    />
  );
}
```

**Sort**: Lexicographic on ISO string (which sorts chronologically).

---

## Column Menu — changing types

When the user changes a column's type, existing cell values are **best-effort
coerced**:

| From → To   | Coercion                                              |
|-------------|-------------------------------------------------------|
| text → number | `parseFloat(val)`, `NaN` → `null`                  |
| text → checkbox | `"true"` / non-empty → `true`, else `false`      |
| text → date | If ISO-parseable keep, else `null`                    |
| number → text | `String(val)`                                       |
| checkbox → text | `"true"` / `"false"`                              |
| date → text | Keep ISO string as-is                                 |
| * → select | Keep value if it matches an option, else `null`        |

This is implemented as a `coerceValue(from, to, value, config)` utility in
`databaseTypes.ts`.
