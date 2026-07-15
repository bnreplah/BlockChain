# DARM-ANN — First Staging Environment

This is the recommended environment and runbook for the **first staging
deployment**, aligned with the DARM-ANN v7.2 roadmap. The whitepaper's roadmap
(§5.2 / §9.1) marks **Phase 0 (single-ACS reference stack) as done** and names
**Phase 1 (two-ACS peering: `ADVERTISE→ROUTE→execute→ATTEST→SETTLE`)** as the
next stage — which `darm-ann/fabricDemo.js` already demonstrates and staging
should exercise across real nodes.

## Recommended environment: a small managed Kubernetes cluster

Staging should mirror the production topology, which Docker Compose cannot
express (StatefulSet identity, per-pod PVC restore, PodDisruptionBudget during
rolling updates, ServiceMonitor scraping, and the VPN agent mesh).

| Component | Recommendation |
|---|---|
| Cluster | 1 managed k8s cluster, **3 worker nodes @ 2 vCPU / 4 GB** each. GKE Autopilot / EKS / AKS, **or k3s on 3 small VMs** if cost-sensitive. |
| Model tier | `deploy/helm/darm-ann` — 3-replica StatefulSet, PDB `minAvailable: 2`, PVC per pod, non-root, TLS, RBAC tokens. |
| Agent fleet | `deploy/helm/darm-agents` — 1 knowledgeable, 1 generalist, 2 narrow routers, 2 workers (staging sizing). |
| VPN / control plane | **Headscale** (self-hosted Tailscale control) as a small Deployment, **or** a Tailscale tailnet + auth key. Set via `tailscale.loginServer`. |
| Monitoring | **kube-prometheus-stack** (Prometheus Operator) so the chart's `ServiceMonitor` + `monitoring/alerts.yml` light up; Alertmanager → staging Slack/webhook. |
| Ingress | nginx Ingress, TLS-terminated, exposing `/darm/*`, `/agents/*`, `/fabric/*`. Keep `/darm/health|ready|metrics` scrape-reachable. |
| Secrets | k8s Secrets for RBAC tokens, `DARM_CLUSTER_TOKEN`, and `TS_AUTHKEY` (sealed-secrets / External Secrets in a real org). |

**Sizing:** ~3 model pods + ~6 agent pods + monitoring fits comfortably in a
3×(2 vCPU / 4 GB) cluster. CI's `kind-smoke` job already models this exact
install path (helm install → PVC restore drill → authed API smoke) end to end.

Why not Compose for *staging*: Compose is fine as a Tier-0 laptop smoke
(`docker compose up --build` → 3 nodes + Prometheus + Grafana + Alertmanager),
but its nodes are separate LTMs joined by gossip, with no StatefulSet/PVC/PDB or
VPN mesh — so it can't validate the things staging exists to validate.

## Step-by-step

```bash
# 0. Build + push the images (multi-arch handled by the release workflow on a tag).
docker build -t <registry>/darm-ann:staging .
docker build -f deploy/agent/Dockerfile -t <registry>/darm-agent:staging .
docker push <registry>/darm-ann:staging && docker push <registry>/darm-agent:staging

# 1. Cluster + monitoring.
#    (managed cluster of choice, or: k3sup install --host <vm> ...)
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install kps prometheus-community/kube-prometheus-stack -n monitoring --create-namespace

# 2. Namespace + secrets (never commit these).
kubectl create namespace darm-ann
kubectl -n darm-ann create secret generic darm-tokens \
  --from-literal=DARM_TOKENS='ops-secret:operator,ro-secret:read' \
  --from-literal=DARM_CLUSTER_TOKEN='cluster-secret'
kubectl -n darm-ann create secret generic agents-ts   --from-literal=TS_AUTHKEY='tskey-...'
kubectl -n darm-ann create secret generic agents-auth --from-literal=DARM_TOKEN='ops-secret'

# 3. (optional) Headscale control plane for the agent VPN.
#    Deploy Headscale, create an auth key, and set tailscale.loginServer below.

# 4. Model tier.
helm install darm deploy/helm/darm-ann -n darm-ann \
  -f deploy/helm/darm-ann/values-staging.yaml \
  --set image.repository=<registry>/darm-ann --set image.tag=staging

kubectl -n darm-ann rollout status statefulset/darm-ann --timeout=180s

# 5. Agent fleet.
helm install agents deploy/helm/darm-agents -n darm-ann \
  -f deploy/helm/darm-agents/values-staging.yaml \
  --set image.repository=<registry>/darm-agent --set image.tag=staging
```

## Verify (smoke)

```bash
kubectl -n darm-ann port-forward svc/darm-ann 3001:3001 &

# probes + version (must report 7.2)
curl -s localhost:3001/darm/health
curl -s localhost:3001/darm/version        # → "paperVersion":"7.2"

# memory lifecycle (operator token)
AUTH='Authorization: Bearer ops-secret'
C='staging smoke fact'
curl -sf -X POST -H "$AUTH" -H 'Content-Type: application/json' -d "{\"claim\":\"$C\"}" localhost:3001/darm/teach
curl -sf -X POST -H "$AUTH" -H 'Content-Type: application/json' -d "{\"claim\":\"$C\",\"reward\":1}" localhost:3001/darm/observe
curl -sf -X POST -H "$AUTH" localhost:3001/darm/replay
curl -sf -H "$AUTH" "localhost:3001/darm/query?q=staging%20smoke%20fact"   # tier: RRC or LTM

# v7.2 fabric — ACS role + settlement + a routed job
curl -sf -H "$AUTH" localhost:3001/fabric/state           # role: ANCHOR (stake/uptime/bvas)
curl -sf -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"finality_bound":5000,"proof_format":"merkle","escrow_primitive":"htlc","dispute_hook":"arb","denomination":"credit"}' \
  localhost:3001/fabric/rails

# agents registered themselves over the VPN
curl -sf -H "$AUTH" localhost:3001/agents            # stats.byTier populated
curl -sf localhost:3001/darm/metrics | grep darm_fabric   # fabric gauges present
```

## Rollback

- **App state:** each pod snapshots to its PVC and restores on restart; deleting
  a pod recovers its memory automatically. For an off-cluster restore, use
  `POST /darm/backup?download=1` → `POST /darm/restore` (see `darm-ann/backup.js`).
- **Release:** `helm rollback darm <REV>` / `helm rollback agents <REV>`.

## Exit gate → Phase 2

Per the v7.2 roadmap, promote from staging once: a cross-ACS job commits with a
verifiable ATTEST receipt + settlement (the `fabricDemo.js` scenario, run across
real pods), all probes green, and the monitoring stack shows healthy chains and
fabric gauges. Phase 2 (neighborhood mesh: RELAY role, onion mode, GOSSIP trust
convergence) follows.
