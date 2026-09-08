import type { CommitDiff, CommitDiffFile } from "../types.js";
import { CloseIcon, ExternalLinkIcon } from "./Icons.js";
import { minutesAgo } from "../utils.js";

type DiffLineKind = "add" | "del" | "hunk" | "context";

function classifyLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "context";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

function DiffFileBlock({ file }: { file: CommitDiffFile }) {
  const lines = file.patch ? file.patch.split("\n") : [];
  return (
    <div className="diff-file">
      <div className="diff-file-header">
        <span className="diff-file-name mono">{file.filename}</span>
        <span className="diff-file-status">{file.status}</span>
        <span className="diff-file-stats mono">
          <span className="diff-file-additions">+{file.additions}</span>
          <span className="diff-file-deletions">&minus;{file.deletions}</span>
        </span>
      </div>
      {lines.length === 0 ? (
        <div className="diff-file-empty">No patch content for this file.</div>
      ) : (
        <pre className="diff-file-patch mono">
          {lines.map((line, i) => {
            const kind = classifyLine(line);
            const flagged = kind !== "hunk" && line.includes("image:");
            return (
              <div key={i} className={`diff-line diff-line-${kind}${flagged ? " diff-line-flagged" : ""}`}>
                {line.length === 0 ? " " : line}
              </div>
            );
          })}
        </pre>
      )}
    </div>
  );
}

export function DiffCard({ diff, onDismiss }: { diff: CommitDiff; onDismiss: () => void }) {
  const firstLine = diff.message.split("\n")[0] ?? diff.message;

  return (
    <div className="diff-card">
      <div className="diff-card-header">
        <div className="diff-card-header-top">
          <span className="diff-card-label">Change under review</span>
          <button type="button" className="diff-card-dismiss" onClick={onDismiss} aria-label="Dismiss diff">
            <CloseIcon />
          </button>
        </div>
        <div className="diff-card-meta">
          <a className="diff-card-sha mono" href={diff.url} target="_blank" rel="noreferrer" title="View commit on GitHub">
            {diff.short_sha}
            <ExternalLinkIcon className="diff-card-sha-icon" />
          </a>
          <span className="diff-card-author">{diff.author}</span>
          {diff.date && <span className="diff-card-time">{minutesAgo(diff.date)} min ago</span>}
        </div>
        <div className="diff-card-message">{firstLine}</div>
      </div>

      <div className="diff-card-body">
        {diff.files.length === 0 ? (
          <div className="diff-file-empty">No manifest changes in this commit.</div>
        ) : (
          diff.files.map((file) => <DiffFileBlock key={file.filename} file={file} />)
        )}
      </div>
    </div>
  );
}
