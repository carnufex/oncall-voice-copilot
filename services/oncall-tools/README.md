# oncall-tools

Backend + call page for the On-call Voice Copilot demo. See `../../docs/SPEC.md` for the full
contract; this file is a short "how do I run this" summary.

## Run locally

```bash
npm install
cp .env.example .env   # edit as needed; every integration degrades gracefully when unset
npm run dev             # backend on :8080 (tsx watch)
npm run dev:web         # in a second terminal: Vite dev server for the call page, proxies /api -> :8080
```

For a full local build (what the Docker image runs):

```bash
npm run build   # tsc -> dist/index.js, vite build -> dist/web
npm start        # node dist/index.js, serves the built call page too
```

Useful local env for exercising the app without Slack/ElevenLabs/GitHub/a real cluster:

```bash
TOOL_API_TOKEN=dev
DEV_FIXTURES=1   # enables POST /api/dev/incidents to create a fake incident
KUBECONFIG=/path/to/kubeconfig
K8S_NAMESPACE=oncall-demo
```

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | liveness, `{ ok: true }` |
| `POST /tools/*` | `X-Oncall-Token` | agent tool endpoints (get_incident, get_pod_status, get_pod_logs, get_recent_events, get_recent_changes, propose_action, execute_action, verify_health, resolve_incident, add_note) |
| `POST /slack/commands` | Slack signature | `/oncall drill\|reset\|status` |
| `POST /drill/break`, `POST /drill/reset` | `Authorization: Bearer <DRILL_API_TOKEN>` | what `/oncall drill` / `/oncall reset` do, for a Lots drill button (below); 404 when `DRILL_API_TOKEN` is unset |
| `GET /ops/changes`, `POST /ops/rollback` | `Authorization: Bearer <DRILL_API_TOKEN>` | what changed for a service, and a rollback to its known-good tag, for an agent in Lots (below; `openapi/ops.json`); 404 when `DRILL_API_TOKEN` is unset |
| `POST /webhooks/elevenlabs/post-call` | `ElevenLabs-Signature` HMAC | post-call summary -> Slack thread |
| `GET /api/incidents` | public (unguessable ids) | list, newest first |
| `GET /api/incidents/:id` | public | incident + timeline, polled by the call page every 2s |
| `POST /api/incidents/:id/session` | public | mints an ElevenLabs WebRTC conversation token |
| `POST /api/incidents/:id/conversation` | public | records the conversation id once connected |
| `POST /api/dev/incidents` | public, `DEV_FIXTURES=1` only | creates a fake incident for local testing |
| `GET /`, `GET /call/:id` | public | the call page (React SPA) |

## Drill endpoints for Lots

`POST /drill/break` and `POST /drill/reset` exist for a Lots alert source's **drill** button (Lots'
`docs/incidents.md`, "Drills"): an admin presses it, Lots calls `/drill/break` in the cluster
(`http://oncall-tools.oncall-demo.svc.cluster.local:8080`), and the crash that follows reaches Lots through
Alertmanager like any other alert. They call the same code as `/oncall drill` and `/oncall reset`
(`src/drill.ts`): the same commit to `GITOPS_FILE` (its body says "Drill triggered from Lots." / "Reset
triggered from Lots."), the same ArgoCD refresh, and a reset resolves open incidents as the Slack one does.

- **Switch**: `DRILL_API_TOKEN`. Missing or `unset` = both routes answer 404.
- **Auth**: `Authorization: Bearer <DRILL_API_TOKEN>`, compared in constant time; anything else is 401.
  `/drill/` is not one of the public route's unauthenticated prefixes, so from outside the cluster it is
  behind oauth2-proxy (SSO) too.
- **Answer**: one line of plain text for the button's outcome, never a token or GitHub's response:
  `200` `demo-api 1.1.0 is committed (abc1234); ArgoCD is rolling it out.`, `demo-api is already on 1.1.0.`,
  `demo-api is back on 1.0.0 (def5678).`; `502` with the reason when nothing could be committed
  (`file_drifted`, `commit_failed`, GitHub disabled).

## Operations for an agent in Lots

`GET /ops/changes` and `POST /ops/rollback` exist so that an agent in Lots (the `homelab-ops` context's
incident investigation) can read what changed for a service and, after a person approved it in Lots, roll it
back. Lots' tool pack loads `openapi/ops.json` (operationIds `recent_changes` and `rollback_service`) and calls
them in the cluster (`http://oncall-tools.oncall-demo.svc.cluster.local:8080`). Lots holds every
`rollback_service` call until a person approves it; this service only checks the bearer.

- **Auth**: as the drill routes: `Authorization: Bearer <DRILL_API_TOKEN>`, constant time; missing or `unset`
  token = 404, anything else 401. `/ops/` is not one of the public route's unauthenticated prefixes, so from
  outside the cluster it is behind oauth2-proxy (SSO) too: in practice in-cluster only.
- **`GET /ops/changes?service=demo-api`**: the last commits (at most 10, newest first) to `GITOPS_FILE` on
  `GITHUB_BRANCH`, through the same `listRecentImageCommits` as `/tools/get_recent_changes` (which answers as
  before). `200 {"service", "file", "branch", "changes": [{"commit", "time", "author", "message", "image_from",
  "image_to"}]}`: short sha, ISO time, author, first message line; the image tags only on commits that changed
  the image line (`image_from` is `null` when the file was created). A service outside `ALLOWED_DEPLOYMENTS`:
  `404 {"error": "unknown_service", "message"}`; GitHub failing: `502`.
- **`POST /ops/rollback`** with `{"service": "demo-api", "reason": "<why>"}`: the reset's own rule
  (`restoreGoodTag` in `src/drill.ts`): commit `DEMO_GOOD_TAG` in place of `DEMO_BAD_TAG` in `GITOPS_FILE`,
  then ask ArgoCD to refresh. The target comes from configuration, never from the request. The commit message
  says it was approved in Lots and carries `Reason: <the reason>`, flattened to one line (control characters,
  newlines and bidirectional marks become spaces) and cut to 200 characters. Answers
  `{"service", "from", "to", "commit", "message"}`: `200` committed (`commit` is the short sha), `200` already
  on the good tag (`commit: null`, nothing committed); `409 file_drifted` when the file names neither tag
  (nothing committed); `502 commit_failed` / `github_disabled`; `404` for a service outside
  `ALLOWED_DEPLOYMENTS`; `400` for another body; `413` over 16 KB. The pods show the rollback about a minute
  after the commit.
- **The voice demo's incident**: a rollback that committed, or found the good tag already there, resolves the
  voice demo's open incidents as `/drill/reset` does (a line in each Slack thread, the Slack call ended). A
  `409` or `502` resolves nothing.
- **Limits**: one `GITOPS_FILE` and one pair of tags, so the operations serve one service (`demo-api`); keep
  `ALLOWED_DEPLOYMENTS` at that one service while they are on. Log lines: `ops: rollback committed` (service,
  tags, commit, reason), `ops: rollback refused, file_drifted`, `ops: rollback failed, nothing committed`,
  `ops: refused, wrong or missing bearer`.

## Security model summary

- **Tool auth**: constant-time compare of `X-Oncall-Token` against `TOOL_API_TOKEN`.
- **Slack auth**: `v0=` HMAC-SHA256 of `v0:<timestamp>:<rawBody>` with `SLACK_SIGNING_SECRET`, 5 minute timestamp tolerance.
- **Webhook auth**: `ElevenLabs-Signature: t=<ts>,v0=<hex hmac-sha256 of "<ts>.<rawBody>">`, 30 minute tolerance.
- **Allowlist**: every tool call resolves `incident_id -> {namespace, deployment}` and rejects (403 `not_allowed`) anything outside `K8S_NAMESPACE` / `ALLOWED_DEPLOYMENTS` before touching the Kubernetes API.
- **Read-only cluster access**: the only Kubernetes write is a merge-patch annotation refresh on the ArgoCD `Application`; every other change goes through a Git commit (Contents API) that ArgoCD then syncs.
- **Redaction**: `src/redact.ts` strips password/token/Bearer/Slack/GitHub/AWS-key/JWT/URL-credential shaped substrings from every log line, event message and pod status string before it reaches the LLM, Slack, or the call page. Environment variables are never returned by any tool.
- **Two-step actions**: `propose_action` creates a TTL'd, single-use `action_id`; `execute_action` requires that id plus `confirmation: "confirmed"` and marks it executed exactly once (SPEC 2.2/2.4).
- **Public surfaces**: `/api/*` and `/call/*` are unauthenticated but only reveal data addressable by an unguessable `inc_<10 chars>` id — a documented demo limitation, not for production multi-tenant use.
- **Graceful degradation**: every optional integration (ElevenLabs, Slack, GitHub) logs one warning at startup when its env vars are missing/`unset` and returns a clear error or a no-op instead of crashing.

## Known limitations (by design, see SPEC)

- In-memory incident store: state is lost on restart; single replica only.
- No persistence/auth beyond the above — this is a demo, not a multi-tenant service.
