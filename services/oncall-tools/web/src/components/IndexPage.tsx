import { useEffect, useState } from "react";
import { fetchIncidents } from "../api.js";
import type { IncidentListEntry } from "../types.js";
import { StatusPill } from "./StatusPill.js";
import { CopyChip } from "./CopyChip.js";
import { minutesAgo, truncate } from "../utils.js";

export function IndexPage() {
  const [incidents, setIncidents] = useState<IncidentListEntry[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchIncidents()
      .then((list) => !cancelled && setIncidents(list))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="index-page">
      <header className="index-header">
        <div className="brand">On-call Voice Copilot</div>
        <div className="index-subtitle">Incidents opened by the CrashLoop detector</div>
      </header>

      {error && <div className="banner banner-error">{error}</div>}

      {!incidents && !error && <div className="index-empty">Loading&hellip;</div>}

      {incidents && incidents.length === 0 && (
        <div className="index-empty">
          <div className="index-empty-title">No incidents yet</div>
          <div className="index-empty-body">
            Run <code>/oncall drill</code> in Slack to start one.
          </div>
        </div>
      )}

      {incidents && incidents.length > 0 && (
        <ul className="incident-cards">
          {incidents.map((incident) => (
            <li key={incident.id}>
              <a className="incident-card" href={`/call/${incident.id}`}>
                <div className="incident-card-top">
                  <span className="incident-card-service">{incident.service}</span>
                  <StatusPill status={incident.status} />
                </div>
                <div className="incident-card-reason">{incident.alert.reason}</div>
                <div className="incident-card-meta">
                  <span className="mono">{incident.namespace}</span>
                  <span>Opened {minutesAgo(incident.opened_at)} min ago</span>
                </div>
                {incident.status === "resolved" && incident.root_cause && (
                  <div className="incident-card-root-cause">
                    <span className="incident-card-root-cause-label">Root cause</span>
                    {truncate(incident.root_cause, 120)}
                  </div>
                )}
                <div className="incident-card-bottom">
                  <span className="incident-card-id mono">{incident.id}</span>
                  {incident.conversation_id && (
                    <CopyChip
                      value={incident.conversation_id}
                      href={`https://elevenlabs.io/app/agents/history/${incident.conversation_id}`}
                      title="Conversation id"
                    />
                  )}
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
