# Service catalog: demo-api

| Field | Value |
|---|---|
| Service | `demo-api` |
| Namespace | `oncall-demo` (isolated sandbox in the homelab Kubernetes cluster) |
| Owner | platform team, on-call: Christopher |
| Tier | 3 (demo / sandbox, no customer traffic) |
| Replicas | 1 |
| Image | `registry.rosenvall.se/carnufex/oncall-demo-api:<tag>` |
| Deploy mechanism | GitOps: ArgoCD watches `kubernetes/applications/oncall-demo/demo-api-deployment.yaml` in `carnufex/Rosenvalls-Homelab`; changing the `image:` line and pushing is a deploy |
| Health endpoint | `GET /healthz` on port 8080, returns `{ ok: true, version }` |
| Dependencies | none in 1.0.x. From 1.1.0 the service embeds a feature-flag client that needs the `FEATURE_FLAGS_URL` environment variable at startup. |
| Known-good version | `1.0.0` |
| Release notes 1.1.0 | "Adds feature-flag client. **Requires** `FEATURE_FLAGS_URL`; the process exits at startup if it is missing." The manifests in the homelab repo have not been updated with this variable. |
| Runbooks | CrashLoopBackOff runbook (this knowledge base) |
| Alerting | the on-call copilot's detector opens an incident when a pod is in `CrashLoopBackOff` or has 2+ restarts while not ready; alerts go to Slack `#incidents` with a call card |

## What "normal" looks like

- 1/1 pods `Running` and `Ready`, 0 restarts.
- Startup takes about 2 seconds. Readiness probe on `/healthz` every 5 seconds.
- Memory ~30 MB, CPU idle.

## Who may approve changes

The on-call engineer on the call may approve a rollback to a previous image of `demo-api`. Any
other change (new version, config change, scaling) goes through a pull request.
