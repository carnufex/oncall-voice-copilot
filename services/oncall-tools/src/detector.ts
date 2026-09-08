import { config } from "./config.js";
import { logger } from "./log.js";
import { isCrashLooping, listPodsForDeployment, summarizePod } from "./k8s.js";
import { addTimelineEntry, createIncident, findActiveIncidentForService } from "./store.js";
import { postAlert } from "./slack.js";

let timer: NodeJS.Timeout | undefined;

async function checkDeployment(deployment: string): Promise<void> {
  const pods = await listPodsForDeployment(config.k8sNamespace, deployment);
  const crashing = pods.find((p) => isCrashLooping(p));
  if (!crashing) {
    logger.debug({ deployment, pods: pods.length }, "detector: no crashloop condition");
    return;
  }

  const existing = findActiveIncidentForService(deployment);
  if (existing) {
    logger.debug({ deployment, incident_id: existing.id }, "detector: crashloop condition already has an open incident");
    return;
  }

  const summary = summarizePod(crashing);
  // The detector fires on the first crash, when the container is still "terminated (Error)"
  // rather than "waiting (CrashLoopBackOff)". The incident is the same; name it consistently.
  const cs = crashing.status?.containerStatuses?.[0];
  const exitCode = cs?.state?.terminated?.exitCode ?? cs?.lastState?.terminated?.exitCode;
  const reason = summary.state === "waiting" && summary.reason ? summary.reason : "CrashLoopBackOff";
  const message =
    summary.state === "waiting" && summary.message
      ? // Kubernetes appends "container=... pod=...(uid)" to the back-off message; drop it for speech.
        summary.message.replace(/\s+container=.*$/, "")
      : `container exited with code ${exitCode ?? "unknown"} right after start, ${summary.restarts} restart${summary.restarts === 1 ? "" : "s"} so far`;
  const incident = createIncident({
    service: deployment,
    namespace: config.k8sNamespace,
    alert: { reason, message, pod: summary.name, restarts: summary.restarts },
  });
  addTimelineEntry(
    incident,
    "alert",
    incident.alert.reason,
    `${summary.name}: ${summary.restarts} restarts, ${incident.alert.message}`,
  );
  logger.info({ incident_id: incident.id, deployment, pod: summary.name }, "detector: opened incident");

  await postAlert(incident);
}

async function tick(): Promise<void> {
  for (const deployment of config.allowedDeployments) {
    try {
      await checkDeployment(deployment);
    } catch (err) {
      // Never let one bad deployment/namespace crash the loop (e.g. namespace not created yet).
      logger.error({ err, deployment, namespace: config.k8sNamespace }, "detector: check failed");
    }
  }
}

export function startDetector(): void {
  logger.info({ intervalMs: config.detectorIntervalMs, deployments: config.allowedDeployments }, "detector: starting");
  timer = setInterval(() => {
    void tick();
  }, config.detectorIntervalMs);
  timer.unref?.();
  void tick();
}

export function stopDetector(): void {
  if (timer) clearInterval(timer);
}
