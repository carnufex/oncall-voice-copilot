import { config } from "./config.js";
import { logger } from "./log.js";
import { commitImageChange, FileDriftedError, type CommitResult } from "./github.js";
import { requestArgoCdRefresh } from "./argocd.js";
import { postThreadMessage, endCall } from "./slack.js";
import { listIncidents } from "./store.js";

// The drill and the reset, shared by `/oncall drill|reset` (routes/slack.ts) and POST /drill/break|reset
// (routes/drill.ts, a Lots alert source's drill button). Each caller words its own answer.

export const goodImage = () => `${config.demoImage}:${config.demoGoodTag}`;
export const badImage = () => `${config.demoImage}:${config.demoBadTag}`;

export type BreakResult =
  | { kind: "committed"; commit: CommitResult; refreshed: boolean }
  /** The file does not name the good image; `currentImage` is what it names instead. Nothing was committed. */
  | { kind: "drifted"; currentImage: string | undefined }
  | { kind: "github_disabled" };

/**
 * Commits the bad demo-api tag in place of the good one and asks ArgoCD to refresh. `trailer` is the
 * commit body ("Drill triggered from ..."). Any other failure (GitHub refused, network) is thrown.
 */
export async function breakDemoApi(trailer: string): Promise<BreakResult> {
  try {
    const commit = await commitImageChange({
      fromImage: goodImage(),
      toImage: badImage(),
      message: `feat(oncall-demo): deploy demo-api ${config.demoBadTag}\n\n${trailer}`,
      authorName: "Release Bot",
      authorEmail: "release-bot@rosenvall.se",
    });
    const refresh = await requestArgoCdRefresh();
    return { kind: "committed", commit, refreshed: refresh.ok };
  } catch (err) {
    if (err instanceof FileDriftedError) return { kind: "drifted", currentImage: err.currentImage };
    if ((err as Error).message === "github_disabled") return { kind: "github_disabled" };
    throw err;
  }
}

export type ResetResult = {
  /** The revert commit, or undefined when the file did not name the bad image (nothing to commit). */
  commit: CommitResult | undefined;
  /** What the file names when nothing was committed. */
  currentImage: string | undefined;
  /** Incidents marked resolved. */
  resolved: string[];
};

/**
 * Commits the good demo-api tag in place of the bad one (nothing when the file does not name the bad
 * one), asks ArgoCD to refresh, and resolves every open incident, saying so in its Slack thread and
 * ending its call. `source` names who asked, in the commit and in the thread. GitHub being disabled or
 * failing is thrown.
 */
export async function resetDemoApi(source: "Slack" | "Lots"): Promise<ResetResult> {
  let commit: CommitResult | undefined;
  let currentImage: string | undefined;
  try {
    commit = await commitImageChange({
      fromImage: badImage(),
      toImage: goodImage(),
      message: `revert(oncall-demo): reset demo-api to ${config.demoGoodTag}\n\nReset triggered from ${source}.`,
      authorName: "oncall-copilot",
      authorEmail: "oncall-copilot@rosenvall.se",
    });
    logger.info({ commit }, "reset: committed good tag");
  } catch (err) {
    if (err instanceof FileDriftedError) {
      logger.info("reset: demo-api already at the good tag, nothing to commit");
      currentImage = err.currentImage;
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
      await postThreadMessage(incident, `:arrows_counterclockwise: Reset from ${source}: demo-api rolled back and incident marked resolved.`);
      await endCall(incident);
      resolved.push(incident.id);
    }
  }
  return { commit, currentImage, resolved };
}
