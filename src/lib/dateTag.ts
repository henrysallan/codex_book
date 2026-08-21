/**
 * Date tags for day-container documents.
 *
 * THE BUG THIS FIXES
 * ------------------
 * Day containers (quick notes, daily documents) were tagged with
 * `new Date().toISOString().slice(0, 10)` — a **UTC** date — while their titles
 * used `toLocaleDateString`, a **local** date. In any negative-UTC-offset
 * timezone those disagree during the evening.
 *
 * Concretely, at 6pm on 18 March in US/Pacific: UTC is already the 19th. The
 * lookup asks for a container tagged `2026-03-19`, doesn't find the one created
 * that morning (tagged `2026-03-18`), and creates a second container — titled
 * "Wednesday, March 18, 2026", same as the first. One day, two containers, notes
 * split between them.
 *
 * THE FIX, AND WHY IT READS BOTH TAGS
 * -----------------------------------
 * New containers are tagged with the **local** date, matching their titles. But
 * containers already in the database carry UTC tags, so a lookup that only asked
 * for the local tag would miss them and create duplicates on the changeover day
 * — reintroducing the bug it was meant to fix, once.
 *
 * So `dateTagsForLookup()` returns both candidates and callers match on either,
 * preferring the local one. Writes only ever use the local tag, so the UTC tags
 * age out on their own.
 *
 * iOS matches this behaviour exactly (see CortexQuickNoteService.swift), which is
 * the point — the two clients have to agree on which container "today" means.
 *
 * Pre-existing duplicate containers from before this fix are left alone; they
 * still render, they are just split. Merging them is a manual cleanup.
 */

/** `YYYY-MM-DD` in the runtime's local timezone. */
export function localDateTag(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** `YYYY-MM-DD` in UTC — the legacy tag format, kept for lookups only. */
export function utcDateTag(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Tags that may identify the container for `date`, most-preferred first.
 * Deduplicated, so most of the year this is a single-element array.
 */
export function dateTagsForLookup(date: Date = new Date()): string[] {
  const local = localDateTag(date);
  const utc = utcDateTag(date);
  return local === utc ? [local] : [local, utc];
}

/** The human title a day container carries, e.g. "Wednesday, March 18, 2026". */
export function dayContainerTitle(date: Date = new Date()): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

const DATE_TAG = /^\d{4}-\d{2}-\d{2}$/;

export function isDateTag(value: string): boolean {
  return DATE_TAG.test(value);
}

/**
 * Title for a client-supplied `YYYY-MM-DD` tag.
 *
 * Vercel runs in UTC, so `dayContainerTitle(capturedAt)` would use UTC calendar
 * parts and disagree with the phone's local day. Building the title from the
 * tag itself keeps the folder name on the same civil date the device sent.
 */
export function titleFromDateTag(tag: string): string {
  const [year, month, day] = tag.split("-").map(Number);
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12));
  return noonUtc.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
