import { useState } from "react";
import { CopyIcon, CheckSmallIcon, ExternalLinkIcon } from "./Icons.js";

/**
 * A monospace pill showing an id (incident id / conversation id) with a copy-to-clipboard
 * button and an optional external link. Used in the header, footer and index list so the
 * conversation id is always one click away from the ElevenLabs history page.
 */
export function CopyChip({ value, href, title, variant = "neutral" }: { value: string; href?: string; title?: string; variant?: "neutral" | "accent" }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard API can be unavailable (insecure context, permissions). Fail silently —
      // the id is still visible and selectable as plain text.
    }
  }

  return (
    <span className={`copy-chip copy-chip-${variant}`} title={title}>
      <span className="copy-chip-value mono">{value}</span>
      <button type="button" className="copy-chip-btn" onClick={handleCopy} aria-label={copied ? "Copied" : "Copy to clipboard"}>
        {copied ? <CheckSmallIcon className="copy-chip-icon copy-chip-icon-ok" /> : <CopyIcon className="copy-chip-icon" />}
      </button>
      {href && (
        // A plain <button> rather than an <a> — CopyChip is used inside the index page's
        // card-level <a>, and a nested <a href> there would be invalid HTML (the browser
        // would silently close the outer link). window.open keeps the same new-tab behaviour.
        <button
          type="button"
          className="copy-chip-btn copy-chip-link"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            window.open(href, "_blank", "noopener,noreferrer");
          }}
          aria-label="Open in ElevenLabs"
        >
          <ExternalLinkIcon className="copy-chip-icon" />
        </button>
      )}
    </span>
  );
}
