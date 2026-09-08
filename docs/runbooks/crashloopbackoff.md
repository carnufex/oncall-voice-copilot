# Runbook: CrashLoopBackOff on a Kubernetes Deployment

**Applies to:** any Deployment in the `oncall-demo` sandbox (currently `demo-api`).
**Owner:** platform on-call. **Severity:** P2 by default (single replica, no customer traffic in the sandbox).

## What the symptom means

`CrashLoopBackOff` means the container starts, exits with a non-zero code, and Kubernetes waits an
increasing back-off (10 s, 20 s, 40 s ... up to 5 min) before restarting it. The pod is **not**
crashing because of a scheduling or image problem; the process itself is exiting. Compare with:

| Waiting reason | Meaning | Where to look |
|---|---|---|
| `CrashLoopBackOff` / `Error` | process exits after starting | **previous** container logs |
| `ImagePullBackOff` / `ErrImagePull` | image or tag does not exist, or registry auth failed | events, image reference |
| `CreateContainerConfigError` | a referenced Secret or ConfigMap key is missing | events |
| `Pending` | no node has room, or a PVC is not bound | events |

## Diagnosis order (fastest to slowest)

1. **Pod status** – confirm the reason, restart count and how long it has been going on.
2. **Previous container logs** – the last lines before exit almost always name the cause. Look for
   `FATAL`, `ERROR`, `panic`, `exception`, `not set`, `missing`, `refused`, `denied`.
3. **Recent changes** – what was deployed, when, by whom. If the crash started right after a
   deploy, the deploy is the prime suspect (**"what changed?" beats "what is broken?"**).
4. **Events** – only if logs are empty (for example a wrong entrypoint or an OOM kill; OOM shows
   `OOMKilled` as the last termination reason).

## Common root causes and the fix

| Log signature | Root cause | Correct action |
|---|---|---|
| `... is not set`, `missing required config`, `required since <version>` | new version needs config the manifests do not provide | **Roll back** to the previous image, then open a ticket to add the config and redeploy |
| `connection refused` / `ECONNREFUSED` to a dependency | dependency down or wrong host | fix the dependency; do not roll back the caller |
| `permission denied` on a file or port `< 1024` | container runs as non-root but needs privileges | fix the manifest (securityContext / port), roll back if it was introduced by the last deploy |
| `OOMKilled` | memory limit too low or a leak | raise the limit or roll back if it regressed |
| `no such file`, `exec format error` | wrong image architecture or broken build | roll back |

## Mitigation policy: rollback first, fix forward second

For a single-replica sandbox service that crashed right after a deploy, the correct mitigation is
to **roll back to the last known-good image**. Fix-forward (adding the missing config) is done
afterwards through a normal pull request, not from the on-call call.

Rollbacks in this cluster are **GitOps only**: the on-call copilot commits the previous image tag to
`kubernetes/applications/<app>/` in the `Rosenvalls-Homelab` repository and ArgoCD applies it.
Nobody, human or agent, runs `kubectl set image` or `kubectl rollout undo` against the cluster,
because ArgoCD self-heal would revert it within minutes anyway.

A rollback requires **explicit confirmation from the on-call engineer** after they have heard
exactly which image will be replaced by which. "Do whatever you think is best" is not
confirmation. Silence is not confirmation.

## Verification after a rollback

A rollback is done when **all** of these hold:

- the Deployment reports ready replicas equal to desired replicas,
- the running pod's image is the target image,
- the pod has been `Running` and `Ready` with no new restarts for at least 30 seconds.

ArgoCD typically applies a refreshed commit in 10–40 seconds; pod start adds 5–15 seconds.

## Escalation

Escalate to the secondary on-call if the rollback does not restore health within 3 minutes, if the
previous image also crashes, or if the failure is in a dependency outside the sandbox.
