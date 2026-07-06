# Changelog

All notable changes to the DARM-ANN implementation in this repository.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [7.2] — Distributed AI Lens (substrate-agnostic fabric)

Implements the DARM-ANN v7.2 whitepaper: each deployment becomes an **Autonomous
Cognitive System (ACS)** that routes jobs between subnets. `paperVersion` bumped
6.0 → 7.2; OpenAPI `version` 7.2 (39 paths, `fabric` tag).

- **ACS identity + capability advertisements** (`fabric/acs.js`, Part II §2.2):
  Ed25519 identity = ACSN; signed, TTL-scoped ADVERTISE/WITHDRAW; peering policy.
- **Routing Information Base** (`fabric/rib.js`, §2.3): verified advertisements +
  peering graph; no directory authority.
- **DIRP-1 routing** (`fabric/dirp.js`, §2.4): **trust-pruned Dijkstra over the
  RIB graph** (the GTE's shortest-path primitive over a different graph) with
  ACS-path loop prevention. Implements P63, P64, P81 as testable code.
- **Privacy plane** (`fabric/privacy.js`, Part III): confidential-execution
  ladder (`redact`/`attested`/`blind`/`sealed`) + `privacy_mode` + real onion
  routing (X25519 per-hop, ≥3 relays, size-class padding) — P65. Rung-0
  redaction mandatory in onion mode.
- **CCIL** (`fabric/ccil.js`, Part IV): role ladder LEAF→RELAY→ANCHOR→VALIDATOR
  with stake-weighted validator sortition + slashing; PoUI (redundant
  spot-execution, TinyLM-verifier hook) with P67/P68 economics as code.
- **SAL** (`fabric/sal.js`, §4.4/§4.6): five provider classes (CSP/SRP/CEP/MRP/
  TAP) with conformance profiles + Adapter ACS (P79/P80), and the Rail Profile
  Registry (rail-agnostic SETTLE, P82).
- **Fabric facade + endpoints**: full `ADVERTISE→ROUTE→execute→ATTEST→SETTLE`
  lifecycle; `/fabric/{state,advertise,gossip,peer,route,job,rails,adapters}`;
  `darm_fabric_*` metrics.
- **Phase-1 demo** (`darm-ann/fabricDemo.js`, `npm run darm:fabric`): the
  roadmap §9.1 exit gate — a cross-ACS job with a verifiable receipt + settlement.
- **Substrate-agnostic core**: fabric modules name no vendor/network/product; a
  CI grep test enforces it (v7.2 §9.2). Docs in `darm-ann/FABRIC.md`.
- **Staging**: `deploy/helm/*/values-staging.yaml`, `STAGING.md` (managed-k8s
  runbook), `.env.example`. CI adds the fabric demo, fabric HTTP smoke, and the
  vendor-name grep test.
- Tests: +30 unit (acs/dirp/privacy/ccil/sal + end-to-end) and a fabric
  integration test. 115 unit + 12 integration green.

## [Unreleased]

### Added — agentic layer
- **Agent tiers** (`darm-ann/agents/tiers.js`): knowledgeable / generalist /
  narrow ("dumb router") / worker (runner-like operating plane).
- **Linked-list agent registry** (`agents/registry.js`, mirroring the repo's
  Chain motif) for agentic registration + tool-capability discovery; the model
  also `observe()`s each registration into memory.
- **Tier-aware router** (`agents/router.js`): dispatches a capability to the
  lowest-capable tier that advertises it, escalating upward; LRU spread.
- **Come-online lifecycle** (`agents/agent.js` + `agents/vpn.js`): join a VPN
  (Tailscale / generic WireGuard / local) → register tier + capabilities →
  heartbeat → deregister on shutdown.
- HTTP endpoints `POST /agents/register|heartbeat|deregister`, `GET /agents`,
  `GET /agents/route`, `GET /agents/escalation`; `darm_agents{tier}` +
  `darm_agents_online` metrics.
- **Deployable templates**: agent Dockerfile with Tailscale built in
  (`deploy/agent/`), and a `darm-agents` Helm chart that deploys a configurable
  fleet of agent tiers. Docs in `darm-ann/AGENTS.md`.
- Tests: agent registry/router/tiers unit tests + a full agentic lifecycle
  integration test (real Agent client → VPN up → register → route → deregister).

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
