import type { Incident, IncidentListEntry, SessionResponse } from "./types.js";

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

export async function startSessionForIncident(id: string): Promise<SessionResponse> {
  const res = await fetch(`/api/incidents/${id}/session`, { method: "POST" });
  return json<SessionResponse>(res);
}

export async function reportConversationId(id: string, conversationId: string): Promise<void> {
  await fetch(`/api/incidents/${id}/conversation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId }),
  });
}
