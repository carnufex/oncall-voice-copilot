// Central environment configuration. See docs/SPEC.md section 2.1 for the full contract.
//
// Convention: an optional integration is "disabled" when its env var is either missing or
// literally set to the string "unset" (used as an explicit placeholder value in ExternalSecrets /
// local .env files). Disabled integrations must not crash the process; callers log one warning at
// startup and skip the feature at call time.

function raw(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  if (v.trim().toLowerCase() === "unset") return undefined;
  if (v.trim() === "") return undefined;
  return v;
}

function required(name: string): string {
  const v = raw(name);
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return raw(name) ?? fallback;
}

function optionalNumber(name: string, fallback: number): number {
  const v = raw(name);
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: optionalNumber("PORT", 8080),
  publicBaseUrl: required("PUBLIC_BASE_URL"),
  toolApiToken: required("TOOL_API_TOKEN"),

  elevenlabsApiKey: raw("ELEVENLABS_API_KEY"),
  elevenlabsAgentId: raw("ELEVENLABS_AGENT_ID"),
  elevenlabsWebhookSecret: raw("ELEVENLABS_WEBHOOK_SECRET"),

  slackBotToken: raw("SLACK_BOT_TOKEN"),
  slackSigningSecret: raw("SLACK_SIGNING_SECRET"),
  slackChannelId: raw("SLACK_CHANNEL_ID"),
  slackCallCreatedBy: raw("SLACK_CALL_CREATED_BY"),
  localTimezone: optional("LOCAL_TIMEZONE", "Europe/Stockholm"),

  githubToken: raw("GITHUB_TOKEN"),
  githubRepo: optional("GITHUB_REPO", "carnufex/Rosenvalls-Homelab"),
  githubBranch: optional("GITHUB_BRANCH", "master"),
  gitopsFile: optional("GITOPS_FILE", "kubernetes/applications/oncall-demo/demo-api-deployment.yaml"),

  k8sNamespace: optional("K8S_NAMESPACE", "oncall-demo"),
  allowedDeployments: optional("ALLOWED_DEPLOYMENTS", "demo-api")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  argocdAppName: optional("ARGOCD_APP_NAME", "oncall-demo"),
  argocdNamespace: optional("ARGOCD_NAMESPACE", "argocd"),

  oncallEngineerName: optional("ONCALL_ENGINEER_NAME", "Christopher"),

  demoImage: optional("DEMO_IMAGE", "registry.rosenvall.se/carnufex/oncall-demo-api"),
  demoGoodTag: optional("DEMO_GOOD_TAG", "1.0.0"),
  demoBadTag: optional("DEMO_BAD_TAG", "1.1.0"),

  detectorIntervalMs: optionalNumber("DETECTOR_INTERVAL_MS", 10000),
  actionTtlMs: optionalNumber("ACTION_TTL_MS", 120000),

  logLevel: optional("LOG_LEVEL", "info"),

  devFixtures: raw("DEV_FIXTURES") === "1",
} as const;

export function isElevenLabsEnabled(): boolean {
  return Boolean(config.elevenlabsApiKey && config.elevenlabsAgentId);
}

export function isElevenLabsWebhookEnabled(): boolean {
  return Boolean(config.elevenlabsWebhookSecret);
}

export function isSlackEnabled(): boolean {
  return Boolean(config.slackBotToken && config.slackSigningSecret && config.slackChannelId);
}

export function isGithubEnabled(): boolean {
  return Boolean(config.githubToken);
}

const warned = new Set<string>();
export function warnOnce(key: string, message: string, logger: { warn: (msg: string) => void }) {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(message);
}
