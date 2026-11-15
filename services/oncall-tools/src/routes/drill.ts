import { Hono } from "hono";
import { config } from "../config.js";
import { verifyBearer } from "../auth.js";
import { logger } from "../log.js";
import { badImage, breakDemoApi, goodImage, resetDemoApi } from "../drill.js";

// POST /drill/break and /drill/reset: what `/oncall drill` and `/oncall reset` do, for a Lots alert
// source's drill button. Lots calls them in the cluster (oncall-tools.oncall-demo.svc:8080) with
// `Authorization: Bearer <DRILL_API_TOKEN>`; the body (`{"source": ...}`) is ignored. /drill/ is not one
// of the public route's unauthenticated prefixes (/tools/, /slack/, /webhooks/, /healthz), so from outside
// the cluster these sit behind oauth2-proxy (SSO) as well as the bearer. Without DRILL_API_TOKEN both
// answer 404: the feature is off.
//
// The answer is one line of plain text a person reads under the button: never a token, never what
// GitHub answered.

export const drillRoute = new Hono();

drillRoute.use("*", async (c, next) => {
  const expected = config.drillApiToken;
  if (!expected) return c.json({ error: "not_found" }, 404);
  if (!verifyBearer(c.req.header("Authorization"), expected)) {
    logger.warn({ path: c.req.path }, "drill: refused, wrong or missing bearer");
    return c.text("Unauthorized.", 401);
  }
  await next();
});

function tagOf(image: string | undefined): string {
  if (!image) return "no image line";
  return image.startsWith(`${config.demoImage}:`) ? image.slice(config.demoImage.length + 1) : image;
}

drillRoute.post("/break", async (c) => {
  try {
    const result = await breakDemoApi("Drill triggered from Lots.");
    if (result.kind === "committed") {
      logger.info({ commit: result.commit.short_sha, refreshed: result.refreshed }, "drill (Lots): committed the bad tag");
      return c.text(
        result.refreshed
          ? `demo-api ${config.demoBadTag} is committed (${result.commit.short_sha}); ArgoCD is rolling it out.`
          : `demo-api ${config.demoBadTag} is committed (${result.commit.short_sha}); the ArgoCD refresh failed, so the sync picks it up within three minutes.`,
        200,
      );
    }
    if (result.kind === "drifted" && result.currentImage === badImage()) {
      logger.info("drill (Lots): demo-api already on the bad tag, nothing to commit");
      return c.text(`demo-api is already on ${config.demoBadTag}.`, 200);
    }
    if (result.kind === "drifted") {
      logger.warn({ current: tagOf(result.currentImage) }, "drill (Lots): file_drifted");
      return c.text(`demo-api is on ${tagOf(result.currentImage)}, not ${config.demoGoodTag}; the drill expects a clean starting point (file_drifted).`, 502);
    }
    logger.warn("drill (Lots): GitHub integration disabled");
    return c.text("GitHub integration is disabled on this deployment (GITHUB_TOKEN not set); the drill cannot commit.", 502);
  } catch (err) {
    logger.error({ err }, "drill (Lots) failed");
    return c.text("The commit to GitHub failed (commit_failed); check the oncall-tools logs.", 502);
  }
});

drillRoute.post("/reset", async (c) => {
  try {
    const result = await resetDemoApi("Lots");
    const resolved = result.resolved.length ? ` Resolved: ${result.resolved.join(", ")}.` : "";
    if (result.commit) {
      logger.info({ commit: result.commit.short_sha, resolved: result.resolved }, "reset (Lots): committed the good tag");
      return c.text(`demo-api is back on ${config.demoGoodTag} (${result.commit.short_sha}).${resolved}`, 200);
    }
    if (result.currentImage === goodImage()) {
      logger.info({ resolved: result.resolved }, "reset (Lots): demo-api already on the good tag");
      return c.text(`demo-api is already on ${config.demoGoodTag}.${resolved}`, 200);
    }
    logger.warn({ current: tagOf(result.currentImage), resolved: result.resolved }, "reset (Lots): file_drifted");
    return c.text(`demo-api is on ${tagOf(result.currentImage)}, neither ${config.demoBadTag} nor ${config.demoGoodTag}; nothing was committed (file_drifted).${resolved}`, 502);
  } catch (err) {
    logger.error({ err }, "reset (Lots) failed");
    if ((err as Error).message === "github_disabled") {
      return c.text("GitHub integration is disabled on this deployment (GITHUB_TOKEN not set); the reset cannot commit.", 502);
    }
    return c.text("The commit to GitHub failed (commit_failed); check the oncall-tools logs.", 502);
  }
});
