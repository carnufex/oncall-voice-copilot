# oncall-demo — sandbox for the on-call voice copilot

Isolated namespace for the ElevenLabs "on-call voice copilot" demo
(source: `carnufex/oncall-voice-copilot`). Nothing here is part of daily
operation; it can be deleted by removing this folder.

| Resource | Purpose |
|---|---|
| `demo-api` Deployment | Victim service. `oncall-demo-api:1.0.0` is healthy, `1.1.0` crashes on boot. The tag in `demo-api-deployment.yaml` is the only thing the copilot changes, and only through Git commits. |
| `oncall-tools` Deployment | Tool backend for the agent (webhook tools, Slack `/oncall`, call page, post-call webhook, CrashLoop detector). Public at `oncall.rosenvall.se`. |
| `oncall-tools` ServiceAccount + Role | Read-only on pods, pods/log, events, deployments, replicasets in this namespace. No secrets/configmaps/exec. |
| `oncall-demo-refresh` Role (in `argocd`, see `infrastructure/controllers/argocd/oncall-demo-refresh-rbac.yaml`) | `get`/`patch` on the single Application `oncall-demo` so the backend can set the `argocd.argoproj.io/refresh` annotation after a commit instead of waiting for the 3 min poll. |
| `oncall-tools-secrets` ExternalSecret | Bitwarden keys `ONCALL_*`. Placeholder value `unset` disables that integration. |
| `oncall-tools-oauth2-proxy` Deployment | Authentik SSO (OIDC client `oncall-tools`, blueprint in `authentik-runtime`) in front of the call page and `/api`. `/tools`, `/slack`, `/webhooks`, `/healthz` bypass the session check; they authenticate with their own token/signatures. |

Blast radius: the copilot's identity cannot read any other namespace, cannot
read Secrets or ConfigMaps even here, and its only write paths are (1) a commit
to `demo-api-deployment.yaml` on this repo through a fine-grained GitHub token
limited to this repository and (2) the refresh annotation above.

Publishing the tool image (GitHub Actions is billing-blocked):

```bash
docker build --platform linux/amd64 -t registry.rosenvall.se/carnufex/oncall-tools:sha-<short> services/oncall-tools
docker push registry.rosenvall.se/carnufex/oncall-tools:sha-<short>
# then bump the tag in tools-deployment.yaml and push
```
