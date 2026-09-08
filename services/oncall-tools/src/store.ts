import { randomBytes } from "node:crypto";
import type { Incident, PendingAction, RollbackPlan, TimelineEntry, TimelineEntryKind } from "./types.js";

// In-memory incident store. Documented limitation: state is lost on restart; this is a demo
// service with a single replica (see docs/SPEC.md section 2).

const incidents = new Map<string, Incident>();

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomAlnum(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ID_ALPHABET[bytes[i]! % ID_ALPHABET.length];
  }
  return out;
}

export function generateIncidentId(): string {
  return `inc_${randomAlnum(10)}`;
}

export function generateActionId(): string {
  return randomBytes(6).toString("hex"); // 12 hex chars
}

export function createIncident(input: {
  service: string;
  namespace: string;
  alert: Incident["alert"];
}): Incident {
  const now = new Date().toISOString();
  const incident: Incident = {
    id: generateIncidentId(),
    service: input.service,
    namespace: input.namespace,
    status: "open",
    opened_at: now,
    alert: input.alert,
    timeline: [],
    pending_actions: {},
  };
  incidents.set(incident.id, incident);
  return incident;
}

/** Inserts an incident object directly (used by dev fixtures). Overwrites by id. */
export function putIncident(incident: Incident): Incident {
  incidents.set(incident.id, incident);
  return incident;
}

export function getIncident(id: string): Incident | undefined {
  return incidents.get(id);
}

export function listIncidents(): Incident[] {
  return [...incidents.values()].sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1));
}

/** Finds an incident for `service` that is still open or mitigated (used by the detector). */
export function findActiveIncidentForService(service: string): Incident | undefined {
  for (const incident of incidents.values()) {
    if (incident.service === service && (incident.status === "open" || incident.status === "mitigated")) {
      return incident;
    }
  }
  return undefined;
}

export function addTimelineEntry(
  incident: Incident,
  kind: TimelineEntryKind,
  title: string,
  detail?: string,
  duration_ms?: number,
): TimelineEntry {
  const entry: TimelineEntry = {
    ts: new Date().toISOString(),
    kind,
    title,
    ...(detail !== undefined ? { detail: detail.slice(0, 200) } : {}),
    ...(duration_ms !== undefined ? { duration_ms } : {}),
  };
  incident.timeline.push(entry);
  return entry;
}

export function createPendingAction(
  incident: Incident,
  plan: RollbackPlan,
  ttlMs: number,
): PendingAction {
  const now = Date.now();
  const action: PendingAction = {
    action_id: generateActionId(),
    type: "rollback",
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
    plan,
  };
  incident.pending_actions[action.action_id] = action;
  return action;
}

export type ExecuteActionResult =
  | { ok: true; action: PendingAction }
  | { ok: false; error: "action_not_found" | "action_expired" | "action_already_executed" };

/**
 * Enforces the one-shot / TTL contract for propose_action -> execute_action (SPEC 2.4/2.2):
 * the action must exist, be unexpired, and not already have been executed. On success it is
 * marked executed in place so a second call always fails with action_already_executed.
 */
export function tryExecutePendingAction(incident: Incident, actionId: string): ExecuteActionResult {
  const action = incident.pending_actions[actionId];
  if (!action) return { ok: false, error: "action_not_found" };
  if (action.executed_at) return { ok: false, error: "action_already_executed" };
  if (new Date(action.expires_at).getTime() < Date.now()) return { ok: false, error: "action_expired" };
  action.executed_at = new Date().toISOString();
  return { ok: true, action };
}

/**
 * Un-marks an action as executed after a failed side effect (e.g. the GitHub commit failed with
 * file_drifted), so a retry with the same action_id can succeed before it expires.
 */
export function revertPendingActionExecution(incident: Incident, actionId: string): void {
  const action = incident.pending_actions[actionId];
  if (action) delete action.executed_at;
}

/** Test-only: clears all incidents so tests don't leak state across cases. */
export function __resetStoreForTests() {
  incidents.clear();
}
