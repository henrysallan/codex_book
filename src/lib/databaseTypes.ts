"use client";

// ─── Column types supported in v1 ───

export type ColumnType = "text" | "number" | "select" | "checkbox" | "date";

// ─── Column definition ───

export interface DatabaseColumn {
  id: string;
  name: string;
  type: ColumnType;
  width: number;
  /** Whether this is the title/page-link column (exactly one per database) */
  isTitle?: boolean;
  config?: Record<string, unknown>;
}

// ─── Row ───

export interface DatabaseRow {
  id: string;
  /** Linked document ID — each row is a note */
  docId?: string;
  cells: Record<string, CellValue>;
}

// ─── Cell value ───

export type CellValue = string | number | boolean | null;

// ─── Parse / serialise helpers ───

export function parseColumns(raw: string): DatabaseColumn[] {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function parseRows(raw: string): DatabaseRow[] {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// ─── Type coercion when changing column type ───

export function coerceValue(
  fromType: ColumnType,
  toType: ColumnType,
  value: CellValue,
  config?: Record<string, unknown>
): CellValue {
  if (value === null || value === undefined) return null;
  if (fromType === toType) return value;

  // Convert to text first (canonical intermediate)
  let textVal: string;
  if (typeof value === "boolean") textVal = String(value);
  else if (typeof value === "number") textVal = String(value);
  else textVal = String(value);

  switch (toType) {
    case "text":
      return textVal;
    case "number": {
      const n = parseFloat(textVal);
      return isNaN(n) ? null : n;
    }
    case "checkbox":
      return textVal === "true" || (textVal !== "" && textVal !== "false" && textVal !== "0");
    case "date": {
      const d = new Date(textVal);
      return isNaN(d.getTime()) ? null : textVal;
    }
    case "select": {
      const options = (config?.options as string[]) ?? [];
      return options.includes(textVal) ? textVal : null;
    }
    default:
      return null;
  }
}
