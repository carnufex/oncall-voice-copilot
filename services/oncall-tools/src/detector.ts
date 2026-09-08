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
  const incident = createIncident({
    service: deployment,
    namespace: config.k8sNamespace,
    alert: {
      reason: summary.reason ?? "CrashLoopBackOff",
      message: summary.message ?? `Pod ${summary.name} is crashlooping`,
      pod: summary.name,
      restarts: summary.restarts,
    },
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
