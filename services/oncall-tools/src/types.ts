// Data model. See docs/SPEC.md section 2.3. Field names are a contract with the call page and
// must not be renamed.

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

export type IncidentAlert = {
  reason: string;
  message: string;
  pod?: string;
  restarts?: number;
};

export type IncidentSlack = {
  channel: string;
  thread_ts: string;
  call_id?: string;
};

export type Incident = {
  id: string;
  service: string;
  namespace: string;
  status: IncidentStatus;
  opened_at: string;
  resolved_at?: string;
  alert: IncidentAlert;
  slack?: IncidentSlack;
  conversation_id?: string;
  root_cause?: string;
  action_taken?: string;
  timeline: TimelineEntry[];
  pending_actions: Record<string, PendingAction>;
};
