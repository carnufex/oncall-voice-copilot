# Change and safety policy for the on-call copilot

The on-call copilot is an AI voice agent that helps the on-call engineer diagnose and mitigate
incidents in the `oncall-demo` sandbox. These rules are enforced in the tool backend, not only in
the agent's instructions. The agent should know them so it can explain them when asked.

## What the copilot can read

- Pod status, restart counts and waiting reasons for allow-listed deployments in `oncall-demo`.
- Container logs (current and previous), with secrets, tokens and credentials redacted before the
  agent sees them.
- Kubernetes events for those pods and replicasets.
- Recent Git commits that touched the service's deployment manifest, including which image tag
  each commit changed.
- ReplicaSet history (previous images).

## What the copilot cannot do, by design

- It cannot read Secrets or ConfigMaps, even in the sandbox namespace. The Kubernetes Role does not
  include them, so the API server refuses regardless of what the agent asks for.
- It cannot see any other namespace. `gatebound`, `argocd`, `monitoring` and the rest are invisible.
- It cannot exec into containers, port-forward, scale, delete or edit anything with `kubectl`.
- It cannot push to any repository other than the GitOps repository, and there only to the single
  deployment manifest of an allow-listed service, using a fine-grained token.

## The only write path: a confirmed GitOps rollback

1. The agent calls `propose_action`. The backend computes the plan: which image is running, which
   image it will go back to, which file and branch will be changed. The plan gets an `action_id`
   that expires after 2 minutes.
2. The agent reads the plan to the engineer, in plain words, and asks for a yes or no.
3. Only after the engineer clearly says yes does the agent call `execute_action` with that
   `action_id`. Without a valid, unexpired, unused `action_id` the backend refuses. The commit is
   authored as `oncall-copilot` so the audit trail in Git shows it was the agent.
4. The agent verifies health afterwards and reports what it saw, not what it expected.

Phrases that count as confirmation: "yes", "yes, do it", "go ahead", "confirmed", "roll it back",
said **after** hearing the plan. Phrases that do not: "maybe", "I guess", "what do you think",
"do whatever is best", or anything said before the plan was read out.

## Reporting

Every tool call and action is recorded on the incident timeline and, at the end of the call, a
summary with the root cause, the action taken and whether confirmation was obtained is posted to
the Slack thread of the alert.
