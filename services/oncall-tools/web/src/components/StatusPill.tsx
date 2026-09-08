import type { IncidentStatus } from "../types.js";

export function StatusPill({ status }: { status: IncidentStatus }) {
  return <span className={`status-pill status-${status}`}>{status}</span>;
}
