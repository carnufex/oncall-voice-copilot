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
| `POST /webhooks/elevenlabs/post-call` | `ElevenLabs-Signature` HMAC | post-call summary -> Slack thread |
| `GET /api/incidents` | public (unguessable ids) | list, newest first |
| `GET /api/incidents/:id` | public | incident + timeline, polled by the call page every 2s |
| `POST /api/incidents/:id/session` | public | mints an ElevenLabs WebRTC conversation token |
| `POST /api/incidents/:id/conversation` | public | records the conversation id once connected |
| `POST /api/dev/incidents` | public, `DEV_FIXTURES=1` only | creates a fake incident for local testing |
| `GET /`, `GET /call/:id` | public | the call page (React SPA) |

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
