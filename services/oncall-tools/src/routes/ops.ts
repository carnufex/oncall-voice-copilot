import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { config } from "../config.js";
import { requireDrillBearer } from "../auth.js";
import { logger } from "../log.js";
import { listRecentImageCommits } from "../github.js";
import { goodImage, resolveOpenIncidents, restoreGoodTag, tagOf } from "../drill.js";

// GET /ops/changes and POST /ops/rollback: what an agent in Lots (the homelab-ops context's incident
// investigation) may read and ask for. Lots' tool pack calls them in the cluster
// (oncall-tools.oncall-demo.svc:8080) with `Authorization: Bearer <DRILL_API_TOKEN>`, the drill's bearer.
// Lots holds the rollback until a person approves it there; this service takes the bearer to mean that it
// was approved. /ops/ is not one of the public route's unauthenticated prefixes (/tools/, /slack/,
// /webhooks/, /healthz), so from outside the cluster these sit behind oauth2-proxy (SSO) as well. Without
// DRILL_API_TOKEN both answer 404. The OpenAPI document Lots loads is openapi/ops.json; keep the two in step.
//
// The only write: the service goes back to DEMO_GOOD_TAG through the reset's own function (restoreGoodTag).
// Which tag is healthy comes from configuration, never from the request.

export const opsRoute = new Hono();

opsRoute.use("*", requireDrillBearer("ops"));

/** At most this many commits are listed. */
const MAX_CHANGES = 10;
/** The reason's length in the commit message. */
const REASON_MAX = 200;

function knownService(service: unknown): service is string {
  return typeof service === "string" && config.allowedDeployments.includes(service);
}

/**
 * The reason as one line of plain text for the commit message: control characters (newlines included),
 * line and paragraph separators and bidirectional overrides become spaces, runs of white space one space,
 * at most 200 characters. It is written by a model, so it must not be able to add lines or trailers.
 */
export function sanitizeReason(reason: string): string {
  const flat = reason
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(flat).slice(0, REASON_MAX).join("").trim();
}

opsRoute.get("/changes", async (c) => {
  const service = c.req.query("service");
  if (!knownService(service)) {
    return c.json({ error: "unknown_service", message: `Unknown service. Known: ${config.allowedDeployments.join(", ")}.` }, 404);
  }
  try {
    const commits = await listRecentImageCommits(MAX_CHANGES);
    const changes = commits.map((commit) => {
      const changedImage = commit.image_after !== undefined && commit.image_before !== commit.image_after;
      return {
        commit: commit.short_sha,
        time: commit.date,
        author: commit.author,
        message: commit.message,
        ...(changedImage ? { image_from: commit.image_before ? tagOf(commit.image_before) : null, image_to: tagOf(commit.image_after) } : {}),
      };
    });
    logger.info({ service, count: changes.length }, "ops: listed recent changes");
    return c.json({ service, file: config.gitopsFile, branch: config.githubBranch, changes });
  } catch (err) {
    const disabled = (err as Error).message === "github_disabled";
    logger.error({ err: disabled ? "github_disabled" : err, service }, "ops: listing recent changes failed");
    return c.json(
      {
        error: disabled ? "github_disabled" : "github_failed",
        message: disabled ? "GitHub is not configured on oncall-tools." : "Reading the commit history from GitHub failed.",
      },
      502,
    );
  }
});

const rollbackBody = z.object({ service: z.string(), reason: z.string() });

opsRoute.post("/rollback", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "body_too_large" }, 413) }), async (c) => {
  const parsed = rollbackBody.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) {
    return c.json({ error: "bad_request", message: 'The body is {"service": "<name>", "reason": "<why>"}.' }, 400);
  }
  const { service } = parsed.data;
  if (!knownService(service)) {
    return c.json({ error: "unknown_service", message: `Unknown service. Only ${config.allowedDeployments.join(", ")} can be rolled back.` }, 404);
  }
  const reason = sanitizeReason(parsed.data.reason) || "(none given)";
  const good = config.demoGoodTag;
  const bad = config.demoBadTag;
  const message = `revert(oncall-demo): roll back ${service} to ${good}\n\nApproved in Lots: proposed by the incident investigation, approved by a person.\nReason: ${reason}`;

  let result;
  try {
    result = await restoreGoodTag(message);
  } catch (err) {
    const disabled = (err as Error).message === "github_disabled";
    logger.error({ err: disabled ? "github_disabled" : err, service }, "ops: rollback failed, nothing committed");
    return c.json(
      {
        service,
        from: bad,
        to: good,
        commit: null,
        error: disabled ? "github_disabled" : "commit_failed",
        message: disabled ? "Nothing was committed: GitHub is not configured on oncall-tools." : "Nothing was committed: the commit to GitHub failed.",
      },
      502,
    );
  }

  const later = result.refreshed
    ? "ArgoCD is rolling it out; the pods show it in about a minute."
    : "The ArgoCD refresh failed, so the sync picks it up within three minutes.";
  if (result.commit) {
    const resolved = await resolveOpenIncidents(
      `:rewind: Rolled back from Lots after a person approved it: ${service} is going back to ${good} and the incident is marked resolved.`,
    );
    logger.info({ service, from: bad, to: good, commit: result.commit.short_sha, refreshed: result.refreshed, resolved, reason }, "ops: rollback committed");
    return c.json({
      service,
      from: bad,
      to: good,
      commit: result.commit.short_sha,
      message: `Committed ${result.commit.short_sha}: ${service} goes from ${bad} back to ${good}. ${later}`,
    });
  }
  if (result.currentImage === goodImage()) {
    const resolved = await resolveOpenIncidents(
      `:rewind: Rolled back from Lots after a person approved it: ${service} is on ${good} and the incident is marked resolved.`,
    );
    logger.info({ service, resolved }, "ops: rollback asked for, already on the good tag");
    return c.json({ service, from: good, to: good, commit: null, message: `${service} is already on ${good}; nothing was committed.` });
  }
  // Neither the bad nor the good tag: someone else changed the file. Roll back nothing, resolve nothing.
  const current = tagOf(result.currentImage);
  logger.warn({ service, current }, "ops: rollback refused, file_drifted");
  return c.json(
    {
      service,
      from: current,
      to: good,
      commit: null,
      error: "file_drifted",
      message: `Nothing was committed: ${service} is on ${current}, neither ${bad} nor ${good}; a person has to look.`,
    },
    409,
  );
});
