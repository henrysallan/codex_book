/**
 * Minimal YAML subset parser for Markdown frontmatter.
 * Supports:
 *   key: value
 *   key: [a, b, c]
 *   key: followed by indented `- item` lines
 *   quoted values, `#` comments outside quotes
 * Anything else is ignored rather than throwing.
 */

export function parseFrontmatter(text: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const source = text.replace(/^\uFEFF/, "");
  if (!/^---\r?\n/.test(source)) {
    return { meta: {}, body: text };
  }

  const rest = source.replace(/^---\r?\n/, "");
  const close = rest.match(/\r?\n---(?:\r?\n|$)/);
  if (!close || close.index === undefined) {
    return { meta: {}, body: text };
  }

  const yaml = rest.slice(0, close.index);
  let body = rest.slice(close.index + close[0].length);
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (body.startsWith("\n")) body = body.slice(1);
  return { meta: parseYamlSubset(yaml), body };
}

function parseYamlSubset(yaml: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const kv = matchKeyLine(line);
    if (!kv) {
      i++;
      continue;
    }

    const { key, rawValue } = kv;
    if (rawValue === "") {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        const listMatch = next.match(/^\s+-\s+(.*)$/);
        if (listMatch) {
          items.push(unquote(stripComment(listMatch[1])));
          j++;
          continue;
        }
        if (!next.trim() || next.trim().startsWith("#")) {
          j++;
          continue;
        }
        break;
      }
      if (items.length > 0) {
        meta[key] = items;
        i = j;
        continue;
      }
      meta[key] = "";
      i++;
      continue;
    }

    meta[key] = parseScalar(rawValue);
    i++;
  }

  return meta;
}

function matchKeyLine(
  line: string
): { key: string; rawValue: string } | null {
  if (/^\s/.test(line)) return null;
  const m = line.match(/^([A-Za-z_][\w-]*)\s*:(.*)$/);
  if (!m) return null;
  return { key: m[1], rawValue: m[2].trim() };
}

function parseScalar(raw: string): unknown {
  const stripped = stripComment(raw).trim();
  if (stripped.startsWith("[") && stripped.endsWith("]")) {
    return parseInlineArray(stripped);
  }
  return unquote(stripped);
}

function stripComment(s: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === "#" && !inSingle && !inDouble) return s.slice(0, i);
  }
  return s;
}

function unquote(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function parseInlineArray(s: string): string[] {
  const inner = s.slice(1, -1);
  if (!inner.trim()) return [];
  const items: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      current += c;
    } else if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      current += c;
    } else if (c === "," && !inSingle && !inDouble) {
      items.push(unquote(current));
      current = "";
    } else {
      current += c;
    }
  }
  if (current.trim()) items.push(unquote(current));
  return items;
}

export function metaString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

export function metaStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}
