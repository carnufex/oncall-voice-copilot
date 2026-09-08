import { useEffect, useRef } from "react";
import type { Incident, PendingAction, TimelineEntry } from "../types.js";
import { KIND_ICON, ExternalLinkIcon } from "./Icons.js";
import { StatusPill } from "./StatusPill.js";
import { minutesAgo, formatDuration, formatTimeOfDay, tokenizeLinks, findLink } from "../utils.js";

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

function renderDetail(text: string) {
  return tokenizeLinks(text).map((part, i) =>
    typeof part === "string" ? (
      <span key={i}>{part}</span>
    ) : (
      <a key={i} href={part.url} target="_blank" rel="noreferrer" className="timeline-link">
        {part.label}
        <ExternalLinkIcon className="timeline-link-icon" />
      </a>
    ),
  );
}

function isExecutedRollback(entry: TimelineEntry): boolean {
  return entry.kind === "action" && (!!findLink(entry.detail, (u) => u.includes("github.com")) || /rollback|rolled back|executed/i.test(entry.title));
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const Icon = KIND_ICON[entry.kind];
  const time = formatTimeOfDay(entry.ts);
  const executed = isExecutedRollback(entry);
  return (
    <li className={`timeline-row timeline-kind-${entry.kind}${executed ? " timeline-executed" : ""}`}>
      <span className="timeline-icon">
        <Icon />
      </span>
      <div className="timeline-row-body">
        <div className="timeline-row-top">
          <span className="timeline-title mono">{entry.title}</span>
          {entry.duration_ms !== undefined && <span className="timeline-duration">{formatDuration(entry.duration_ms)}</span>}
          <span className="timeline-time mono">{time}</span>
        </div>
        {entry.detail && <div className="timeline-detail">{renderDetail(entry.detail)}</div>}
      </div>
    </li>
  );
}

export function Timeline({ incident }: { incident: Incident }) {
  const pending = Object.values(incident.pending_actions);
  const toolCalls = incident.timeline.filter((e) => e.kind === "tool").length;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [incident.timeline.length]);

  return (
    <div className="timeline">
      <div className="timeline-stats">
        <div className="timeline-stat">
          <span className="timeline-stat-value mono">{minutesAgo(incident.opened_at)}</span>
          <span className="timeline-stat-label">min open</span>
        </div>
        <div className="timeline-stat">
          <span className="timeline-stat-value mono">{toolCalls}</span>
          <span className="timeline-stat-label">tool calls</span>
        </div>
        <div className="timeline-stat timeline-stat-status">
          <StatusPill status={incident.status} />
        </div>
      </div>

      <div className="timeline-scroll" ref={scrollRef}>
        {pending.map((action) => (
          <PendingActionCard key={action.action_id} action={action} />
        ))}
        {incident.timeline.length === 0 ? (
          <div className="timeline-empty">Waiting for the first event&hellip;</div>
        ) : (
          <ul className="timeline-list">
            {incident.timeline.map((entry, i) => (
              <TimelineRow key={i} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
