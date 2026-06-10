# Deploying DARM-ANN

Three ways to run a DARM-ANN cluster, smallest to largest.

## 1. Docker Compose (local / single host)

```bash
docker compose up --build
# nodes:      http://localhost:3001..3003/darm/dashboard
# monitor:    http://localhost:3001/darm/monitor
# Grafana:    http://localhost:3000   Prometheus: :9090   Alertmanager: :9093
```

## 2. Kubernetes — plain manifests

A 3-replica StatefulSet (stable per-pod identity + per-pod PVC for the LTM
snapshot), headless + client Services, a token Secret, and a ServiceMonitor.

```bash
# edit the Secret tokens first!
kubectl apply -f deploy/k8s/darm-ann.yaml
kubectl -n darm-ann get pods
kubectl -n darm-ann port-forward svc/darm-ann 3001:3001
```

## 3. Kubernetes — Helm

```bash
helm install darm deploy/helm/darm-ann \
  --namespace darm-ann --create-namespace \
  --set tokens.api="op-secret:operator,ro-secret:read" \
  --set tokens.cluster="cluster-secret" \
  --set image.tag=latest
```

Key `values.yaml` knobs: `replicaCount`, `image.*`, `tokens.*`, `persistence.*`,
`resources`, `serviceMonitor.enabled`, and `config.*` (snapshot interval, TTL
min-age, audit file, rate limits, auto-remediation).

### Notes

- **Image**: build once with `docker build -t darm-ann:latest .` and push to a
  registry your cluster can pull from (set `image.repository`/`tag`).
- **Identity**: each pod's self URL is its stable headless DNS name, so peers
  address each other deterministically.
- **Persistence**: the LTM snapshot + audit log live on a per-pod PVC and are
  restored on restart; `terminationGracePeriodSeconds` lets the snapshot-on-
  shutdown finish.
- **Security**: set real tokens in the Secret. Inter-node gossip uses
  `DARM_CLUSTER_TOKEN`. For consensus mTLS between pods, mount a CA + per-pod
  certs and pass them to the transport (see `darm-ann/consensus/certs.js`).
- **Monitoring**: the ServiceMonitor requires the Prometheus Operator;
  otherwise scrape `/darm/metrics` however you prefer.
