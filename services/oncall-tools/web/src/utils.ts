// Shared formatting helpers for the call console UI. No backend/contract types here.

export function minutesAgo(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function formatTimeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Truncates text to at most `max` chars, breaking on a word boundary where possible. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return `${s % 1 === 0 ? s.toFixed(0) : s.toFixed(1)}s`;
}

const URL_RE = /(https?:\/\/\S+)/g;
// Non-global, anchored twin used to test individual split fragments — reusing the global
// URL_RE for .test() would carry lastIndex state across calls and silently skip matches.
const URL_RE_FULL = /^https?:\/\/\S+$/;

export type ExtractedLink = { url: string; label: string };

/** Classifies a URL into a short human label (commit / postmortem / ticket / generic host). */
export function describeLink(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    if (u.hostname.includes("github.com") && path.includes("/commit/")) return "View commit";
    if (u.hostname.includes("github.com")) return "View on GitHub";
    if (path.includes("postmortem") || u.hostname.includes("notion.so") || u.hostname.includes("docs.google")) return "Postmortem";
    if (u.hostname.includes("atlassian.net") || u.hostname.includes("linear.app") || path.includes("/browse/")) return "Ticket";
    const parts = path.split("/").filter(Boolean);
    return `${u.hostname}/…/${parts.at(-1) ?? ""}`;
  } catch {
    return url;
  }
}

/** Finds the first URL in text matching a predicate (e.g. github commit links). */
export function findLink(text: string | undefined, predicate: (url: string) => boolean): string | undefined {
  if (!text) return undefined;
  const matches = text.match(URL_RE);
  return matches?.find(predicate);
}

export function findAnyLink(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const matches = text.match(URL_RE);
  return matches?.[0];
}

/** Splits text on URLs, returning an array of plain strings and {url,label} link tokens. */
export function tokenizeLinks(text: string): (string | ExtractedLink)[] {
  const parts = text.split(URL_RE);
  return parts.filter(Boolean).map((part) => (URL_RE_FULL.test(part) ? { url: part, label: describeLink(part) } : part));
}
