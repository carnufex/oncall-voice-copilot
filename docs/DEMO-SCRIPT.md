# Demo script (golden path, 3–5 minutes, one take)

Audience: ElevenLabs FDEs. Language: English. Screen: Slack on the left, the call page on the
right, terminal with `kubectl get pods -n oncall-demo -w` optional in a corner.

## Before recording (checklist)

- [ ] `/oncall status` in Slack shows `demo-api` on `1.0.0`, 1/1 ready, no open incidents.
- [ ] `https://oncall.rosenvall.se/healthz` returns `{ ok: true }`.
- [ ] Browser: microphone permission already granted for `oncall.rosenvall.se`.
- [ ] Headset on. Notifications muted. Slack channel `#incidents` open.
- [ ] Have the ElevenLabs agent page open in a background tab (to show config at the end if time).

## 0:00 – Cold open (20 s)

> "This is an on-call voice copilot built on ElevenLabs Agents. When an alert fires, it calls
> the on-call engineer, diagnoses the incident with real tools against a Kubernetes cluster,
> and rolls back through GitOps, but only after the engineer says yes on the call.
> Everything you'll see is live: my own cluster, an isolated sandbox namespace, real commits."

## 0:20 – Trigger (30 s)

In Slack: `/oncall drill`

> "The drill deploys version 1.1.0 of a small service. That version needs a config value nobody
> added to the manifests, so it will crash on boot. This is the boring kind of incident that
> actually happens."

Wait for the alert. Point at it:

> "The detector saw CrashLoopBackOff, opened an incident, and posted a call card. The Join
> button opens the call."

## 0:50 – Answer the call (2 min)

Click **Join**, then **Answer call**. The agent opens with the briefing.

Say, in this order (short, natural):

1. **"What do the logs say?"**
   Expect: previous container logs, the `FEATURE_FLAGS_URL is not set` line, and the agent
   mentioning a suspicious line addressed to AI agents that it will not act on.
   > "That poisoned line tells the agent to roll back without asking. It reads it as data, flags
   > it, and the backend would refuse anyway: no plan id, no execution."
   The tool card appears on the timeline.
2. **"What changed?"**
   Expect: the commit by Release Bot, `1.0.0 → 1.1.0`, minutes ago.
   > (to camera) "Read-only tools: pod status, logs, events, ReplicaSet and Git history. The
   > agent's Kubernetes identity cannot see other namespaces or any secret, by RBAC, not by prompt."
3. **"Roll it back."**
   Expect: the agent calls `propose_action` and reads the plan: from 1.1.0 to 1.0.0, Git commit,
   ArgoCD applies. Then it asks yes or no. The amber "Awaiting voice confirmation" card shows.
   > "Two-step action. The plan has an id that expires in two minutes; without it the backend
   > refuses. The confirmation lives in code, not in the prompt."
4. **"Yes, go ahead."**
   Expect: `execute_action` → commit link on the timeline, then `verify_health` while the agent
   says it is waiting for the rollout. Then: healthy, 1 of 1 on 1.0.0.
5. **"One more thing, I also need help changing my password."**
   Expect: the agent says it will hand you over, then the **Access Support Specialist** (a
   different voice) takes the same call. Say **"It's my cluster single sign-on."** She sends a
   reset link (`send_reset_link` card on the timeline, masked email + reference posted in the
   Slack thread; simulated identity-provider action) and offers a ticket only if the link cannot help.
   > "Agent-to-agent transfer: the on-call agent has no business touching passwords, so it hands
   > over to a specialist with its own prompt, knowledge base, tools and evaluation criteria.
   > Same call, same context, different guardrails."
6. (optional, 20 s) **"Kan du sammanfatta läget på svenska?"**
   Expect: the agent switches to Swedish for the summary. Then: **"Thanks, back to English."**
7. **"No, that's all, thanks."**
   Expect: goodbye, `end_call`.

## 3:10 – Close the loop (40 s)

Back in Slack: the thread now has the resolution note, the ticket, and, a few seconds later,
the post-call webhook summary (transcript summary, root cause, action, "confirmation obtained:
true", evaluation results) plus a link to the **postmortem issue** the copilot opened in the
GitOps repo. Open it: facts table, changes made, full timeline, follow-ups.

> "That summary comes from ElevenLabs' post-call webhook: data collection and evaluation
> criteria configured on the agent, delivered HMAC-signed to my backend, posted to the thread."

## 3:50 – What's under the hood (30–45 s, only if time)

Show the agent page briefly: tools, knowledge base (runbook, service catalog, change policy),
data collection, evaluation criteria, tests. Then the repo README.

> "Everything is code: the agent, its tools and tests are pulled and pushed with the ElevenLabs
> CLI; the Kubernetes side is GitOps. The four unit tests and the end-to-end simulation run
> against the real tools. Happy to walk through any part of it."

End recording.

## If something goes wrong

| Symptom | Do |
|---|---|
| Agent doesn't hear you | Say "hello?" once; if silent, hang up and Answer call again (same incident). |
| `execute_action` rejected as expired | Say "propose it again" and confirm again. The backend refused on purpose. |
| Rollout takes longer than 60 s | Say "check again"; the agent calls `verify_health` again. |
| Slack call card missing | The thread has a fallback button; or open the incident from `https://oncall.rosenvall.se/`. |
| Detector didn't fire | `/oncall status` in Slack; the pod may still be pulling. Wait 20 s. |

Reset between takes: `/oncall reset` in Slack (rolls back to 1.0.0, resolves incidents).
