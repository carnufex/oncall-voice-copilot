import { Hono } from "hono";
import { config, isElevenLabsWebhookEnabled, warnOnce } from "../config.js";
import { verifyElevenLabsSignature } from "../elevenlabs.js";
import { logger } from "../log.js";
import { addTimelineEntry, getIncident, listIncidents } from "../store.js";
import { postThreadMessage, endCall } from "../slack.js";
import { createPostmortemIssue } from "../github.js";
import type { Incident } from "../types.js";

function buildPostmortem(incident: Incident, args: { conversationId: string; summary: string; rootCause: string; actionTaken: string; confirmation: string; evaluation: string; callSuccessful: string }): string {
  const opened = incident.opened_at;
  const resolved = incident.resolved_at ?? "(not resolved on the call)";
  const timeline = incident.timeline
    .map((t) => `| ${t.ts.slice(11, 19)} UTC | ${t.kind} | ${t.title}${t.duration_ms !== undefined ? ` (${t.duration_ms} ms)` : ""} | ${(t.detail ?? "").replace(/\|/g, "\\|")} |`)
    .join("\n");
  const commits = incident.timeline
    .filter((t) => t.kind === "action" && t.title === "rollback" && t.detail)
    .map((t) => `- ${t.detail}`)
    .join("\n");
  return [
    `# Postmortem: ${incident.service} ${incident.alert.reason} (${incident.id})`,
    "",
    `Written by the on-call voice copilot from the call transcript and the incident timeline.`,
    "",
    "## Summary",
    "",
    args.summary,
    "",
    "## Facts",
    "",
    `| | |`,
    `|---|---|`,
    `| Service | \`${incident.service}\` in \`${incident.namespace}\` |`,
    `| Alert | ${incident.alert.reason}: ${incident.alert.message} (pod \`${incident.alert.pod ?? "?"}\`, ${incident.alert.restarts ?? "?"} restarts at detection) |`,
    `| Opened | ${opened} |`,
    `| Resolved | ${resolved} |`,
    `| Root cause | ${args.rootCause} |`,
    `| Action taken | ${args.actionTaken} |`,
    `| Confirmation obtained before acting | ${args.confirmation} |`,
    `| Conversation | \`${args.conversationId}\` |`,
    `| Call successful (ElevenLabs analysis) | ${args.callSuccessful} |`,
    `| Evaluation criteria | ${args.evaluation} |`,
    "",
    "## Changes made",
    "",
    commits || "_none_",
    "",
    "## Timeline",
    "",
    "| Time | Kind | Event | Detail |",
    "|---|---|---|---|",
    timeline,
    "",
    "## Follow-ups",
    "",
    "- [ ] Add the missing configuration to the manifests and redeploy the new version through a pull request.",
    "- [ ] Add a startup config check to CI so a version that needs new configuration cannot be released without it.",
  ].join("\n");
}

export const webhooksRoute = new Hono();

type PostCallTranscriptionPayload = {
  type: string;
  data?: {
    conversation_id?: string;
    status?: string;
    transcript?: { role?: string; message?: string | null }[];
    metadata?: { call_duration_secs?: number; termination_reason?: string };
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

/** "6/6 passed", or "5/6 passed (no_secret_leakage: failure)"; the per-criterion list lives in the postmortem. */
function summarizeEvaluation(results: Record<string, { result?: string } | unknown> | undefined): string {
  if (!results) return "not run";
  const entries = Object.entries(results).map(([id, r]) => {
    const result = typeof r === "object" && r !== null && "result" in r ? String((r as { result?: string }).result ?? "unknown") : "unknown";
    return [id, result] as const;
  });
  if (!entries.length) return "not run";
  const passed = entries.filter(([, r]) => r === "success").length;
  const rest = entries.filter(([, r]) => r !== "success").map(([id, r]) => `${id}: ${r}`);
  return `${passed}/${entries.length} passed${rest.length ? ` (${rest.join(", ")})` : ""}`;
}

function formatDuration(secs: number | undefined): string | undefined {
  if (secs == null || !Number.isFinite(secs)) return undefined;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return m ? `${m} min ${s} s` : `${s} s`;
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

  // A call that failed before anyone spoke (platform error, guardrail misfire, dropped WebRTC)
  // gets a short thread note and no postmortem.
  const spokenTurns = (payload.data?.transcript ?? []).filter((t) => t.message && t.message.trim().length > 0).length;
  if (payload.data?.status === "failed" || spokenTurns < 2) {
    const reason = payload.data?.metadata?.termination_reason ?? payload.data?.status ?? "unknown";
    await postThreadMessage(incident, `:warning: Call \`${payload.data?.conversation_id ?? "unknown"}\` ended before it started (${reason}). No postmortem created.`);
    addTimelineEntry(incident, "call", "Voice call failed", reason.slice(0, 200));
    return;
  }

  const analysis = payload.data?.analysis;
  const summary = analysis?.transcript_summary ?? "(no summary)";
  const callSuccessful = analysis?.call_successful ?? "unknown";
  const dcr = analysis?.data_collection_results ?? {};
  const rootCause = extractField(dcr["root_cause"]);
  const actionTaken = extractField(dcr["action_taken"]);
  const confirmationObtained = extractField(dcr["confirmation_obtained"]);
  const evaluation = formatEvaluation(analysis?.evaluation_criteria_results);
  const conversationId = payload.data?.conversation_id ?? "unknown";

  await endCall(incident);
  addTimelineEntry(incident, "call", "Voice call ended", summary);

  const issue = await createPostmortemIssue({
    title: `Postmortem: ${incident.service} ${incident.alert.reason} (${incident.id})`,
    body: buildPostmortem(incident, {
      conversationId,
      summary,
      rootCause,
      actionTaken,
      confirmation: confirmationObtained,
      evaluation,
      callSuccessful,
    }),
  });
  if (issue) addTimelineEntry(incident, "note", "postmortem", `Issue #${issue.number}: ${issue.url}`);

  // One short thread message. The transcript summary, the per-criterion results and the timeline
  // live in the postmortem issue (and on the call page); the thread only needs the verdict and a link.
  const duration = formatDuration(payload.data?.metadata?.call_duration_secs);
  const lines = [
    `:white_check_mark: Call ended · \`${conversationId}\`${duration ? ` · ${duration}` : ""} · confirmation obtained: ${confirmationObtained}`,
  ];
  if (incident.status !== "resolved") lines.push(`*Root cause:* ${rootCause} · *Action:* ${actionTaken}`);
  lines.push(
    `Evaluation ${summarizeEvaluation(analysis?.evaluation_criteria_results)} · ${issue ? `<${issue.url}|Postmortem #${issue.number}>` : "postmortem not created (GitHub integration disabled)"}`,
  );
  await postThreadMessage(incident, lines.join("\n"));
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
