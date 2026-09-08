import type { Incident, PendingAction, TimelineEntry } from "../types.js";

const KIND_ICON: Record<TimelineEntry["kind"], string> = {
  alert: "\u{1F6A8}", // rotating light
  tool: "\u{1F527}", // wrench
  action: "\u{2705}", // check mark
  note: "\u{1F4DD}", // memo
  call: "\u{1F4DE}", // phone
};

const URL_RE = /(https?:\/\/\S+)/g;

function linkify(text: string): (string | JSX.Element)[] {
  return text.split(URL_RE).map((part, i) =>
    URL_RE.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noreferrer" className="timeline-link">
        {shortenUrl(part)}
      </a>
    ) : (
      part
    ),
  );
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return `${u.hostname}/…/${parts.at(-1) ?? ""}`;
  } catch {
    return url;
  }
}

function PendingActionCard({ action }: { action: PendingAction }) {
  const expired = new Date(action.expires_at).getTime() < Date.now();
  if (action.executed_at || expired) return null;
  const secondsLeft = Math.max(0, Math.round((new Date(action.expires_at).getTime() - Date.now()) / 1000));
  return (
    <div className="pending-action-card">
      <div className="pending-action-title">Awaiting voice confirmation</div>
      <div className="pending-action-summary">{action.plan.summary}</div>
      <div className="pending-action-meta mono">
        {action.plan.from_image.split(":").pop()} &rarr; {action.plan.to_image.split(":").pop()} &middot; expires in {secondsLeft}s
      </div>
    </div>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const time = new Date(entry.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    <li className={`timeline-row timeline-kind-${entry.kind}`}>
      <div className="timeline-row-top">
        <span className="timeline-icon">{KIND_ICON[entry.kind]}</span>
        <span className="timeline-title mono">{entry.title}</span>
        {entry.duration_ms !== undefined && <span className="timeline-duration">{entry.duration_ms}ms</span>}
        <span className="timeline-time">{time}</span>
      </div>
      {entry.detail && <div className="timeline-detail">{linkify(entry.detail)}</div>}
    </li>
  );
}

export function Timeline({ incident }: { incident: Incident }) {
  const pending = Object.values(incident.pending_actions);
  return (
    <div className="timeline">
      <div className="timeline-header">Timeline</div>
      {pending.map((action) => (
        <PendingActionCard key={action.action_id} action={action} />
      ))}
      {incident.timeline.length === 0 ? (
        <div className="timeline-empty">Waiting for the first event…</div>
      ) : (
        <ul className="timeline-list">
          {incident.timeline.map((entry, i) => (
            <TimelineRow key={i} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  );
}
