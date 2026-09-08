import { Hono } from "hono";
import { config, isElevenLabsWebhookEnabled, warnOnce } from "../config.js";
import { verifyElevenLabsSignature } from "../elevenlabs.js";
import { logger } from "../log.js";
import { addTimelineEntry, getIncident, listIncidents } from "../store.js";
import { postThreadMessage, endCall } from "../slack.js";
import type { Incident } from "../types.js";

export const webhooksRoute = new Hono();

type PostCallTranscriptionPayload = {
  type: string;
  data?: {
    conversation_id?: string;
    conversation_initiation_client_data?: { dynamic_variables?: Record<string, unknown> };
    analysis?: {
      transcript_summary?: string;
      call_successful?: string;
      data_collection_results?: Record<string, { value?: unknown } | unknown>;
      evaluation_criteria_results?: Record<string, { result?: string; rationale?: string } | unknown>;
    };
  };
};

function findIncidentForConversation(payload: PostCallTranscriptionPayload): Incident | undefined {
  const conversationId = payload.data?.conversation_id;
  if (conversationId) {
    const byId = listIncidents().find((i) => i.conversation_id === conversationId);
    if (byId) return byId;
  }
  const dynamicIncidentId = payload.data?.conversation_initiation_client_data?.dynamic_variables?.["incident_id"];
  if (typeof dynamicIncidentId === "string") {
    return getIncident(dynamicIncidentId);
  }
  return undefined;
}

function extractField(value: unknown): string {
  if (value == null) return "unknown";
  if (typeof value === "object" && value !== null && "value" in value) {
    const v = (value as { value?: unknown }).value;
    return v == null ? "unknown" : String(v);
  }
  return String(value);
}

function formatEvaluation(results: Record<string, { result?: string } | unknown> | undefined): string {
  if (!results) return "none";
  const parts = Object.entries(results).map(([criterion, r]) => {
    const result = typeof r === "object" && r !== null && "result" in r ? String((r as { result?: string }).result ?? "unknown") : "unknown";
    return `${criterion} → ${result}`;
  });
  return parts.length ? parts.join(", ") : "none";
}

async function handlePostCallTranscription(payload: PostCallTranscriptionPayload): Promise<void> {
  const incident = findIncidentForConversation(payload);
  if (!incident) {
    logger.warn({ conversation_id: payload.data?.conversation_id }, "post-call webhook: no matching incident");
    return;
  }
  if (payload.data?.conversation_id && !incident.conversation_id) {
    incident.conversation_id = payload.data.conversation_id;
  }

  const analysis = payload.data?.analysis;
  const summary = analysis?.transcript_summary ?? "(no summary)";
  const callSuccessful = analysis?.call_successful ?? "unknown";
  const dcr = analysis?.data_collection_results ?? {};
  const rootCause = extractField(dcr["root_cause"]);
  const actionTaken = extractField(dcr["action_taken"]);
  const confirmationObtained = extractField(dcr["confirmation_obtained"]);
  const evaluation = formatEvaluation(analysis?.evaluation_criteria_results);

  const text = [
    `:white_check_mark: Call ended — conversation \`${payload.data?.conversation_id ?? "unknown"}\``,
    `*Summary:* ${summary}`,
    `*Root cause:* ${rootCause} | *Action:* ${actionTaken} | *Confirmation obtained:* ${confirmationObtained}`,
    `*Evaluation:* ${evaluation}`,
    `*Call successful:* ${callSuccessful}`,
  ].join("\n");

  await postThreadMessage(incident, text);
  await endCall(incident);
  addTimelineEntry(incident, "call", "Voice call ended", summary);
}

webhooksRoute.post("/elevenlabs/post-call", async (c) => {
  const rawBody = await c.req.text();

  if (!isElevenLabsWebhookEnabled()) {
    warnOnce("elevenlabs-webhook-disabled", "Post-call webhook received but ELEVENLABS_WEBHOOK_SECRET is not set; ignoring", logger);
    return c.json({ ok: true });
  }

  const header = c.req.header("ElevenLabs-Signature");
  if (!header || !verifyElevenLabsSignature({ secret: config.elevenlabsWebhookSecret!, header, rawBody })) {
    return c.json({ error: "invalid_signature" }, 401);
  }

  let payload: PostCallTranscriptionPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "bad_request" }, 400);
  }

  if (payload.type !== "post_call_transcription") {
    return c.json({ ok: true });
  }

  // Respond fast; do the Slack/store work after responding.
  void handlePostCallTranscription(payload).catch((err) => logger.error({ err }, "post-call webhook processing failed"));
  return c.json({ ok: true });
});
