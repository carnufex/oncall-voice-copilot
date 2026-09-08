# On-call Voice Copilot — technical spec (contract between components)

This document is the source of truth for the interfaces between the four parts of the system.
All code, prompts, docs and UI are in **English**.

## 1. System overview

```
Slack (#incidents)                       ElevenLabs Agents platform
  /oncall drill  ──────────┐                 │ webhook tools (HTTPS + X-Oncall-Token)
  alert + call card ◄──────┤                 │ post-call webhook (HMAC)
                           ▼                 ▼
                 ┌──────────────────────────────────────┐
                 │  oncall-tools (Node 22 / TypeScript)  │  namespace: oncall-demo
                 │  - /tools/*      (agent tools)        │  ServiceAccount: oncall-tools
                 │  - /slack/*      (slash cmd)          │  public: https://oncall.rosenvall.se
                 │  - /call/:id     (voice call page)    │
                 │  - /api/*        (page backend)       │
                 │  - /webhooks/elevenlabs/post-call     │
                 │  - detector loop (CrashLoop watcher)  │
                 └───────┬───────────────┬──────────────┘
                         │ k8s API (RBAC-scoped, read-only)   │ GitHub Contents API (one file)
                         ▼                                    ▼
                 demo-api Deployment (victim)        carnufex/Rosenvalls-Homelab (GitOps repo)
                 registry.rosenvall.se/carnufex/     kubernetes/applications/oncall-demo/
                 oncall-demo-api:1.0.0 | 1.1.0       demo-api-deployment.yaml  ──► ArgoCD auto-sync
```

Golden path:

1. Engineer types `/oncall drill` in Slack. Backend commits `demo-api` image tag `1.0.0 → 1.1.0` to the GitOps repo and asks ArgoCD to refresh. Version 1.1.0 crashes on boot (missing `FEATURE_FLAGS_URL`).
2. Detector loop sees `CrashLoopBackOff`, opens an incident, posts an alert in Slack plus a Slack **call card** whose Join button opens `https://oncall.rosenvall.se/call/<incident_id>`.
3. The call page starts an ElevenLabs conversation (WebRTC) with the incident as dynamic variables. The agent briefs the engineer.
4. Engineer asks what is wrong / what changed. Agent uses `get_pod_status`, `get_pod_logs`, `get_recent_changes`.
5. Engineer says "roll it back". Agent calls `propose_action`, reads the plan aloud, waits for an explicit yes, then `execute_action`, then `verify_health`.
6. Agent calls `resolve_incident`. Post-call webhook posts summary + conversation id into the Slack thread and ends the call card.

## 2. Backend service: `services/oncall-tools`

Stack: Node 22, TypeScript (ESM), **Hono** (`hono`, `@hono/node-server`), `@kubernetes/client-node`, `@octokit/rest`, `@slack/web-api`, `zod`. Single process, single replica, in-memory incident store (documented limitation). Structured JSON logging to stdout (`pino`). Listens on `PORT` (default 8080). Health: `GET /healthz` → `{ ok: true }` (no auth).

### 2.1 Environment variables

| Variable | Required | Notes |
|---|---|---|
| `PORT` | no | default `8080` |
| `PUBLIC_BASE_URL` | yes | `https://oncall.rosenvall.se` (no trailing slash) |
| `TOOL_API_TOKEN` | yes | shared secret; every `/tools/*` request must carry header `X-Oncall-Token: <token>` |
| `ELEVENLABS_API_KEY` | yes* | used to mint conversation tokens. `*` value `unset` = feature disabled, log a warning |
| `ELEVENLABS_AGENT_ID` | yes* | agent to start on the call page |
| `ELEVENLABS_WEBHOOK_SECRET` | yes* | HMAC secret for post-call webhook |
| `SLACK_BOT_TOKEN` | yes* | `xoxb-…`; `unset` = Slack disabled (drill still works, alerts only logged) |
| `SLACK_SIGNING_SECRET` | yes* | verify `/slack/*` requests |
| `SLACK_CHANNEL_ID` | yes* | channel for alerts (e.g. `C0123…`) |
| `GITHUB_TOKEN` | yes* | fine-grained PAT, Contents read/write on the GitOps repo only |
| `GITHUB_REPO` | no | default `carnufex/Rosenvalls-Homelab` |
| `GITHUB_BRANCH` | no | default `master` |
| `GITOPS_FILE` | no | default `kubernetes/applications/oncall-demo/demo-api-deployment.yaml` |
| `K8S_NAMESPACE` | no | default `oncall-demo` |
| `ALLOWED_DEPLOYMENTS` | no | comma list, default `demo-api` |
| `ARGOCD_APP_NAME` | no | default `oncall-demo` |
| `ARGOCD_NAMESPACE` | no | default `argocd` |
| `ONCALL_ENGINEER_NAME` | no | default `Christopher` |
| `DEMO_IMAGE` | no | default `registry.rosenvall.se/carnufex/oncall-demo-api` |
| `DEMO_GOOD_TAG` / `DEMO_BAD_TAG` | no | default `1.0.0` / `1.1.0` |
| `DETECTOR_INTERVAL_MS` | no | default `10000` |
| `ACTION_TTL_MS` | no | default `120000` |
| `LOG_LEVEL` | no | default `info` |

Kubernetes client: in-cluster config when available, else `KUBECONFIG` (local dev). Local dev runs with `npm run dev` (tsx watch) and a `.env` file (never committed).

### 2.2 Security model (must be enforced in code, not only prompts)

- **Allowlist**: every tool resolves `incident_id → { namespace, deployment }`. The namespace must equal `K8S_NAMESPACE` and the deployment must be in `ALLOWED_DEPLOYMENTS`; anything else → HTTP 403 `{ error: "not_allowed" }` before any API call.
- **Read-only cluster access**: the backend never writes to Kubernetes except one annotation patch on the ArgoCD `Application` (refresh). All changes go through Git.
- **Redaction**: every string returned from logs/events/pod specs passes through `redact()` which replaces values matching tokens/keys/passwords/bearer/JWT/URL credentials (`password=…`, `token=…`, `Bearer …`, `xox[abp]-…`, `ghp_…`, `github_pat_…`, `AKIA…`, `eyJ…` JWT-like, `://user:pass@`) with `[REDACTED]`. Env vars are never returned; only container image, ports and probe summary.
- **Size caps**: logs max 60 lines / 6 KB, events max 15, changes max 5 commits.
- **Two-step actions**: `propose_action` creates `{ action_id (12 hex chars), plan, expires_at = now + ACTION_TTL_MS }`. `execute_action` requires the same `incident_id`, an unexpired, unexecuted `action_id` and `confirmation === "confirmed"`. Each action executes at most once. There is no other write path.
- **Auth**: `/tools/*` → constant-time compare of `X-Oncall-Token`. `/slack/*` → Slack signature v0 with 5 min timestamp tolerance. `/webhooks/elevenlabs/post-call` → `ElevenLabs-Signature` header (`t=<ts>,v0=<hex hmac-sha256 of "<ts>.<rawBody>">`), 30 min tolerance. `/api/*` and `/call/*` are public but only reveal incident data addressable by an unguessable id (documented as a demo limitation).

### 2.3 Data model (in-memory)

```ts
type Incident = {
  id: string;                 // "inc_" + 10 lowercase alnum chars
  service: string;            // deployment name, e.g. "demo-api"
  namespace: string;
  status: "open" | "mitigated" | "resolved";
  opened_at: string;          // ISO
  resolved_at?: string;
  alert: { reason: string; message: string; pod?: string; restarts?: number };
  slack?: { channel: string; thread_ts: string; call_id?: string };
  conversation_id?: string;   // from ElevenLabs post-call webhook (or page)
  root_cause?: string;
  action_taken?: string;
  timeline: TimelineEntry[];
  pending_actions: Record<string, PendingAction>;
};
type TimelineEntry = {
  ts: string;
  kind: "alert" | "tool" | "action" | "note" | "call";
  title: string;              // e.g. "get_pod_logs"
  detail?: string;            // short human summary (≤ 200 chars)
  duration_ms?: number;
};
type PendingAction = {
  action_id: string; type: "rollback"; created_at: string; expires_at: string;
  executed_at?: string; plan: RollbackPlan;
};
type RollbackPlan = {
  deployment: string; namespace: string;
  from_image: string; to_image: string;     // full refs incl. tag
  file: string; branch: string; summary: string; // one human sentence
};
```

### 2.4 Tool endpoints (all `POST`, JSON in/out, header `X-Oncall-Token`)

Common: body always includes `incident_id`. Unknown incident → 404 `{ error: "incident_not_found" }`. Every call appends a `tool` timeline entry with duration. Responses are small and flat; strings are pre-formatted for an LLM to read aloud. Include `spoken_summary` (1–2 sentences) in every response in addition to structured fields.

| Path | Body | Response (shape) |
|---|---|---|
| `/tools/get_incident` | `{incident_id}` | `{ id, service, namespace, status, opened_at, minutes_open, alert:{reason,message,pod,restarts}, spoken_summary }` |
| `/tools/get_pod_status` | `{incident_id}` | `{ deployment:{name, image, desired, ready, updated, available}, pods:[{name, phase, ready, restarts, state, reason, message, age}], spoken_summary }` `state` ∈ running/waiting/terminated; `reason` e.g. CrashLoopBackOff |
| `/tools/get_recent_events` | `{incident_id, limit?}` | `{ events:[{time, type, reason, object, message, count}], spoken_summary }` filtered to the deployment's pods/replicasets, newest first |
| `/tools/get_pod_logs` | `{incident_id, lines?}` | `{ pod, container, source:"previous"|"current", lines:[…], key_lines:[…], spoken_summary }` `key_lines` = lines containing FATAL/ERROR/panic/exception (max 5). If the container is in CrashLoopBackOff, read `previous=true` logs. |
| `/tools/get_recent_changes` | `{incident_id}` | `{ file, commits:[{sha, short_sha, author, date, minutes_ago, message, image_before, image_after, url}], replicasets:[{name, image, created, replicas, ready}], spoken_summary }` commits = last 5 touching `GITOPS_FILE`; `image_before/after` parsed from the `image:` line at parent/commit |
| `/tools/propose_action` | `{incident_id, action:"rollback", reason}` | `{ action_id, action:"rollback", plan:{from_image,to_image,file,branch}, summary, expires_in_seconds, requires_confirmation:true, spoken_summary }` `to_image` = image of the newest ReplicaSet other than the current one; fall back to `image_before` of the latest commit; 409 `{error:"no_rollback_target"}` if none |
| `/tools/execute_action` | `{incident_id, action_id, confirmation}` | `{ status:"executed", commit:{sha, short_sha, url, message}, spoken_summary }` Errors: 400 `confirmation_required`, 404 `action_not_found`, 410 `action_expired`, 409 `action_already_executed` |
| `/tools/verify_health` | `{incident_id, wait_seconds?}` | `{ healthy:boolean, image, desired, ready, restarts_recent, checked_for_seconds, spoken_summary }` Polls every 3 s up to `wait_seconds` (default 60, max 90) until ready==desired and no pod is waiting. Returns early when healthy. When healthy and incident is `open`, set status `mitigated`. |
| `/tools/resolve_incident` | `{incident_id, root_cause, action_taken}` | `{ status:"resolved", spoken_summary }` Stores fields, status `resolved`, posts a Slack thread note, ends the Slack call (`calls.end`). |
| `/tools/add_note` | `{incident_id, note}` | `{ ok:true, spoken_summary }` Appends a `note` timeline entry and posts it to the Slack thread. |

`execute_action` for `rollback`:
1. Read `GITOPS_FILE` at `GITHUB_BRANCH` via Contents API; replace the exact line `image: <from_image>` with `image: <to_image>` (fail 409 `file_drifted` if the from-image line is absent).
2. Commit with message:
   `revert(oncall-demo): roll back demo-api to <to_tag>\n\nIncident <id>. Approved by voice by <ONCALL_ENGINEER_NAME> via the on-call copilot.\nAction <action_id>.`
   Author `oncall-copilot <oncall-copilot@rosenvall.se>`.
3. Patch the ArgoCD Application `metadata.annotations["argocd.argoproj.io/refresh"] = "normal"` (merge patch on `argoproj.io/v1alpha1` `applications` in `ARGOCD_NAMESPACE`). Failure here is logged and reported in `spoken_summary` as "sync will pick it up within three minutes", not an error.
4. Mark action executed; append `action` timeline entry.

### 2.5 Slack

- `POST /slack/commands` (form-encoded). Verify signature. Command `/oncall` with text:
  - `drill` → respond ephemeral `Starting the drill: deploying demo-api 1.1.0 …` within 3 s, then async: run the **bad deploy** = same Git commit mechanism as rollback but `DEMO_GOOD_TAG → DEMO_BAD_TAG`, commit message `feat(oncall-demo): deploy demo-api 1.1.0\n\nDrill triggered from Slack by <user>.`, author `Release Bot <release-bot@rosenvall.se>` (so the change log looks like a real deploy). Then refresh ArgoCD. The detector opens the incident once the pod crashloops.
  - `reset` → commit back to the good tag (if needed), refresh ArgoCD, mark all open incidents resolved (`action_taken: "reset"`), end their Slack calls. Reply ephemeral.
  - `status` → ephemeral text: deployment image + pods + open incidents.
  - anything else → help text.
- Alert posting (from detector): `chat.postMessage` to `SLACK_CHANNEL_ID` with blocks:
  header `:rotating_light: CrashLoopBackOff: demo-api (oncall-demo)`, section with fields (service, namespace, pod, restarts, since), context `Incident <id>`. Store `thread_ts`.
  Then `calls.add({ external_unique_id: incident.id, join_url: PUBLIC_BASE_URL + "/call/" + id, title: "On-call copilot: demo-api CrashLoopBackOff", external_display_id: id })` and `chat.postMessage` in the thread with a block `{ type: "call", call_id }` and text "Join the on-call copilot call". If `calls.add` fails, post a section with a button (`url`) instead. Store `call_id`.
- Thread notes: `add_note`, `resolve_incident`, post-call summary → `chat.postMessage` with `thread_ts`.
- `calls.end({ id: call_id })` on resolve/reset.

Slack API scopes needed (documented in `docs/slack-app-manifest.yaml`): `commands`, `chat:write`, `chat:write.public`, `calls:write`. Slash command request URL: `PUBLIC_BASE_URL/slack/commands`.

### 2.6 Detector loop

Every `DETECTOR_INTERVAL_MS`: for each allowed deployment, list pods by label selector `app.kubernetes.io/name=<deployment>`. Condition = any container status with `waiting.reason ∈ {CrashLoopBackOff, Error}` or `restartCount ≥ 2 && !ready`. If condition holds and there is no incident with status `open`/`mitigated` for that service → create incident (`alert.reason = waiting reason`, `message` = waiting message or last termination message, `pod`, `restarts`), add `alert` timeline entry, post Slack alert + call. Log every decision at debug level. Never auto-close incidents.

### 2.7 Call page (`services/oncall-tools/web`, Vite + React 18 + TypeScript + `@elevenlabs/react`)

Built into `dist/web` and served by the backend as static files; `GET /call/:id` and `/` return `index.html`. Design: dark, calm, "incident console" look, one screen, no scrolling on a 1440×900 laptop. Layout:

- Header: service name, namespace, status pill (open / mitigated / resolved), incident id, "Opened N min ago".
- Left column: **Call panel**: big "Answer call" button (→ startSession), status (connecting / listening / speaking), "Hang up". Below it the live transcript (agent and user turns, newest at bottom, auto-scroll).
- Right column: **Timeline** (alert, tool calls with duration, actions, notes) polled from `GET /api/incidents/:id` every 2 s; a tool card shows the tool name, duration and `detail`. Pending action shows an amber "Awaiting voice confirmation" card; executed action shows the commit link.
- Footer: "ElevenLabs Agents • webhook tools • GitOps rollback • Slack" and the conversation id once known.

Session start: `POST /api/incidents/:id/session` → backend calls ElevenLabs `POST https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=…` (WebRTC conversation token) with `xi-api-key`, returns `{ conversation_token, dynamic_variables }`. Page calls `startSession({ conversationToken, connectionType: "webrtc", dynamicVariables })`. Verify the exact SDK and REST signatures against the installed `@elevenlabs/react` typings and https://elevenlabs.io/docs before relying on them; if the token endpoint differs, use the signed-url endpoint (`GET /v1/convai/conversation/get-signed-url?agent_id=`) with `connectionType: "websocket"`.

Dynamic variables (names are part of the contract with the agent prompt):

| name | example |
|---|---|
| `incident_id` | `inc_x7k2m9q4pa` |
| `service` | `demo-api` |
| `namespace` | `oncall-demo` |
| `environment` | `homelab sandbox cluster` |
| `alert_reason` | `CrashLoopBackOff` |
| `alert_message` | `back-off 5m0s restarting failed container` |
| `alert_minutes_ago` | `3` |
| `engineer_name` | `Christopher` |
| `opened_at_local` | `14:32` |

When the conversation connects, page `POST /api/incidents/:id/conversation` `{ conversation_id }` (from `getId()` / `onConnect`) so the backend can store it; add a `call` timeline entry "Voice call started".

### 2.8 Post-call webhook

`POST /webhooks/elevenlabs/post-call` (raw body needed for HMAC). Handle `type === "post_call_transcription"`. Map `data.conversation_id` → incident via stored `conversation_id` or via `data.conversation_initiation_client_data.dynamic_variables.incident_id`. Extract `data.analysis.transcript_summary`, `data.analysis.call_successful`, `data.analysis.data_collection_results` (keys `root_cause`, `action_taken`, `confirmation_obtained`), `data.analysis.evaluation_criteria_results`. Post to the Slack thread:

```
:white_check_mark: Call ended — conversation `<id>`
*Summary:* <transcript_summary>
*Root cause:* … | *Action:* … | *Confirmation obtained:* yes/no
*Evaluation:* criterion → success/failure …
```
End the Slack call. Add a `call` timeline entry "Voice call ended". Always respond 200 quickly; do work after responding when possible. Ignore other webhook types (200).

### 2.9 Repo layout

```
oncall-voice-copilot/
  README.md                        # FDE-facing handoff (written last)
  docs/SPEC.md                     # this file
  docs/DEMO-SCRIPT.md              # golden path, word for word
  docs/slack-app-manifest.yaml
  services/oncall-tools/           # backend + call page
    package.json  tsconfig.json  Dockerfile  .env.example
    src/{index.ts, config.ts, log.ts, store.ts, redact.ts, k8s.ts, github.ts, argocd.ts,
         slack.ts, elevenlabs.ts, detector.ts, routes/{tools.ts, slack.ts, api.ts, webhooks.ts}}
    web/{index.html, vite.config.ts, src/...}
  services/demo-api/               # the victim service (two versions)
  deploy/kubernetes/oncall-demo/   # mirror of the manifests that live in the homelab repo
  elevenlabs/                      # ElevenLabs CLI project (agents, tools, tests as code)
```

Dockerfile (multi-stage): `node:22-alpine` build (install, `npm run build` = tsc + vite build), runtime `node:22-alpine`, non-root user, `NODE_ENV=production`, `CMD ["node","dist/index.js"]`, `EXPOSE 8080`.

## 3. Victim service: `services/demo-api`

Node 22, no dependencies, `server.js`. Build arg `APP_VERSION`. Behaviour:

- On start, log `demo-api <version> starting`. If `APP_VERSION` starts with `1.1` and `FEATURE_FLAGS_URL` is unset: log
  `FATAL: startup config check failed: FEATURE_FLAGS_URL is not set (required since 1.1.0 for the feature-flag client)` and exit code 1 after 500 ms.
- Otherwise HTTP on 8080: `GET /healthz` → `{ ok: true, version }`, `GET /` → `{ service: "demo-api", version, uptime_seconds }`.
- Images: `registry.rosenvall.se/carnufex/oncall-demo-api:1.0.0` and `:1.1.0`.

## 4. Kubernetes (homelab repo `kubernetes/applications/oncall-demo/`)

Namespace `oncall-demo` (PSS baseline labels). Resources: image pull secret (dual-auth ExternalSecret `oncall-demo-registry`), `demo-api` Deployment (1 replica, label `app.kubernetes.io/name: demo-api`, image tag pinned in `demo-api-deployment.yaml`, readiness/liveness on `/healthz`), Service, `oncall-tools` Deployment + Service + HTTPRoute `oncall.rosenvall.se`, ServiceAccount `oncall-tools` with a namespace Role (pods, pods/log, events, deployments, replicasets: get/list/watch) and a Role in `argocd` (applications, resourceNames `[oncall-demo]`, get/patch), ExternalSecret `oncall-tools-secrets`.

## 5. ElevenLabs agent (in `elevenlabs/`)

Single agent "On-call Voice Copilot" (English, `gpt-4.1`, low temperature), webhook tools above (secret header from a workspace secret), knowledge base = `docs/runbooks/*.md`, system tools `end_call`, data collection (`root_cause`, `action_taken`, `confirmation_obtained`), evaluation criteria (confirmed before acting; verified after acting; did not leak secrets), guardrails, and tests. Details live in the agent config files.
