import {
  KubeConfig,
  CoreV1Api,
  AppsV1Api,
  type V1Pod,
  type V1Deployment,
  type V1ReplicaSet,
  type CoreV1Event,
} from "@kubernetes/client-node";
import { config } from "./config.js";
import { logger } from "./log.js";

let kubeConfig: KubeConfig | undefined;
let coreApi: CoreV1Api | undefined;
let appsApi: AppsV1Api | undefined;

export function getKubeConfig(): KubeConfig {
  if (kubeConfig) return kubeConfig;
  const kc = new KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
    logger.info("Kubernetes client: loaded in-cluster config");
  } else {
    kc.loadFromDefault();
    logger.info("Kubernetes client: loaded config from KUBECONFIG / default location");
  }
  kubeConfig = kc;
  return kc;
}

export function getCoreApi(): CoreV1Api {
  if (!coreApi) coreApi = getKubeConfig().makeApiClient(CoreV1Api);
  return coreApi;
}

export function getAppsApi(): AppsV1Api {
  if (!appsApi) appsApi = getKubeConfig().makeApiClient(AppsV1Api);
  return appsApi;
}

export type PodSummary = {
  name: string;
  phase: string;
  ready: boolean;
  restarts: number;
  state: "running" | "waiting" | "terminated" | "unknown";
  reason?: string;
  message?: string;
  age: string;
};

function humanAge(since?: Date): string {
  if (!since) return "unknown";
  const ms = Date.now() - since.getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

/** Summarizes the first (primary) container's status on a pod for display and detection. */
export function summarizePod(pod: V1Pod): PodSummary {
  const cs = pod.status?.containerStatuses?.[0];
  const restarts = cs?.restartCount ?? 0;
  let state: PodSummary["state"] = "unknown";
  let reason: string | undefined;
  let message: string | undefined;
  if (cs?.state?.waiting) {
    state = "waiting";
    reason = cs.state.waiting.reason;
    message = cs.state.waiting.message;
  } else if (cs?.state?.terminated) {
    state = "terminated";
    reason = cs.state.terminated.reason;
    message = cs.state.terminated.message;
  } else if (cs?.state?.running) {
    state = "running";
  }
  return {
    name: pod.metadata?.name ?? "unknown",
    phase: pod.status?.phase ?? "Unknown",
    ready: cs?.ready ?? false,
    restarts,
    state,
    ...(reason ? { reason } : {}),
    ...(message ? { message } : {}),
    age: humanAge(pod.metadata?.creationTimestamp ? new Date(pod.metadata.creationTimestamp) : undefined),
  };
}

/** True when a pod's primary container looks crashlooping, per the detector's condition (SPEC 2.6). */
export function isCrashLooping(pod: V1Pod): boolean {
  const cs = pod.status?.containerStatuses?.[0];
  if (!cs) return false;
  const waitingReason = cs.state?.waiting?.reason;
  if (waitingReason === "CrashLoopBackOff" || waitingReason === "Error") return true;
  if ((cs.restartCount ?? 0) >= 2 && !cs.ready) return true;
  return false;
}

export async function listPodsForDeployment(namespace: string, deployment: string): Promise<V1Pod[]> {
  const res = await getCoreApi().listNamespacedPod({
    namespace,
    labelSelector: `app.kubernetes.io/name=${deployment}`,
  });
  return res.items ?? [];
}

export type DeploymentSummary = {
  name: string;
  image: string;
  desired: number;
  ready: number;
  updated: number;
  available: number;
};

export async function getDeploymentSummary(namespace: string, deployment: string): Promise<DeploymentSummary | undefined> {
  let dep: V1Deployment;
  try {
    dep = await getAppsApi().readNamespacedDeployment({ name: deployment, namespace });
  } catch (err) {
    logger.warn({ err, namespace, deployment }, "readNamespacedDeployment failed");
    return undefined;
  }
  const image = dep.spec?.template?.spec?.containers?.[0]?.image ?? "unknown";
  return {
    name: dep.metadata?.name ?? deployment,
    image,
    desired: dep.spec?.replicas ?? 0,
    ready: dep.status?.readyReplicas ?? 0,
    updated: dep.status?.updatedReplicas ?? 0,
    available: dep.status?.availableReplicas ?? 0,
  };
}

export type ReplicaSetSummary = {
  name: string;
  image: string;
  created: string;
  replicas: number;
  ready: number;
  revision: number;
};

/** Lists ReplicaSets owned by `deployment`, newest revision first (SPEC 2.9 detail). */
export async function listReplicaSetsForDeployment(namespace: string, deployment: string): Promise<ReplicaSetSummary[]> {
  const res = await getAppsApi().listNamespacedReplicaSet({ namespace });
  const owned = (res.items ?? []).filter((rs: V1ReplicaSet) =>
    (rs.metadata?.ownerReferences ?? []).some((o) => o.kind === "Deployment" && o.name === deployment),
  );
  const summaries: ReplicaSetSummary[] = owned.map((rs) => ({
    name: rs.metadata?.name ?? "unknown",
    image: rs.spec?.template?.spec?.containers?.[0]?.image ?? "unknown",
    created: rs.metadata?.creationTimestamp ? new Date(rs.metadata.creationTimestamp).toISOString() : "",
    replicas: rs.spec?.replicas ?? 0,
    ready: rs.status?.readyReplicas ?? 0,
    revision: Number(rs.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? 0),
  }));
  summaries.sort((a, b) => b.revision - a.revision);
  return summaries;
}

export type EventSummary = {
  time: string;
  type: string;
  reason: string;
  object: string;
  message: string;
  count: number;
};

/** Lists events for a namespace, filtered to objects whose name starts with `<deployment>-`, newest first. */
export async function listEventsForDeployment(namespace: string, deployment: string, limit: number): Promise<EventSummary[]> {
  const res = await getCoreApi().listNamespacedEvent({
    namespace,
    fieldSelector: `involvedObject.namespace=${namespace}`,
  });
  const items = (res.items ?? []).filter((e: CoreV1Event) => (e.involvedObject?.name ?? "").startsWith(`${deployment}-`) || e.involvedObject?.name === deployment);
  const summaries: EventSummary[] = items.map((e) => {
    const time = e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata?.creationTimestamp;
    return {
      time: time ? new Date(time).toISOString() : "",
      type: e.type ?? "Normal",
      reason: e.reason ?? "",
      object: `${e.involvedObject?.kind ?? "Object"}/${e.involvedObject?.name ?? "unknown"}`,
      message: e.message ?? "",
      count: e.count ?? 1,
    };
  });
  summaries.sort((a, b) => (a.time < b.time ? 1 : -1));
  return summaries.slice(0, limit);
}

export async function getPodLogs(
  namespace: string,
  podName: string,
  container: string | undefined,
  opts: { previous?: boolean; tailLines?: number },
): Promise<string> {
  return getCoreApi().readNamespacedPodLog({
    name: podName,
    namespace,
    ...(container ? { container } : {}),
    previous: opts.previous ?? false,
    tailLines: opts.tailLines ?? 60,
  });
}
