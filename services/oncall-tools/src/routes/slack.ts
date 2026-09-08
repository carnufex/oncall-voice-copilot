import { Hono } from "hono";
import { config, isSlackEnabled } from "../config.js";
import { verifySlackSignature, postThreadMessage, endCall, setLastDrillUserId } from "../slack.js";
import { logger } from "../log.js";
import { commitImageChange, FileDriftedError } from "../github.js";
import { requestArgoCdRefresh } from "../argocd.js";
import { getDeploymentSummary, listPodsForDeployment, summarizePod } from "../k8s.js";
import { listIncidents } from "../store.js";

export const slackRoute = new Hono();

function helpText(): string {
  return [
    "*/oncall drill* — deploy the broken demo-api version to start the demo.",
    "*/oncall reset* — roll demo-api back to the good version and resolve open incidents.",
    "*/oncall status* — show the current demo-api deployment and any open incidents.",
  ].join("\n");
}

async function postToResponseUrl(responseUrl: string | undefined, text: string): Promise<void> {
  if (!responseUrl) return;
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text }),
    });
  } catch (err) {
    logger.warn({ err }, "Failed to post Slack response_url follow-up");
  }
}

async function runDrill(userName: string, responseUrl: string | undefined): Promise<void> {
  try {
    const commit = await commitImageChange({
      fromImage: `${config.demoImage}:${config.demoGoodTag}`,
      toImage: `${config.demoImage}:${config.demoBadTag}`,
      message: `feat(oncall-demo): deploy demo-api ${config.demoBadTag}\n\nDrill triggered from Slack by ${userName}.`,
      authorName: "Release Bot",
      authorEmail: "release-bot@rosenvall.se",
    });
    const refresh = await requestArgoCdRefresh();
    await postToResponseUrl(
      responseUrl,
      refresh.ok
        ? `Deployed demo-api ${config.demoBadTag} (${commit.short_sha}). Watching for the crash…`
        : `Deployed demo-api ${config.demoBadTag} (${commit.short_sha}), but the ArgoCD refresh failed — sync will pick it up within three minutes.`,
    );
  } catch (err) {
    if (err instanceof FileDriftedError) {
      await postToResponseUrl(responseUrl, `demo-api is not currently at ${config.demoGoodTag}; the drill expects a clean starting point. Run \`/oncall status\` to check.`);
      return;
    }
    if ((err as Error).message === "github_disabled") {
      await postToResponseUrl(responseUrl, "GitHub integration is disabled on this deployment (GITHUB_TOKEN not set), the drill cannot commit a deploy.");
      return;
    }
    logger.error({ err }, "drill failed");
    await postToResponseUrl(responseUrl, "The drill failed unexpectedly; check the service logs.");
  }
}

async function runReset(responseUrl: string | undefined): Promise<void> {
  try {
    try {
      const commit = await commitImageChange({
        fromImage: `${config.demoImage}:${config.demoBadTag}`,
        toImage: `${config.demoImage}:${config.demoGoodTag}`,
        message: `revert(oncall-demo): reset demo-api to ${config.demoGoodTag}\n\nReset triggered from Slack.`,
        authorName: "oncall-copilot",
        authorEmail: "oncall-copilot@rosenvall.se",
      });
      logger.info({ commit }, "reset: committed good tag");
    } catch (err) {
      if (err instanceof FileDriftedError) {
        logger.info("reset: demo-api already at the good tag, nothing to commit");
      } else {
        throw err;
      }
    }
    await requestArgoCdRefresh();

    const resolved: string[] = [];
    for (const incident of listIncidents()) {
      if (incident.status === "open" || incident.status === "mitigated") {
        incident.status = "resolved";
        incident.resolved_at = new Date().toISOString();
        incident.action_taken = "reset";
        await postThreadMessage(incident, ":arrows_counterclockwise: Reset from Slack: demo-api rolled back and incident marked resolved.");
        await endCall(incident);
        resolved.push(incident.id);
      }
    }
    await postToResponseUrl(
      responseUrl,
      resolved.length ? `Reset complete. Resolved: ${resolved.join(", ")}.` : "Reset complete. No open incidents to resolve.",
    );
  } catch (err) {
    logger.error({ err }, "reset failed");
    await postToResponseUrl(responseUrl, "Reset failed unexpectedly; check the service logs.");
  }
}

async function buildStatusText(): Promise<string> {
  const deployment = config.allowedDeployments[0] ?? "demo-api";
  const [summary, pods] = await Promise.all([
    getDeploymentSummary(config.k8sNamespace, deployment),
    listPodsForDeployment(config.k8sNamespace, deployment).catch(() => []),
  ]);
  const podLines = pods.map(summarizePod).map((p) => `  - ${p.name}: ${p.state}${p.reason ? ` (${p.reason})` : ""}, ${p.restarts} restarts`);
  const open = listIncidents().filter((i) => i.status === "open" || i.status === "mitigated");
  const openLines = open.map((i) => `  - ${i.id}: ${i.status} (${i.alert.reason})`);
  return [
    `*${deployment}* image: ${summary?.image ?? "unknown"} (${summary?.ready ?? 0}/${summary?.desired ?? 0} ready)`,
    "*Pods:*",
    ...(podLines.length ? podLines : ["  (none)"]),
    "*Open incidents:*",
    ...(openLines.length ? openLines : ["  (none)"]),
  ].join("\n");
}

slackRoute.post("/commands", async (c) => {
  const rawBody = await c.req.text();

  if (!isSlackEnabled()) {
    return c.json({ response_type: "ephemeral", text: "Slack integration is disabled on this deployment (missing SLACK_* env vars)." });
  }

  const timestamp = c.req.header("X-Slack-Request-Timestamp");
  const signature = c.req.header("X-Slack-Signature");
  if (
    !timestamp ||
    !signature ||
    !verifySlackSignature({ signingSecret: config.slackSigningSecret!, timestamp, rawBody, signature })
  ) {
    return c.json({ error: "invalid_signature" }, 401);
  }

  const params = new URLSearchParams(rawBody);
  const text = (params.get("text") ?? "").trim();
  const userName = params.get("user_name") ?? "someone";
  const responseUrl = params.get("response_url") ?? undefined;
  const [sub] = text.split(/\s+/).filter(Boolean);

  switch (sub) {
    case "drill":
      setLastDrillUserId(params.get("user_id") ?? undefined);
      void runDrill(userName, responseUrl);
      return c.json({ response_type: "ephemeral", text: `Starting the drill: deploying demo-api ${config.demoBadTag} …` });
    case "reset":
      void runReset(responseUrl);
      return c.json({ response_type: "ephemeral", text: "Resetting demo-api to a known-good state…" });
    case "status":
      return c.json({ response_type: "ephemeral", text: await buildStatusText() });
    default:
      return c.json({ response_type: "ephemeral", text: helpText() });
  }
});
