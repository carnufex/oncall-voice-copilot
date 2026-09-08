# On-call Voice Copilot

An ElevenLabs voice agent that joins the on-call engineer when an alert fires, diagnoses a
Kubernetes incident with real tools, and rolls back through GitOps, only after the engineer says
yes on the call.

Built as the ElevenLabs FDE take-home. Everything runs against a real cluster (a Talos/ArgoCD
homelab) in an isolated sandbox namespace, with real commits and real rollouts.

- **Agent:** `On-call Voice Copilot` in the ElevenLabs workspace (`agent_1501m20j4f41fv1td9c3mvmkhek8`)
- **Call page:** `https://oncall.rosenvall.se/call/<incident_id>`
- **Demo script:** [docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md) · **Spec:** [docs/SPEC.md](docs/SPEC.md)

## The golden path

```
/oncall drill (Slack) ──► Git commit: demo-api 1.0.0 → 1.1.0 ──► ArgoCD ──► CrashLoopBackOff
                                                                              │
   Slack alert + call card  ◄──── detector opens incident ◄───────────────────┘
          │ Join
          ▼
   Call page ──► ElevenLabs Agent (WebRTC) ──► webhook tools ──► oncall-tools backend
                                                                     │  read-only k8s RBAC
                        "What do the logs say?"  → get_pod_logs      │  (pods, logs, events, RS)
                        "What changed?"          → get_recent_changes│  GitHub commit history
                        "Roll it back."          → propose_action    │  plan + action_id (2 min TTL)
                        "Yes, go ahead."         → execute_action    │  Git commit → ArgoCD refresh
                                                 → verify_health     │  waits for the rollout
                        "Thanks, that's all."    → resolve_incident, end_call
          │
          ▼
   Post-call webhook (HMAC) ──► summary, root cause, action, "confirmation obtained", evals ──► Slack thread
```

## What the demo shows on the ElevenLabs side

| Capability | Where |
|---|---|
| 10 webhook tools with a workspace-secret header, dynamic-variable parameters, spoken summaries | `elevenlabs/tool_configs/` |
| Dynamic variables from the alert (`incident_id`, `service`, `alert_reason`, `engineer_name`, …) injected at session start | `services/oncall-tools/src/routes/api.ts` |
| Knowledge base with RAG: CrashLoopBackOff runbook, service catalog, change policy | `docs/runbooks/` |
| Data collection (`root_cause`, `action_taken`, `confirmation_obtained`) and 5 evaluation criteria | agent config, `platform_settings` |
| Guardrails (focus, prompt injection) and a prompt with explicit confirmation rules | agent config |
| Agent tests: 3 unit tests on the confirmation rules, 1 on scope refusal, 1 end-to-end simulation against the live tools | `elevenlabs/test_configs/` |
| Post-call webhook, HMAC-verified, closing the loop in Slack | `services/oncall-tools/src/routes/webhooks.ts` |
| React SDK (`@elevenlabs/react`, WebRTC) with a conversation token minted server-side | `services/oncall-tools/web/` |
| Agents-as-code: agent, tools and tests pulled/pushed with the ElevenLabs CLI | `elevenlabs/` |

## Security model (enforced in code, not in the prompt)

The interesting question for an agent that can change production is not "can it act" but
"what is the worst it can do". Layers, outermost first:

1. **Sandbox namespace.** Everything lives in `oncall-demo`. Daily operation is untouched.
2. **Kubernetes RBAC.** The backend's ServiceAccount has a namespaced Role for
   `pods`, `pods/log`, `events`, `deployments`, `replicasets` with `get/list/watch` only.
   Secrets and ConfigMaps are not in the Role; the API server refuses regardless of what the
   agent asks. No ClusterRole. Verified with `kubectl auth can-i` (see below).
3. **Backend allowlist.** Every tool resolves `incident_id → {namespace, deployment}` and refuses
   anything outside `K8S_NAMESPACE` / `ALLOWED_DEPLOYMENTS` before calling any API.
4. **Redaction.** Logs, events and messages pass through a redactor (tokens, passwords, JWTs,
   Slack/GitHub/AWS key shapes, URL credentials) before the model sees them. Env vars are never returned.
5. **No cluster writes.** The only cluster write is one annotation patch on one ArgoCD
   `Application` (`argocd.argoproj.io/refresh`), allowed by a Role in `argocd` pinned with
   `resourceNames: [oncall-demo]`. Rollbacks are Git commits by a fine-grained token limited to
   the GitOps repo; ArgoCD applies them. `kubectl set image` would be reverted by self-heal anyway.
6. **Two-step actions.** `propose_action` returns a plan and an `action_id` that expires in
   two minutes. `execute_action` needs that id, unexpired, unused, plus `confirmation: "confirmed"`.
   The prompt says "ask for a yes"; the backend makes it impossible to skip. Every commit is
   authored `oncall-copilot` so the audit trail shows it was the agent.
7. **Auth on every inbound path.** Tools: shared secret header (constant-time compare). Slack:
   signature v0 with a 5 min window. ElevenLabs webhook: HMAC with a 30 min window.

RBAC boundary as measured on the cluster (`kubectl auth can-i --as system:serviceaccount:oncall-demo:oncall-tools`):

| Verb / resource | oncall-demo | gatebound | argocd |
|---|---|---|---|
| get pods, list pods/log, list events, get deployments, list replicasets | yes | no | no |
| get secrets, get configmaps, create pods/exec, patch deployments, delete pods | no | no | no |
| get/patch `applications/oncall-demo` | – | – | yes |
| patch `applications/gatebound`, delete/list applications | – | – | no |

## Repository layout

```
docs/SPEC.md                      contract between all parts (endpoints, shapes, security model)
docs/DEMO-SCRIPT.md               the golden path, word for word
docs/runbooks/                    knowledge base sources
docs/slack-app-manifest.yaml      Slack app (slash command, calls:write, chat:write)
elevenlabs/                       ElevenLabs CLI project: agent, tools, tests as code
services/oncall-tools/            backend (Hono, TypeScript) + call page (Vite, React, @elevenlabs/react)
services/demo-api/                the victim: 1.0.0 healthy, 1.1.0 crashes on boot
deploy/kubernetes/                mirror of the manifests that live in the GitOps repo
```

## Running it

Prerequisites: Node 22+, Docker, a Kubernetes cluster with ArgoCD, an ElevenLabs API key, a
Slack app (from `docs/slack-app-manifest.yaml`), a fine-grained GitHub token (Contents read/write
on the GitOps repo only).

```bash
# backend + call page, locally against a cluster
cd services/oncall-tools
cp .env.example .env            # fill in the values; "unset" disables an integration
npm install
npm run typecheck && npm test   # 29 unit tests: redaction, action TTL/one-shot, signatures, YAML edit
npm run build && npm start      # http://localhost:8080

# agent, tools and tests as code
cd elevenlabs
export ELEVENLABS_API_KEY=...
elevenlabs agents push --dry-run
elevenlabs agents push
elevenlabs agents test          # runs the attached tests
```

Publishing the image and deploying is GitOps: build `services/oncall-tools` as
`registry.rosenvall.se/carnufex/oncall-tools:sha-<short>`, push, bump the tag in
`deploy/kubernetes/oncall-demo/tools-deployment.yaml` (source of truth in the homelab repo).

### Tool contract

Every tool is `POST /tools/<name>` with `{ incident_id, ... }` and header `X-Oncall-Token`.
Responses are small, flat JSON with a `spoken_summary` written for a voice agent ("three restarts",
"version one point one point zero"). Expected failure modes (`action_expired`, `file_drifted`,
`github_disabled`, …) come back as HTTP 200 with `status: "rejected" | "failed"` and a spoken
explanation, because the tool runtime hides non-2xx bodies from the model.

| Tool | Reads | Writes |
|---|---|---|
| `get_incident`, `get_pod_status`, `get_pod_logs`, `get_recent_events`, `get_recent_changes` | k8s API (RBAC-scoped), GitHub commit history | – |
| `propose_action` | ReplicaSet history / Git history for the rollback target | in-memory plan with TTL |
| `execute_action` | – | one Git commit on one file, one ArgoCD refresh annotation |
| `verify_health` | k8s API, polls up to 90 s | marks incident mitigated |
| `resolve_incident`, `add_note` | – | Slack thread, Slack call end |

## Design decisions

- **Why a voice copilot for on-call.** It is a real workflow with a real reason to be voice-first
  (you are on a phone, not at a keyboard), it needs tools that read and act, and the safety
  question is unavoidable. It also happens to be my own infrastructure, so nothing is mocked.
- **Why GitOps for the write path.** The agent never needs cluster write permissions, the commit
  is a durable audit record, and ArgoCD would revert an imperative change anyway. The cost is
  a 10–40 s sync delay, which `verify_health` waits out while the agent talks.
- **Why the confirmation lives in the backend.** Prompts are guidance; an `action_id` that only
  exists after a plan was produced, expires, and can be used once is a guarantee.
- **Why spoken summaries in tool responses.** The model gets a sentence it can say, plus the
  structured fields for follow-ups. It cut hallucinated details in testing and keeps turns short.
- **Why a custom call page instead of the hosted widget.** The page passes the incident as
  dynamic variables, shows tool calls as they happen (good for the demo, good for trust), and
  reports the conversation id back so the post-call webhook can find the incident.
- **Model choice.** `gpt-4.1` at temperature 0.2 for reliable tool calling; `eleven_flash_v2`
  for latency; George as the voice for a calm, clear on-call tone.

## Known limitations

- Incident state is in memory (single replica). A restart loses open incidents; the detector
  reopens one if the pod is still crashing.
- The call page is reachable by anyone with the unguessable incident URL; sessions are minted
  server-side with the workspace key. Production would put it behind SSO.
- Only one action type (`rollback`) and one allow-listed service. Adding a service is one env var
  plus the RBAC label selector.
- GitHub Actions is disabled on this account; images are built and pushed locally.

## What I would do next

- Transfer to a human (Twilio/SIP) for the "escalate to secondary" path; the tool and prompt hooks exist.
- Multi-agent: a triage agent on a cheap model handing over to the SRE agent with the write tools.
- Alertmanager as the real alert source (the detector is a stand-in for it).
- Persist incidents (SQLite) and stream tool events to the page over SSE instead of polling.

## Verification log

- Kubernetes RBAC: 18 `kubectl auth can-i` checks, all as expected (table above).
- Backend: `npm run typecheck` clean, `npm test` 29/29, container built and deployed.
- Live drill: manual `1.0.0 → 1.1.0` commit; detector opened the incident within one poll (10 s);
  all read tools returned correct data; `propose_action` produced the right plan from ReplicaSet
  history; `execute_action` and the one-shot/expiry rules behaved as specified.
- ElevenLabs tests: 4/4 unit tests passing; end-to-end simulation against the live tools passing
  (logs → changes → propose → yes → execute → truthful report → end call).
