import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "../config.js";
import { verifyToolToken } from "../auth.js";
import { logger } from "../log.js";
import { redact, redactLines } from "../redact.js";
import {
  addTimelineEntry,
  createPendingAction,
  getIncident,
  revertPendingActionExecution,
  tryExecutePendingAction,
} from "../store.js";
import type { Incident, TimelineEntryKind } from "../types.js";
import {
  getDeploymentSummary,
  getPodLogs,
  listEventsForDeployment,
  listPodsForDeployment,
  listReplicaSetsForDeployment,
  summarizePod,
} from "../k8s.js";
import { commitImageChange, extractImageLine, FileDriftedError, listRecentImageCommits } from "../github.js";
import { requestArgoCdRefresh } from "../argocd.js";
import { postThreadMessage, endCall } from "../slack.js";
import { countPhrase, minutesAgo } from "../spoken.js";

export const toolsRoute = new Hono();

toolsRoute.use("*", async (c, next) => {
  if (!verifyToolToken(c.req.header("X-Oncall-Token"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

function resolveIncident(id: unknown): { ok: true; incident: Incident } | { ok: false; status: 404 | 403; body: { error: string } } {
  if (typeof id !== "string" || !id) {
    return { ok: false, status: 404, body: { error: "incident_not_found" } };
  }
  const incident = getIncident(id);
  if (!incident) {
    return { ok: false, status: 404, body: { error: "incident_not_found" } };
  }
  if (incident.namespace !== config.k8sNamespace || !config.allowedDeployments.includes(incident.service)) {
    return { ok: false, status: 403, body: { error: "not_allowed" } };
  }
  return { ok: true, incident };
}

/** Wraps a tool handler: resolves+allowlists the incident, times the call, and appends a
 * timeline entry (SPEC 2.4: "Every call appends a `tool` timeline entry with duration."). */
function tool<Body>(
  name: string,
  schema: z.ZodType<Body>,
  handler: (incident: Incident, body: Body) => Promise<{ status?: number; json: Record<string, unknown>; timeline?: { kind: TimelineEntryKind; title: string; detail?: string } }>,
) {
  return async (c: Context) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "bad_request", details: parsed.error.issues }, 400);
    }
    const body = parsed.data as { incident_id: string };
    const resolved = resolveIncident(body.incident_id);
    if (!resolved.ok) return c.json(resolved.body, resolved.status);
    const { incident } = resolved;

    const startedAt = Date.now();
    try {
      const result = await handler(incident, parsed.data);
      const duration_ms = Date.now() - startedAt;
      const entry = result.timeline ?? { kind: "tool" as TimelineEntryKind, title: name, detail: String(result.json.spoken_summary ?? "") };
      addTimelineEntry(incident, entry.kind, entry.title, entry.detail, duration_ms);
      return c.json(result.json, (result.status ?? 200) as 200);
    } catch (err) {
      logger.error({ err, tool: name, incident_id: incident.id }, "tool handler failed");
      return c.json({ error: "internal_error" }, 500);
    }
  };
}

const incidentIdSchema = z.object({ incident_id: z.string() });

toolsRoute.post(
  "/get_incident",
  tool("get_incident", incidentIdSchema, async (incident) => {
    const minutes_open = minutesAgo(incident.opened_at);
    return {
      json: {
        id: incident.id,
        service: incident.service,
        namespace: incident.namespace,
        status: incident.status,
        opened_at: incident.opened_at,
        minutes_open,
        alert: incident.alert,
        spoken_summary: `${incident.service} has been ${incident.status === "open" ? "down" : incident.status} for ${countPhrase(minutes_open, "minute")}. ${redact(incident.alert.message)}`,
      },
    };
  }),
);

toolsRoute.post(
  "/get_pod_status",
  tool("get_pod_status", incidentIdSchema, async (incident) => {
    const [deployment, pods] = await Promise.all([
      getDeploymentSummary(incident.namespace, incident.service),
      listPodsForDeployment(incident.namespace, incident.service),
    ]);
    const podSummaries = pods.map(summarizePod).map((p) => ({
      ...p,
      reason: p.reason ? redact(p.reason) : p.reason,
      message: p.message ? redact(p.message) : p.message,
    }));
    const badPod = podSummaries.find((p) => p.state === "waiting");
    const badImage = pods.find((p) => p.metadata?.name === badPod?.name)?.spec?.containers?.[0]?.image;
    const survivor = podSummaries.find((p) => p.state === "running" && p.ready && p.name !== badPod?.name);
    const survivorImage = pods.find((p) => p.metadata?.name === survivor?.name)?.spec?.containers?.[0]?.image;
    let spoken_summary: string;
    if (!deployment) {
      spoken_summary = `Could not read the ${incident.service} deployment.`;
    } else if (badPod && survivor && badImage && survivorImage && badImage !== survivorImage) {
      spoken_summary = `The rollout of ${incident.service} to version ${imageTag(badImage)} is stuck: the new pod is in ${badPod.reason ?? "a waiting state"} with ${countPhrase(badPod.restarts, "restart")}, while the previous pod on version ${imageTag(survivorImage)} is still running and serving traffic.`;
    } else if (badPod) {
      spoken_summary = `${incident.service} is at ${deployment.ready} of ${deployment.desired} pods ready on version ${imageTag(deployment.image)}. The pod is in ${badPod.reason ?? badPod.state} with ${countPhrase(badPod.restarts, "restart")}.`;
    } else {
      spoken_summary = `${incident.service} is at ${deployment.ready} of ${deployment.desired} pods ready on version ${imageTag(deployment.image)}, no pods waiting.`;
    }
    return {
      json: {
        deployment: deployment ?? { name: incident.service, image: "unknown", desired: 0, ready: 0, updated: 0, available: 0 },
        pods: podSummaries,
        spoken_summary,
      },
    };
  }),
);

toolsRoute.post(
  "/get_recent_events",
  tool("get_recent_events", incidentIdSchema.extend({ limit: z.number().int().positive().max(15).optional() }), async (incident, body) => {
    const limit = Math.min(body.limit ?? 15, 15);
    const events = await listEventsForDeployment(incident.namespace, incident.service, limit);
    const redacted = events.map((e) => ({ ...e, message: redact(e.message) }));
    const spoken_summary = redacted.length
      ? `${countPhrase(redacted.length, "recent event")}, most recent: ${redacted[0]!.reason} on ${redacted[0]!.object}.`
      : "No recent events found.";
    return { json: { events: redacted, spoken_summary } };
  }),
);

toolsRoute.post(
  "/get_pod_logs",
  tool("get_pod_logs", incidentIdSchema.extend({ lines: z.number().int().positive().max(60).optional() }), async (incident, body) => {
    const pods = await listPodsForDeployment(incident.namespace, incident.service);
    const target = pods.find((p) => p.metadata?.name === incident.alert.pod) ?? pods[0];
    if (!target) {
      return { json: { pod: incident.alert.pod ?? "unknown", container: "unknown", source: "current", lines: [], key_lines: [], spoken_summary: "No pods found to read logs from." } };
    }
    const container = target.spec?.containers?.[0]?.name;
    const cs = target.status?.containerStatuses?.[0];
    const usePrevious = cs?.state?.waiting?.reason === "CrashLoopBackOff";
    const tailLines = Math.min(body.lines ?? 60, 60);

    let rawLogs = "";
    try {
      rawLogs = await getPodLogs(incident.namespace, target.metadata?.name ?? "", container, { previous: usePrevious, tailLines });
    } catch (err) {
      logger.warn({ err }, "get_pod_logs: readNamespacedPodLog failed, retrying without previous");
      if (usePrevious) {
        rawLogs = await getPodLogs(incident.namespace, target.metadata?.name ?? "", container, { previous: false, tailLines }).catch(() => "");
      }
    }

    let lines = rawLogs.split("\n").filter((l) => l.length > 0).slice(0, 60);
    lines = redactLines(lines);
    // Cap total size at 6 KB.
    let sizeBudget = 6 * 1024;
    const capped: string[] = [];
    for (const line of lines) {
      const size = Buffer.byteLength(line, "utf8") + 1;
      if (sizeBudget - size < 0) break;
      sizeBudget -= size;
      capped.push(line);
    }
    const key_lines = capped.filter((l) => /FATAL|ERROR|panic|exception/i.test(l)).slice(0, 5);

    const spoken_summary = key_lines.length
      ? `Found ${countPhrase(key_lines.length, "key error line")} in the ${usePrevious ? "previous crashed" : "current"} container's logs. Top one: ${key_lines[0]}`
      : `Read ${countPhrase(capped.length, "log line")} from the ${usePrevious ? "previous crashed" : "current"} container, nothing obviously fatal stood out.`;

    return {
      json: {
        pod: target.metadata?.name ?? "unknown",
        container: container ?? "unknown",
        source: usePrevious ? "previous" : "current",
        lines: capped,
        key_lines,
        spoken_summary,
      },
    };
  }),
);

toolsRoute.post(
  "/get_recent_changes",
  tool("get_recent_changes", incidentIdSchema, async (incident) => {
    const [commitsRaw, replicasets] = await Promise.all([
      listRecentImageCommits(5).catch((err) => {
        logger.warn({ err }, "get_recent_changes: GitHub disabled or failed");
        return [];
      }),
      listReplicaSetsForDeployment(incident.namespace, incident.service).catch(() => []),
    ]);
    const commits = commitsRaw.map((c) => ({
      sha: c.sha,
      short_sha: c.short_sha,
      author: c.author,
      date: c.date,
      minutes_ago: c.date ? minutesAgo(c.date) : 0,
      message: c.message,
      image_before: c.image_before,
      image_after: c.image_after,
      url: c.url,
    }));
    const rsSummaries = replicasets.map((rs) => ({ name: rs.name, image: rs.image, created: rs.created, replicas: rs.replicas, ready: rs.ready }));
    const last = commits[0];
    const newestRs = rsSummaries[0];
    const previousRs = rsSummaries.find((rs) => rs.image !== newestRs?.image);
    const rsPhrase = newestRs && previousRs
      ? ` The ReplicaSet history shows the current rollout moved from version ${imageTag(previousRs.image)} to version ${imageTag(newestRs.image)}, created ${countPhrase(minutesAgo(newestRs.created), "minute")} ago.`
      : "";
    const spoken_summary = last
      ? `The most recent change was ${countPhrase(last.minutes_ago, "minute")} ago by ${last.author}: ${last.message}.${
          last.image_before && last.image_after && last.image_before !== last.image_after
            ? ` It changed the image from version ${imageTag(last.image_before)} to ${imageTag(last.image_after)}.`
            : ""
        }`
      : `Git commit history is not available right now.${rsPhrase}`;
    return { json: { file: config.gitopsFile, commits, replicasets: rsSummaries, spoken_summary } };
  }),
);

toolsRoute.post(
  "/propose_action",
  tool("propose_action", incidentIdSchema.extend({ action: z.literal("rollback"), reason: z.string() }), async (incident) => {
    const [deployment, replicasets, commits] = await Promise.all([
      getDeploymentSummary(incident.namespace, incident.service),
      listReplicaSetsForDeployment(incident.namespace, incident.service).catch(() => []),
      listRecentImageCommits(5).catch(() => []),
    ]);
    const fromImage = deployment?.image ?? `${config.demoImage}:${config.demoBadTag}`;
    const alternative = replicasets.find((rs) => rs.image && rs.image !== fromImage);
    const toImage = alternative?.image ?? commits.find((c) => c.image_before && c.image_before !== fromImage)?.image_before;

    if (!toImage) {
      return { status: 409, json: { error: "no_rollback_target" } };
    }

    const plan = {
      deployment: incident.service,
      namespace: incident.namespace,
      from_image: fromImage,
      to_image: toImage,
      file: config.gitopsFile,
      branch: config.githubBranch,
      summary: `Roll ${incident.service} back from ${fromImage} to ${toImage}.`,
    };
    const action = createPendingAction(incident, plan, config.actionTtlMs);
    const expires_in_seconds = Math.round(config.actionTtlMs / 1000);
    const spoken_summary = `Plan, not executed yet: roll ${incident.service} back from version ${imageTag(fromImage)} to version ${imageTag(toImage)} by committing the previous image to the deployment manifest on ${plan.branch}; ArgoCD will apply it. Read this to the engineer and ask for a yes or no. The plan expires in ${countPhrase(Math.round(expires_in_seconds / 60), "minute")}.`;
    return {
      json: {
        action_id: action.action_id,
        action: "rollback",
        plan: { from_image: plan.from_image, to_image: plan.to_image, file: plan.file, branch: plan.branch },
        summary: plan.summary,
        expires_in_seconds,
        requires_confirmation: true,
        spoken_summary,
      },
      timeline: { kind: "action" as TimelineEntryKind, title: "proposed rollback", detail: `Awaiting voice confirmation: ${plan.summary}` },
    };
  }),
);

toolsRoute.post(
  "/execute_action",
  tool(
    "execute_action",
    incidentIdSchema.extend({ action_id: z.string(), confirmation: z.string().optional() }),
    async (incident, body) => {
      if (body.confirmation !== "confirmed") {
        return { status: 400, json: { error: "confirmation_required" } };
      }
      const attempt = tryExecutePendingAction(incident, body.action_id);
      if (!attempt.ok) {
        const status = attempt.error === "action_not_found" ? 404 : attempt.error === "action_expired" ? 410 : 409;
        return { status, json: { error: attempt.error } };
      }
      const { plan } = attempt.action;

      try {
        const commit = await commitImageChange({
          fromImage: plan.from_image,
          toImage: plan.to_image,
          message: `revert(oncall-demo): roll back ${incident.service} to ${plan.to_image.split(":").pop()}\n\nIncident ${incident.id}. Approved by voice by ${config.oncallEngineerName} via the on-call copilot.\nAction ${attempt.action.action_id}.`,
          authorName: "oncall-copilot",
          authorEmail: "oncall-copilot@rosenvall.se",
        });

        const refresh = await requestArgoCdRefresh();
        const spoken_summary = refresh.ok
          ? `Rollback committed to Git as ${commit.short_sha}, going back to version ${imageTag(plan.to_image)}. ArgoCD has been asked to sync now; verify health next.`
          : `Rollback committed to Git as ${commit.short_sha}. The ArgoCD refresh did not trigger, so the sync will pick it up within three minutes.`;

        return {
          json: { status: "executed", commit, spoken_summary },
          timeline: { kind: "action" as TimelineEntryKind, title: "rollback", detail: `${commit.short_sha}: ${plan.summary} ${commit.url}` },
        };
      } catch (err) {
        revertPendingActionExecution(incident, body.action_id);
        if (err instanceof FileDriftedError) {
          return { status: 409, json: { error: "file_drifted", spoken_summary: "The manifest no longer contains the image I planned to replace, so I did not commit anything. Someone else may have changed it; let me re-check the status." } };
        }
        if ((err as Error).message === "github_disabled") {
          return { status: 503, json: { error: "github_disabled", spoken_summary: "I could not commit the rollback: the GitHub integration is not configured on this deployment. Nothing was changed." } };
        }
        throw err;
      }
    },
  ),
);

toolsRoute.post(
  "/verify_health",
  tool("verify_health", incidentIdSchema.extend({ wait_seconds: z.number().int().positive().max(90).optional() }), async (incident, body) => {
    const waitSeconds = Math.min(Math.max(body.wait_seconds ?? 60, 0), 90);
    const deadline = Date.now() + waitSeconds * 1000;
    const pollIntervalMs = 3000;

    // If a rollback was executed, health also requires the deployment to be on the target image.
    const executed = Object.values(incident.pending_actions)
      .filter((a) => a.executed_at)
      .sort((a, b) => (a.executed_at! < b.executed_at! ? 1 : -1))[0];
    const expectedImage = executed?.plan.to_image;

    let deployment = await getDeploymentSummary(incident.namespace, incident.service);
    let pods = await listPodsForDeployment(incident.namespace, incident.service);
    let healthy = isHealthy(deployment, pods, expectedImage);
    const startedAt = Date.now();

    while (!healthy && Date.now() < deadline) {
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
      deployment = await getDeploymentSummary(incident.namespace, incident.service);
      pods = await listPodsForDeployment(incident.namespace, incident.service);
      healthy = isHealthy(deployment, pods, expectedImage);
    }

    if (healthy && incident.status === "open") {
      incident.status = "mitigated";
    }

    const restarts_recent = pods.reduce((sum, p) => sum + (p.status?.containerStatuses?.[0]?.restartCount ?? 0), 0);
    const checked_for_seconds = Math.round((Date.now() - startedAt) / 1000);
    const waitingPod = pods.map(summarizePod).find((p) => p.state === "waiting");
    const spoken_summary = healthy
      ? `Healthy: ${deployment?.ready ?? 0} of ${deployment?.desired ?? 0} pods ready on version ${imageTag(deployment?.image ?? "unknown")}, with ${countPhrase(restarts_recent, "restart")} on the current pod.`
      : `Not healthy yet after ${countPhrase(checked_for_seconds, "second")}: ${deployment?.ready ?? 0} of ${deployment?.desired ?? 0} pods ready, deployment on version ${imageTag(deployment?.image ?? "unknown")}${expectedImage ? `, expected ${imageTag(expectedImage)}` : ""}${waitingPod ? `, a pod is still in ${waitingPod.reason ?? "waiting"}` : ""}.`;

    return {
      json: {
        healthy,
        image: deployment?.image ?? "unknown",
        desired: deployment?.desired ?? 0,
        ready: deployment?.ready ?? 0,
        restarts_recent,
        checked_for_seconds,
        spoken_summary,
      },
    };
  }),
);

function isHealthy(
  deployment: Awaited<ReturnType<typeof getDeploymentSummary>>,
  pods: Awaited<ReturnType<typeof listPodsForDeployment>>,
  expectedImage?: string,
): boolean {
  if (!deployment) return false;
  if (expectedImage && deployment.image !== expectedImage) return false;
  if (deployment.ready !== deployment.desired || deployment.desired === 0) return false;
  if (deployment.updated !== deployment.desired) return false;
  return !pods.some((p) => p.status?.containerStatuses?.some((cs) => cs.state?.waiting));
}

/** "registry/org/app:1.1.0" -> "1.1.0" (spoken summaries never read out the registry path). */
function imageTag(image: string): string {
  if (!image.includes(":")) return image;
  return image.split(":").pop() ?? image;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

toolsRoute.post(
  "/resolve_incident",
  tool("resolve_incident", incidentIdSchema.extend({ root_cause: z.string(), action_taken: z.string() }), async (incident, body) => {
    incident.root_cause = body.root_cause;
    incident.action_taken = body.action_taken;
    incident.status = "resolved";
    incident.resolved_at = new Date().toISOString();

    await postThreadMessage(incident, `:white_check_mark: Incident resolved.\n*Root cause:* ${redact(body.root_cause)}\n*Action taken:* ${redact(body.action_taken)}`);
    await endCall(incident);

    return { json: { status: "resolved", spoken_summary: `Marked resolved. Root cause: ${redact(body.root_cause)}.` } };
  }),
);

toolsRoute.post(
  "/add_note",
  tool("add_note", incidentIdSchema.extend({ note: z.string() }), async (incident, body) => {
    await postThreadMessage(incident, `:memo: ${redact(body.note)}`);
    return {
      json: { ok: true, spoken_summary: `Noted: ${redact(body.note)}` },
      timeline: { kind: "note" as TimelineEntryKind, title: "note", detail: redact(body.note) },
    };
  }),
);

