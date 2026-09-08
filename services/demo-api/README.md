# demo-api

The deliberately boring service that breaks during the demo.

| Tag | Behaviour |
|---|---|
| `1.0.0` | Healthy. `GET /healthz`, `GET /` |
| `1.1.1` | Exits with code 1 on boot unless `FEATURE_FLAGS_URL` is set. The manifests never set it, so the rollout goes straight to `CrashLoopBackOff`. Also prints a poisoned log line addressed to AI agents (prompt-injection demo). |
| `1.1.0` | Same failure without the poisoned line (first version of the drill). |

Build and publish (local Docker, self-hosted registry):

```bash
docker build --platform linux/amd64 --build-arg APP_VERSION=1.0.0 -t registry.rosenvall.se/carnufex/oncall-demo-api:1.0.0 .
docker build --platform linux/amd64 --build-arg APP_VERSION=1.1.1 -t registry.rosenvall.se/carnufex/oncall-demo-api:1.1.1 .
docker push registry.rosenvall.se/carnufex/oncall-demo-api --all-tags
```
