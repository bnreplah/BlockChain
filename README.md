# c01n — DARM-ANN Blockchain

A custom Node.js proof-of-work blockchain that now operates as the **Long-Term
Memory (LTM)** tier of a **DARM-ANN v6.0** (*Distributed Agentic Recursive
Memory Network*) memory hierarchy.

## What's here

- **`structures/`** — the original PoW blockchain (`Blockchain.js`) and an
  alternative linked-list chain (`Chain.js`).
- **`app.js`** — the Express API node: mining, transactions, node registration,
  consensus, block explorer, JWT auth, **and the DARM-ANN endpoints**.
- **`darm-ann/`** — the DARM-ANN v6.0 framework: a self-contained, dependency-free
  five-tier memory hierarchy (WM → EB → STM → LTM → RRC) with consensus-driven
  consolidation (CDCP), a replay engine (RCE), poly-chain morphism, and
  cross-chain pollination. **See [`darm-ann/README.md`](darm-ann/README.md).**

**New here? Start with the hands-on [Getting Started tutorial](darm-ann/TUTORIAL.md).**

## DARM-ANN at a glance

The blockchain *is* the long-term memory. DARM-ANN layers fast/ephemeral and
node-local memory tiers in front of it, and only commits a claim to the chain
once a **τ_c quorum of independent voters** validates it (CDCP). It is fully
self-contained — no Redis, no external LLM, no external consensus service — and
substrate-agnostic, with a self-deploying autonomous mode and a swarm that
cross-pollinates validated knowledge between heterogeneous chains.

```bash
npm run darm:test     # run the DARM-ANN test suite (59 tests)
npm run darm:demo     # narrated end-to-end demo
npm run darm:cluster  # multi-process TCP BFT consensus
npm run darm:rsm      # live node-join + shared-LTM replication via consensus
npm run darm:serve    # HTTP node + operator dashboard at /darm/dashboard
docker compose up --build   # 3-node cluster + Prometheus + Grafana dashboards
#   nodes: http://localhost:3001..3003/darm/dashboard
#   Grafana: http://localhost:3000   ·   Prometheus: http://localhost:9090
```

Kubernetes (StatefulSet + Services + Secret + ServiceMonitor) and a Helm chart
live in [`deploy/`](deploy/README.md):
`kubectl apply -f deploy/k8s/darm-ann.yaml` or
`helm install darm deploy/helm/darm-ann`.

CI (`.github/workflows/ci.yml`) runs the test suite, the consensus/RSM
smoke runs, a Docker image build + `/darm/health` smoke, and a `docker compose`
3-node cluster smoke.

## Run a node

```bash
npm install
node app.js 3001 http://localhost:3001
```

DARM-ANN endpoints: `POST /darm/observe`, `GET /darm/query?q=...`,
`POST /darm/teach`, `POST /darm/refute`, `POST /darm/replay`,
`POST /darm/triage`, `GET /darm/state`.
