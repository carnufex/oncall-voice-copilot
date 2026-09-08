# Kubernetes manifests (mirror)

Source of truth is the GitOps repository `carnufex/Rosenvalls-Homelab`:

- `kubernetes/applications/oncall-demo/` -> `deploy/kubernetes/oncall-demo/` (namespace, victim service, tool backend, RBAC, secrets, route)
- `kubernetes/infrastructure/controllers/argocd/oncall-demo-refresh-rbac.yaml` -> `deploy/kubernetes/argocd/`

This copy exists so reviewers can read the manifests without access to the private homelab repo. Copied 2026-09-08; the homelab repo wins on any difference.
