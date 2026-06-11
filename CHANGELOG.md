# Changelog

All notable changes to the DARM-ANN implementation in this repository.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added — testing & docs hardening
- **Chaos / soak harness** (`darm-ann/chaos.js`, `npm run darm:chaos`): runs the
  multi-process BFT cluster through many heights while randomly killing and
  restarting validators (WAL recovery), asserting liveness + safety (no fork) —
  per-height and final whole-run agreement.
- **Network-partition chaos** (`--partition`, `npm run darm:chaos:partition`):
  splits the cluster so neither side has a quorum, asserts NO progress during
  the split (safety), then heals and asserts progress resumes with agreement.
  This surfaced and fixed a real harness bug (the BFT node was overwriting the
  partition-aware transport dispatcher via autoConnect).
- **Performance-regression gate** in the benchmark (`--min-tps=N` /
  `BENCH_MIN_TPS`): best-of-iterations throughput must meet the SLO or the run
  fails. Wired into CI.
- **OpenAPI 3.1 spec** (`darm-ann/openapi.yaml`, 25 paths) served at
  `GET /darm/openapi.yaml` with a Swagger UI at `GET /darm/docs`.
- CI: chaos/soak + partition smokes, performance-regression gate, OpenAPI
  validation, an in-cluster docs/spec/version check in the kind job, and
  multi-arch (amd64 + arm64) image builds with provenance + SBOM in the release.

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
