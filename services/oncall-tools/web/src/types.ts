// Mirrors services/oncall-tools/src/types.ts (docs/SPEC.md section 2.3). Field names are a
// contract with the backend and must not be renamed.

export type IncidentStatus = "open" | "mitigated" | "resolved";
export type TimelineEntryKind = "alert" | "tool" | "action" | "note" | "call";

export type TimelineEntry = {
  ts: string;
  kind: TimelineEntryKind;
  title: string;
  detail?: string;
  duration_ms?: number;
};

export type RollbackPlan = {
  deployment: string;
  namespace: string;
  from_image: string;
  to_image: string;
  file: string;
  branch: string;
  summary: string;
};

export type PendingAction = {
  action_id: string;
  type: "rollback";
  created_at: string;
  expires_at: string;
  executed_at?: string;
  plan: RollbackPlan;
};

export type Incident = {
  id: string;
  service: string;
  namespace: string;
  status: IncidentStatus;
  opened_at: string;
  resolved_at?: string;
  alert: { reason: string; message: string; pod?: string; restarts?: number };
  conversation_id?: string;
  root_cause?: string;
  action_taken?: string;
  timeline: TimelineEntry[];
  pending_actions: Record<string, PendingAction>;
};

export type IncidentListEntry = Pick<
  Incident,
  "id" | "service" | "namespace" | "status" | "opened_at" | "resolved_at" | "alert" | "conversation_id" | "root_cause"
>;

export type SessionResponse = {
  mode: "voice" | "text";
  conversation_token?: string;
  signed_url?: string;
  dynamic_variables: Record<string, string>;
};
