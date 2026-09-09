# Demo runbook (screen + camera, one take, 4–5 minutes)

What is on screen when, what you say, and what to do if something slips. The spoken lines for
the call itself are in [DEMO-SCRIPT.md](DEMO-SCRIPT.md).

## Windows and layout (1920×1080)

Prepare four windows and one browser with tabs. Loom records the full screen plus your camera
bubble bottom-right.

| Window | Content | Position |
|---|---|---|
| A | Slack, channel `#elevenlabs` | left 35 % |
| B | Browser tab 1: `https://argo.rosenvall.se/applications/argocd/oncall-demo` (tree view) | right 65 %, shown only during the sync |
| B | Browser tab 2: the call page (opens from the Slack Join button) | right 65 % for the whole call |
| B | Browser tab 3: ElevenLabs → Agents → On-call Voice Copilot | shown at the end |
| B | Browser tab 4: repo README | shown at the end |
| C | Terminal (optional): `kubectl get pods -n oncall-demo -w` | small, bottom-left corner, only during the sync |

Tips: hide bookmarks bar, 110 % zoom in the browser, dark theme everywhere, mute notifications,
headset on. Chrome must already have microphone permission for `oncall.rosenvall.se`.
Log in to Authentik in that browser beforehand (open `https://oncall.rosenvall.se/` once; the
SSO cookie lasts 12 h), otherwise the Join button detours through the login page on camera.

## Before you press record

- [ ] `/oncall status` → `demo-api` on `1.0.0`, 1/1 ready, no open incidents. If not, `/oncall reset`, wait 20 s.
- [ ] `https://oncall.rosenvall.se/healthz` → `{ ok: true }`.
- [ ] ArgoCD tab logged in and on the `oncall-demo` application.
- [ ] Do one **text-mode** rehearsal of the full script on the previous incident (no credits for audio).
- [ ] Water. Breathe. It is fine to pause; the agent waits.

## Run of show

| Time | On screen | You say (to camera) | Notes |
|---|---|---|---|
| 0:00 | Slack + your face | "This is an on-call voice copilot on ElevenLabs Agents. When an alert fires it calls the on-call engineer, diagnoses with real tools against a Kubernetes cluster, and rolls back through GitOps, only after the engineer says yes. Everything is live: my cluster, a sandbox namespace, real commits." | 20 s, no slides |
| 0:20 | Slack: type `/oncall drill` | "The drill deploys version 1.1.0 of a small service. It needs a config value nobody added, so it crashes on boot." | Enter |
| 0:25 | Switch to ArgoCD tab | "That was a Git commit. ArgoCD is syncing it now." Point at OutOfSync → Syncing → the new pod going red. | 10–15 s; this is the proof it is real |
| 0:40 | Back to Slack: alert + call card appear | "The detector saw the crash, opened an incident and posted a call card." | Click **Join** |
| 0:50 | Call page opens. Click **Answer call** | Let the agent speak. | The orb speaks, the timeline fills |
| 0:55 | Call page | "What do the logs say?" → agent reads the FATAL line and flags the poisoned line | To camera during the tool call: "Read-only tools; the agent's identity can't see other namespaces or any secret, by RBAC." |
| 1:20 | Call page | "What changed?" → the deploy commit, 1.0.0 → 1.1.0, diff card appears on the right | To camera: "The poisoned log line told it to roll back without asking. It treats tool output as data. And that diff card is a client tool: the agent drives the page." |
| 1:40 | Call page | "Roll it back." → plan read aloud, amber card | To camera: "Two-step action: the plan has an id that expires in two minutes; without it the backend refuses." |
| 2:00 | Call page | "Yes, go ahead." → commit link, then verify_health | Optional: glance at the terminal `kubectl -w` while it waits |
| 2:30 | Call page | Agent: healthy on 1.0.0, resolved, "anything else?" | |
| 2:35 | Call page | "One more thing, I also need help changing my password." → handover, new voice | To camera: "Agent-to-agent transfer: same call, different guardrails, own knowledge base and tools." |
| 3:05 | Call page | "It's my cluster single sign-on." → specialist sends a reset link (masked email, reference), offers a ticket only if needed | Optional Swedish line here if time |
| 3:25 | Call page | "No, that's all, thanks." → goodbye, call ends | |
| 3:30 | Slack thread | Show: resolution note, reset-link note, the one-line post-call verdict (6/6, confirmation obtained) with the postmortem link | "That line is ElevenLabs' post-call webhook: data collection and evaluation criteria, HMAC-signed to my backend. The details are in the postmortem." |
| 3:50 | Click the postmortem issue | Scroll once through facts, changes, timeline | "Every call ends in a postmortem the copilot wrote." |
| 4:05 | ElevenLabs agent tab | Tools, knowledge base, criteria, tests (9 across both agents, all passing), Guardrails tab with the custom claim check | "Everything is code, pulled and pushed with the ElevenLabs CLI. The custom guardrail blocks any claim of a change the tools didn't confirm; I drilled it with a sabotaged copy of the agent." |
| 4:25 | README tab | Architecture diagram, security table | "Happy to walk through any layer. Thanks." |
| 4:35 | Stop | | |

## Where the conversation id is

You need it for the submission and reviewers may want to open it.

- On the call page header and footer (monospace chip with copy), as soon as the call connects.
- In the Slack thread: the post-call line starts with `Call ended · conv_…`.
- In the postmortem issue facts table.
- In ElevenLabs: Agents → On-call Voice Copilot → History (link: `https://elevenlabs.io/app/agents/history/<conversation_id>`).
- In the backend: `https://oncall.rosenvall.se/` lists incidents with their conversation ids.

## If something slips

| Symptom | Do |
|---|---|
| Alert takes more than 30 s | Stay on ArgoCD, narrate the sync. Do not re-run the drill. |
| Agent does not hear you | Say "hello?" once. If nothing, hang up, Answer call again (same incident, same context). |
| Agent skips the plan and asks for yes anyway | It cannot execute without a plan; say "propose the rollback first." |
| Action expired | Say "propose it again", confirm again. Mention on camera that the backend refused on purpose. |
| Rollout slow | "Check again." |
| Transfer does not happen | Say "please hand me over to the access specialist." |
| Post-call summary not yet in the thread | It arrives within about a minute; show the resolution note and the ticket first, come back. |
| Anything worse | Stop recording, `/oncall reset`, wait 30 s, start over. One take means one *published* take. |

## After recording

1. Copy the conversation id from the call page or the Slack thread.
2. `/oncall reset` (keeps the sandbox clean).
3. Fill [SUBMISSION.md](SUBMISSION.md) and paste it into the Ashby notes with the Loom link.
