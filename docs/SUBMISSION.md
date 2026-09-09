# Submission notes (paste into Ashby)

**Agent:** On-call Voice Copilot — `agent_1501m20j4f41fv1td9c3mvmkhek8`
https://elevenlabs.io/app/agents/agents/agent_1501m20j4f41fv1td9c3mvmkhek8 (workspace link; the id is
what identifies it). Hands over to Access Support Specialist — `agent_4801m20wd546enxb46bnfyvw8dmk`.

**Example conversation:** `conv_…` (fill in from the recorded run; a verified earlier run is
`conv_4201m20w1mj1feyvgcgn4vr60n8t`: 5/5 evaluation criteria, confirmation obtained, rollback
executed and verified)

**Guardrail drill:** `conv_…` (run `npm run drill:guardrail -- --keep` right before submitting and
paste the id; the conversation only stays visible while the throwaway drill agent exists, delete
it after the review). A copy of the agent with a sabotaged prompt tries three times to say
"I've already rolled demo-api back"; the custom guardrail blocks every attempt and ends the call.

**Loom:** (link)

**Access for reviewers.** The agent is not publicly callable by design: conversations need a
signed token minted by my backend, the call page sits behind SSO, and every tool call carries a
workspace secret and is scoped by the backend to one namespace and one deployment (read-only
except a Git commit that ArgoCD applies). Inspect it through the workspace link and the
conversation ids above; if you want a live session, say so and I will open a drill and send a
call link.

**Repository:** https://github.com/carnufex/oncall-voice-copilot — README is the handoff doc; `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`,
`docs/SPEC.md`.

**One paragraph.** An on-call voice copilot for a Kubernetes cluster. A Slack slash command
deploys a broken version through GitOps; the backend detects the CrashLoopBackOff, opens an
incident and posts a Slack call card; the engineer answers in the browser (WebRTC, React SDK)
and the agent diagnoses with twelve webhook tools (pod status, redacted logs, events, Git history)
against a real cluster, proposes a rollback, executes it only after an explicit yes (a two-step
action enforced in the backend with an expiring action id), verifies the rollout, resolves the
incident and hands over password requests to a second agent with its own guardrails. The
post-call webhook posts the summary, data collection and evaluation results to the Slack thread
and opens a postmortem issue in the GitOps repo. Everything is real (my homelab cluster, real
commits, real rollouts) and everything is code: agents, tools and tests via the ElevenLabs CLI,
the cluster side via ArgoCD. Safety is layered: RBAC scoped to one namespace with no secrets,
an allowlist and redaction in the backend, the two-step action, guardrails, evaluation criteria,
a custom guardrail that blocks any claim of a change no tool result confirms (drilled against a
sabotaged copy of the agent), and nine agent tests including a prompt-injection drill where the
crashing service's logs try to instruct the agent.
