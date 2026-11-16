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

export type RestoreResult = Omit<ResetResult, "resolved"> & {
  /** Whether the ArgoCD refresh was accepted (false: the sync picks the commit up within three minutes). */
  refreshed: boolean;
};

/** The tag of a demo-api image reference (`1.0.0`), or the whole reference when it is some other image. */
export function tagOf(image: string | undefined): string {
  if (!image) return "no image line";
  return image.startsWith(`${config.demoImage}:`) ? image.slice(config.demoImage.length + 1) : image;
}

/**
 * The one rollback rule, shared by the reset (Slack and POST /drill/reset) and POST /ops/rollback (an agent in
 * Lots, after a person approved it there): commits the good demo-api tag (DEMO_GOOD_TAG) in place of the bad one
 * (DEMO_BAD_TAG), or nothing when the file does not name the bad one, and asks ArgoCD to refresh. The tags come
 * from configuration, never from a caller. GitHub being disabled or failing is thrown.
 */
export async function restoreGoodTag(message: string): Promise<RestoreResult> {
  let commit: CommitResult | undefined;
  let currentImage: string | undefined;
  try {
    commit = await commitImageChange({
      fromImage: badImage(),
      toImage: goodImage(),
      message,
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
  const refresh = await requestArgoCdRefresh();
  return { commit, currentImage, refreshed: refresh.ok };
}

/**
 * Resolves every open incident of the voice demo, saying `note` in its Slack thread and ending its call.
 * Returns the ids it resolved.
 */
export async function resolveOpenIncidents(note: string): Promise<string[]> {
  const resolved: string[] = [];
  for (const incident of listIncidents()) {
    if (incident.status === "open" || incident.status === "mitigated") {
      incident.status = "resolved";
      incident.resolved_at = new Date().toISOString();
      incident.action_taken = "reset";
      await postThreadMessage(incident, note);
      await endCall(incident);
      resolved.push(incident.id);
    }
  }
  return resolved;
}

/**
 * Commits the good demo-api tag in place of the bad one (nothing when the file does not name the bad
 * one), asks ArgoCD to refresh, and resolves every open incident, saying so in its Slack thread and
 * ending its call. `source` names who asked, in the commit and in the thread. GitHub being disabled or
 * failing is thrown.
 */
export async function resetDemoApi(source: "Slack" | "Lots"): Promise<ResetResult> {
  const { commit, currentImage } = await restoreGoodTag(
    `revert(oncall-demo): reset demo-api to ${config.demoGoodTag}\n\nReset triggered from ${source}.`,
  );
  const resolved = await resolveOpenIncidents(`:arrows_counterclockwise: Reset from ${source}: demo-api rolled back and incident marked resolved.`);
  return { commit, currentImage, resolved };
}
