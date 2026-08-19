"use client";

/**
 * Utilities for anchoring PDF text selections so highlights survive re-opens.
 *
 * Strategy: store page number + exact selected text + ~30 chars of prefix/suffix.
 * On reload, walk the text layer spans on each page to find the match.
 */

import type { TextAnchor, PdfAnnotation } from "@/lib/types";

// ── Building an anchor from a selection ───────────────────────────────

/**
 * Build a TextAnchor from the current browser Selection inside a react-pdf
 * text layer. Returns null if the selection is empty or outside a page.
 */
export function anchorFromSelection(selection: Selection): {
  anchor: TextAnchor;
  rects: DOMRect[];
} | null {
  if (!selection || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  const exact = selection.toString().trim();
  if (!exact) return null;

  // Walk up to find the page container (react-pdf adds data-page-number)
  const pageEl = findPageElement(range.startContainer);
  if (!pageEl) return null;
  const pageNumber = parseInt(pageEl.getAttribute("data-page-number") ?? "0", 10);
  if (!pageNumber) return null;

  // Get the full text of the page's text layer to extract prefix/suffix
  const textLayer = pageEl.querySelector(".textLayer");
  if (!textLayer) return null;
  const fullText = textLayer.textContent ?? "";
  const idx = fullText.indexOf(exact);

  let prefix: string | undefined;
  let suffix: string | undefined;
  if (idx >= 0) {
    prefix = fullText.slice(Math.max(0, idx - 30), idx);
    suffix = fullText.slice(idx + exact.length, idx + exact.length + 30);
  }

  // Collect all client rects for the selection
  const rects = Array.from(range.getClientRects());

  return {
    anchor: { pageNumber, exact, prefix, suffix },
    rects,
  };
}

// ── Resolving anchors to DOM positions ────────────────────────────────

export interface ResolvedHighlight {
  annotation: PdfAnnotation;
  rects: DOMRect[];       // positions relative to the page container
  pageElement: HTMLElement;
}

/**
 * For a given annotation, find the matching text in the rendered text layer
 * and return the bounding rects (relative to the page container).
 */
export function resolveAnchor(
  annotation: PdfAnnotation,
  pagesContainer: HTMLElement
): ResolvedHighlight | null {
  const { anchor } = annotation;
  const pageEl = pagesContainer.querySelector(
    `[data-page-number="${anchor.pageNumber}"]`
  ) as HTMLElement | null;
  if (!pageEl) return null;

  const textLayer = pageEl.querySelector(".textLayer");
  if (!textLayer) return null;

  // Find the range in the text layer
  const range = findTextInNode(textLayer, anchor.exact, anchor.prefix, anchor.suffix);
  if (!range) return null;

  const pageRect = pageEl.getBoundingClientRect();
  const rawRects = Array.from(range.getClientRects());

  // Convert to page-relative positions
  const rects = rawRects.map(
    (r) =>
      new DOMRect(
        r.x - pageRect.x,
        r.y - pageRect.y,
        r.width,
        r.height
      )
  );

  return { annotation, rects, pageElement: pageEl };
}

// ── Internal helpers ──────────────────────────────────────────────────

function findPageElement(node: Node): HTMLElement | null {
  let el: Node | null = node;
  while (el) {
    if (
      el instanceof HTMLElement &&
      el.hasAttribute("data-page-number") &&
      el.classList.contains("react-pdf__Page")
    ) {
      return el;
    }
    el = el.parentNode;
  }
  return null;
}

/**
 * Walk text nodes inside `root` to find the Range covering `exact`.
 * Uses prefix/suffix context for disambiguation when the same text appears
 * multiple times on a page.
 */
function findTextInNode(
  root: Node,
  exact: string,
  prefix?: string,
  suffix?: string
): Range | null {
  // Collect all text nodes
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    textNodes.push(node);
  }

  // Build a concatenated string with offset tracking
  const chunks: { node: Text; start: number }[] = [];
  let fullText = "";
  for (const tn of textNodes) {
    chunks.push({ node: tn, start: fullText.length });
    fullText += tn.textContent ?? "";
  }

  // Find all occurrences of `exact` in the full text
  const candidates: number[] = [];
  let searchStart = 0;
  while (true) {
    const idx = fullText.indexOf(exact, searchStart);
    if (idx < 0) break;
    candidates.push(idx);
    searchStart = idx + 1;
  }

  if (candidates.length === 0) return null;

  // Score each candidate by prefix/suffix match
  let bestIdx = candidates[0];
  let bestScore = -1;

  for (const idx of candidates) {
    let score = 0;
    if (prefix) {
      const before = fullText.slice(Math.max(0, idx - prefix.length), idx);
      score += commonSuffixLength(prefix, before);
    }
    if (suffix) {
      const after = fullText.slice(idx + exact.length, idx + exact.length + suffix.length);
      score += commonPrefixLength(suffix, after);
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  }

  // Build a Range from bestIdx .. bestIdx + exact.length
  const range = document.createRange();
  const startOffset = bestIdx;
  const endOffset = bestIdx + exact.length;

  // Find start node/offset
  const startInfo = offsetToNodePosition(chunks, startOffset);
  const endInfo = offsetToNodePosition(chunks, endOffset);
  if (!startInfo || !endInfo) return null;

  range.setStart(startInfo.node, startInfo.offset);
  range.setEnd(endInfo.node, endInfo.offset);
  return range;
}

function offsetToNodePosition(
  chunks: { node: Text; start: number }[],
  offset: number
): { node: Text; offset: number } | null {
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (offset >= chunks[i].start) {
      const localOffset = offset - chunks[i].start;
      const len = chunks[i].node.textContent?.length ?? 0;
      return { node: chunks[i].node, offset: Math.min(localOffset, len) };
    }
  }
  return null;
}

function commonSuffixLength(a: string, b: string): number {
  let count = 0;
  let ai = a.length - 1;
  let bi = b.length - 1;
  while (ai >= 0 && bi >= 0 && a[ai] === b[bi]) {
    count++;
    ai--;
    bi--;
  }
  return count;
}

function commonPrefixLength(a: string, b: string): number {
  let count = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] === b[i]) count++;
    else break;
  }
  return count;
}
