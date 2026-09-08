# Submission notes (paste into Ashby)

**Agent:** On-call Voice Copilot — `agent_1501m20j4f41fv1td9c3mvmkhek8`
(hands over to Access Support Specialist — `agent_4801m20wd546enxb46bnfyvw8dmk`)

**Example conversation:** `conv_…` (fill in from the recorded run; a verified earlier run is
`conv_4201m20w1mj1feyvgcgn4vr60n8t`: 5/5 evaluation criteria, confirmation obtained, rollback
executed and verified)

**Loom:** (link)

**Repository:** https://github.com/carnufex/oncall-voice-copilot — README is the handoff doc; `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`,
`docs/SPEC.md`.

**One paragraph.** An on-call voice copilot for a Kubernetes cluster. A Slack slash command
deploys a broken version through GitOps; the backend detects the CrashLoopBackOff, opens an
incident and posts a Slack call card; the engineer answers in the browser (WebRTC, React SDK)
and the agent diagnoses with ten webhook tools (pod status, redacted logs, events, Git history)
against a real cluster, proposes a rollback, executes it only after an explicit yes (a two-step
action enforced in the backend with an expiring action id), verifies the rollout, resolves the
incident and hands over password requests to a second agent with its own guardrails. The
post-call webhook posts the summary, data collection and evaluation results to the Slack thread
and opens a postmortem issue in the GitOps repo. Everything is real (my homelab cluster, real
commits, real rollouts) and everything is code: agents, tools and tests via the ElevenLabs CLI,
the cluster side via ArgoCD. Safety is layered: RBAC scoped to one namespace with no secrets,
an allowlist and redaction in the backend, the two-step action, guardrails, evaluation criteria,
and seven agent tests including a prompt-injection drill where the crashing service's logs try
to instruct the agent.
