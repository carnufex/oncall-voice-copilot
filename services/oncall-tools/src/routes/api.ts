import { Hono } from "hono";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../log.js";
import { addTimelineEntry, createIncident, getIncident, listIncidents, putIncident } from "../store.js";
import { mintConversationToken, mintSignedUrl } from "../elevenlabs.js";
import { minutesAgo } from "../spoken.js";
import type { Incident } from "../types.js";

export const apiRoute = new Hono();

apiRoute.get("/incidents", (c) => {
  const incidents = listIncidents().map((i) => ({
    id: i.id,
    service: i.service,
    namespace: i.namespace,
    status: i.status,
    opened_at: i.opened_at,
    resolved_at: i.resolved_at,
    alert: i.alert,
    conversation_id: i.conversation_id,
    root_cause: i.root_cause,
  }));
  return c.json({ incidents });
});

apiRoute.get("/incidents/:id", (c) => {
  const incident = getIncident(c.req.param("id"));
  if (!incident) return c.json({ error: "incident_not_found" }, 404);
  return c.json(incident);
});

apiRoute.post("/incidents/:id/session", async (c) => {
  const incident = getIncident(c.req.param("id"));
  if (!incident) return c.json({ error: "incident_not_found" }, 404);

  const requested = await c.req.json().catch(() => ({}));
  const mode = (requested as { mode?: string }).mode === "text" ? "text" : "voice";

  // Text mode = same agent and tools over a signed WebSocket URL, no audio. Used for rehearsal.
  const signedUrl = mode === "text" ? await mintSignedUrl() : undefined;
  const token = mode === "voice" ? await mintConversationToken() : undefined;
  if ((mode === "voice" && !token) || (mode === "text" && !signedUrl)) {
    return c.json({ error: "elevenlabs_disabled" }, 503);
  }

  const openedLocal = new Date(incident.opened_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: config.localTimezone });
  const dynamic_variables: Record<string, string> = {
    incident_id: incident.id,
    service: incident.service,
    namespace: incident.namespace,
    environment: "homelab sandbox cluster",
    alert_reason: incident.alert.reason,
    alert_message: incident.alert.message,
    alert_minutes_ago: String(minutesAgo(incident.opened_at)),
    alert_age: describeAge(minutesAgo(incident.opened_at)),
    engineer_name: config.oncallEngineerName,
    opened_at_local: openedLocal,
  };

  addTimelineEntry(incident, "call", mode === "text" ? "Text session requested" : "Voice call requested");
  return c.json({ mode, conversation_token: token?.conversation_token, signed_url: signedUrl, dynamic_variables });
});

/** "just now" / "about a minute ago" / "about 7 minutes ago" for the agent's opening line. */
function describeAge(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes === 1) return "about a minute ago";
  return `about ${minutes} minutes ago`;
}

const conversationSchema = z.object({ conversation_id: z.string() });

apiRoute.post("/incidents/:id/conversation", async (c) => {
  const incident = getIncident(c.req.param("id"));
  if (!incident) return c.json({ error: "incident_not_found" }, 404);
  const body = conversationSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!body.success) return c.json({ error: "bad_request" }, 400);

  incident.conversation_id = body.data.conversation_id;
  addTimelineEntry(incident, "call", "Session connected");
  return c.json({ ok: true });
});

const devFixtureSchema = z.object({
  service: z.string().optional(),
  status: z.enum(["open", "mitigated", "resolved"]).optional(),
});

// Dev-only: lets the call page and timeline be exercised without a live cluster.
// Enabled only when DEV_FIXTURES=1 (see docs/SPEC.md verification steps).
apiRoute.post("/dev/incidents", async (c) => {
  if (!config.devFixtures) return c.json({ error: "not_found" }, 404);

  const body = devFixtureSchema.safeParse(await c.req.json().catch(() => ({})));
  const service = body.success && body.data.service ? body.data.service : config.allowedDeployments[0] ?? "demo-api";

  const incident = createIncident({
    service,
    namespace: config.k8sNamespace,
    alert: {
      reason: "CrashLoopBackOff",
      message: "back-off 5m0s restarting failed container=demo-api pod=demo-api-6f7d9c8b5-x2z9p",
      pod: "demo-api-6f7d9c8b5-x2z9p",
      restarts: 4,
    },
  });
  addTimelineEntry(incident, "alert", incident.alert.reason, `${incident.alert.pod}: 4 restarts, ${incident.alert.message}`);
  addTimelineEntry(incident, "tool", "get_pod_status", "demo-api at 0/1 ready, image :1.1.0", 420);
  addTimelineEntry(incident, "tool", "get_pod_logs", "1 key error line: FATAL: startup config check failed", 310);
  addTimelineEntry(incident, "tool", "get_recent_changes", "Most recent change 4 minutes ago: deploy demo-api 1.1.0", 260);

  if (body.success && body.data.status && body.data.status !== "open") {
    if (body.data.status === "mitigated" || body.data.status === "resolved") {
      const plan = {
        deployment: incident.service,
        namespace: incident.namespace,
        from_image: `${config.demoImage}:${config.demoBadTag}`,
        to_image: `${config.demoImage}:${config.demoGoodTag}`,
        file: config.gitopsFile,
        branch: config.githubBranch,
        summary: `Roll ${incident.service} back from 1.1.0 to 1.0.0.`,
      };
      addTimelineEntry(
        incident,
        "action",
        "rollback",
        `abc1234: ${plan.summary} https://github.com/${config.githubRepo}/commit/abc1234`,
        890,
      );
      incident.status = "mitigated";
    }
    if (body.data.status === "resolved") {
      incident.status = "resolved";
      incident.resolved_at = new Date().toISOString();
      incident.root_cause = "Missing FEATURE_FLAGS_URL env var in 1.1.0";
      incident.action_taken = "Rolled back to 1.0.0";
      addTimelineEntry(incident, "call", "Voice call ended", "Rolled back demo-api, confirmed healthy.");
    }
  }

  putIncident(incident);
  logger.info({ incident_id: incident.id }, "dev fixture incident created");
  return c.json(incident satisfies Incident, 201);
});
