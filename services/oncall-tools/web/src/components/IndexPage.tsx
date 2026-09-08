import { useEffect, useState } from "react";
import { fetchIncidents } from "../api.js";
import type { IncidentListEntry } from "../types.js";
import { StatusPill } from "./StatusPill.js";

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

      {!incidents && !error && <div className="index-empty">Loading…</div>}

      {incidents && incidents.length === 0 && (
        <div className="index-empty">
          No incidents yet. Run <code>/oncall drill</code> in Slack, or wait for the detector.
        </div>
      )}

      {incidents && incidents.length > 0 && (
        <ul className="incident-list">
          {incidents.map((incident) => (
            <li key={incident.id}>
              <a className="incident-row" href={`/call/${incident.id}`}>
                <span className="incident-row-id mono">{incident.id}</span>
                <span className="incident-row-service">{incident.service}</span>
                <span className="incident-row-ns mono">{incident.namespace}</span>
                <span className="incident-row-reason">{incident.alert.reason}</span>
                <StatusPill status={incident.status} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
