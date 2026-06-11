# Changelog

All notable changes to the DARM-ANN implementation in this repository.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added — production-readiness pass
- `/darm/version` (build/version info) and `/darm/ready` (readiness probe);
  `darm_build_info` Prometheus metric; version surfaced in `/darm/health`.
- **Integration test harness** (`darm-ann/integration.test.js`, `npm run
  darm:integration`): boots the real server and exercises the full HTTP API —
  version/health/ready, RBAC, rate limiting, the teach→observe→consolidate→query
  lifecycle, gossip mempool, tasks/monitor, audit, metrics, and a
  backup→restore round-trip across two server instances. 10 tests.
- Helm chart hardening: non-root `podSecurityContext`/`securityContext`,
  read-only root FS (+ `/tmp` emptyDir), and an opt-in `NetworkPolicy`.
- Dockerfile runs as the non-root `node` user; build-arg version injection
  (`GIT_COMMIT`, `BUILD_TIME`).

### Added — earlier in this branch
- DARM-ANN v6.0 memory architecture: real ANN (`nn/`), STM + LTM blockchains,
  weighted Markov chain-graph, SLM/TinyLM navigation, RRC, RCE, GTE, ESE, BVAS.
- Multi-round, leader-rotating BFT consensus with Ed25519-signed messages,
  WAL crash recovery, mTLS transport, in-process + TCP transports.
- Replicated state machine: live validator membership via consensus, shared-LTM
  replication, new-node TCP join with state-sync.
- Gossip transaction mempool; CDCP consensus-driven consolidation.
- Persistence (periodic + on-shutdown snapshots), backup/restore tooling and
  endpoints (`/darm/backup`, `/darm/restore`).
- Observability: Prometheus metrics, Grafana dashboard, alert rules +
  Alertmanager, alert-driven auto-remediation, task monitor (SSE).
- Security: RBAC scoped tokens, per-token rate limiting, audit log, server TLS,
  inter-node auth.
- Operator tooling: CLI, dashboard, monitor view.
- Deployment: Docker, Docker Compose (+ Prometheus/Grafana/Alertmanager),
  Kubernetes manifests, Helm chart (HPA, PDB, NetworkPolicy, ServiceMonitor).
- CI: unit + integration tests, demo, multi-process consensus + RSM smokes,
  benchmark, load test, Docker/compose smokes, kind e2e (with PVC restore
  drill), signed release (image + SBOM + cosign).
- Getting-started tutorial (`darm-ann/TUTORIAL.md`).

### Tests
- 87 unit/integration tests (`npm run darm:test`).
- 10 HTTP integration tests (`npm run darm:integration`).
