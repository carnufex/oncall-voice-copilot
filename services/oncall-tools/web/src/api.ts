import type { CommitDiff, Incident, IncidentListEntry, SessionResponse } from "./types.js";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchIncidents(): Promise<IncidentListEntry[]> {
  const res = await fetch("/api/incidents");
  const body = await json<{ incidents: IncidentListEntry[] }>(res);
  return body.incidents;
}

export async function fetchIncident(id: string): Promise<Incident> {
  const res = await fetch(`/api/incidents/${id}`);
  return json<Incident>(res);
}

export async function startSessionForIncident(id: string, mode: "voice" | "text" = "voice"): Promise<SessionResponse> {
  const res = await fetch(`/api/incidents/${id}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  return json<SessionResponse>(res);
}

export async function reportConversationId(id: string, conversationId: string): Promise<void> {
  await fetch(`/api/incidents/${id}/conversation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId }),
  });
}

/** Diff of one commit to the deployment manifest, for the call page's show_diff client tool. */
export async function fetchCommitDiff(incidentId: string, sha: string): Promise<CommitDiff> {
  const res = await fetch(`/api/incidents/${incidentId}/commits/${encodeURIComponent(sha)}/diff`);
  return json<CommitDiff>(res);
}
