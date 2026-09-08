// Redacts secret-shaped substrings from strings that flow from Kubernetes (logs, events, pod
// specs) out to the LLM / Slack / call page. See docs/SPEC.md section 2.2.
//
// Env vars themselves are never returned by any tool (callers must not include them); this module
// only guards against secrets that leak inside free-text values such as log lines or event
// messages.

type Pattern = { name: string; re: RegExp };

const PATTERNS: Pattern[] = [
  // key=value style secrets: password=..., token=..., secret=..., apikey=...
  { name: "kv-password", re: /\b(password|passwd|pwd)\s*[:=]\s*\S+/gi },
  { name: "kv-token", re: /\b(token|secret|apikey|api_key)\s*[:=]\s*\S+/gi },
  // Authorization: Bearer <token>
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi },
  // Slack tokens: xoxb-, xoxp-, xoxa-, xoxr-, xoxs-
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]+/gi },
  // GitHub tokens
  { name: "github-pat", re: /\bghp_[A-Za-z0-9]+/g },
  { name: "github-fine-pat", re: /\bgithub_pat_[A-Za-z0-9_]+/g },
  // AWS access key ids
  { name: "aws-akia", re: /\bAKIA[0-9A-Z]{16}\b/g },
  // JWT-like: three base64url segments separated by dots, starting with eyJ
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  // URL credentials: scheme://user:pass@host
  { name: "url-creds", re: /:\/\/[^\s/:@]+:[^\s/:@]+@/g },
];

/**
 * Replaces every substring matching a known secret pattern with "[REDACTED]".
 * Safe to call on arbitrary free text (log lines, event messages, etc).
 */
export function redact(input: string): string {
  if (!input) return input;
  let out = input;
  for (const { re } of PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

/** Redacts every string value in an array, preserving order and length. */
export function redactLines(lines: string[]): string[] {
  return lines.map(redact);
}
