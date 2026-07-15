# DARM-ANN — Getting Started

A hands-on walkthrough: stand up a node (or a 3-node cluster), teach it facts,
watch them get **consensus-validated** and consolidated into the long-term
memory blockchain, then retrieve them and watch progress live on the monitor.

No prior setup beyond Node.js 18+ (and Docker if you want the cluster). The
DARM-ANN module is **dependency-free**.

---

## 0. What you're running

DARM-ANN is a five-tier memory system on top of a blockchain:

```
Working Memory → Episodic Buffer → Short-Term Memory → Long-Term Memory → Rapid Retrieval Cache
   (per call)      (per agent)        (STM blockchain)    (LTM blockchain)     (O(1) cache)
```

A claim only reaches the **Long-Term Memory blockchain** after a quorum of
independent validators agrees on it (Consensus-Driven Consolidation). So memory
is *collectively validated*, not just asserted.

---

## 1. One node, no Docker

```bash
node app.js 3001 http://localhost:3001
```

Open two things in a browser:

- **Dashboard** — http://localhost:3001/darm/dashboard
- **Task monitor** — http://localhost:3001/darm/monitor

### Teach a fact

Teaching grounds a fact in every validator's knowledge graph (so the cluster
can later agree on it):

```bash
curl -X POST http://localhost:3001/darm/teach \
  -H 'Content-Type: application/json' \
  -d '{"claim":"TLS 1.3 mandates forward secrecy via ephemeral key exchange"}'
```

### Observe it (ingest into the pipeline)

```bash
curl -X POST http://localhost:3001/darm/observe \
  -H 'Content-Type: application/json' \
  -d '{"claim":"TLS 1.3 mandates forward secrecy via ephemeral key exchange",
       "reward":1,"epistemic":{"conf_cal":0.91,"u_ep":0.08}}'
```

The claim now sits in **Short-Term Memory**. Check the tiers:

```bash
curl -s http://localhost:3001/darm/state | python3 -m json.tool
# tiers.STM should be 1, tiers.LTM still 0
```

### Consolidate it (run a replay/consensus cycle)

```bash
curl -X POST http://localhost:3001/darm/replay
```

Watch the **monitor** — you'll see a `replay` task run to completion. A taught,
grounded claim passes consensus and is committed to the **LTM blockchain**:

```bash
curl -s http://localhost:3001/darm/state | python3 -m json.tool
# tiers.LTM is now 1; chains.ltmValid: true
```

> Try the opposite: teach nothing and `observe` a claim no one can validate,
> then `replay`. It stays in STM and **never reaches LTM** — that's collective
> validation working.

### Retrieve it

```bash
curl -s "http://localhost:3001/darm/query?q=TLS%201.3%20forward%20secrecy"
# → {"tier":"RRC","hit":true, ...}  (served from the O(1) cache)
```

The first retrieval after consolidation comes from the Rapid Retrieval Cache —
no reasoning re-run.

### Watch it navigate the chain-graph

As you observe a sequence of related claims, the node builds a weighted Markov
chain-graph and a TinyLM learns the transitions. Ask it to walk:

```bash
curl -s "http://localhost:3001/darm/navigate?q=TLS%201.3%20forward%20secrecy&steps=5"
```

---

## 2. Three nodes with Docker (cluster + dashboards + monitoring)

```bash
docker compose up --build
```

| URL | What |
|-----|------|
| http://localhost:3001/darm/dashboard | node 1 operator UI |
| http://localhost:3001/darm/monitor | node 1 task monitor |
| http://localhost:3000 | Grafana (DARM-ANN Cluster dashboard) |
| http://localhost:9090 | Prometheus |
| http://localhost:9093 | Alertmanager |

Submit a transaction at **any** node — gossip propagates it to the others:

```bash
curl -X POST http://localhost:3001/darm/tx \
  -H 'Content-Type: application/json' \
  -d '{"type":"memory","payload":{"claim":"merkle proofs verify inclusion in log time","reward":1}}'

# It shows up on node 2's mempool:
curl -s http://localhost:3002/darm/mempool
```

Open Grafana → **DARM-ANN Cluster** to watch tier sizes, chain validity, RRC
hit-rate, the Markov graph, validator count, mempool, and task status across all
three nodes.

---

## 3. Operate it from the CLI

```bash
node darm-ann/cli.js --port 3001 state
node darm-ann/cli.js --port 3001 teach "GRPO reduces variance in RL training"
node darm-ann/cli.js --port 3001 observe "GRPO reduces variance in RL training"
node darm-ann/cli.js --port 3001 replay
node darm-ann/cli.js --port 3001 query "GRPO variance reduction"
node darm-ann/cli.js --port 3001 validators
```

---

## 4. Turn on security (production)

```bash
DARM_TOKENS="ops-secret:operator,read-secret:read" \
DARM_RATE_CAPACITY=120 DARM_RATE_PER_SEC=60 \
DARM_AUDIT_FILE=./data/audit.log \
node app.js 3001 http://localhost:3001
```

- `read` tokens can GET; mutations need an `operator` token.
- Every mutation is recorded: `GET /darm/audit` (with an operator/read token).
- `/darm/health` and `/darm/metrics` stay open for probes/scraping.
- CLI: add `--token <token>` (or `DARM_TOKEN=…`).

Serve over HTTPS by also setting `DARM_TLS_CERT` + `DARM_TLS_KEY`.

---

## 5. Back up and restore

```bash
# back up the node's durable state (LTM snapshot + audit log)
node darm-ann/backup.js create ./data backup.json
node darm-ann/backup.js verify backup.json     # checksums + LTM chain integrity

# ...later, on a fresh node, hot-restore over HTTP:
curl -X POST http://localhost:3001/darm/restore \
  -H 'Content-Type: application/json' \
  -d "{\"path\":\"$(pwd)/backup.json\"}"
```

The node verifies the archive (including LTM chain integrity) and hot-swaps its
state — no restart required.

---

## 6. Deploy to Kubernetes

```bash
docker build -t darm-ann:latest .
helm install darm deploy/helm/darm-ann \
  --namespace darm-ann --create-namespace \
  --set tokens.api="ops-secret:operator,read-secret:read" \
  --set tokens.cluster="cluster-secret"
```

A StatefulSet gives each pod stable identity + a PVC for its LTM snapshot;
restarts restore from the PVC automatically. See [`../deploy/README.md`](../deploy/README.md)
for plain manifests, autoscaling, and PodDisruptionBudget.

---

## Where to go next

- **Architecture & internals**: [`README.md`](README.md) (maps every module to
  the DARM-ANN v6.0 white paper).
- **Benchmark**: `node darm-ann/bench.js 200 4 10` (throughput + correctness).
- **Load test**: `node darm-ann/loadtest.js 500 25 --urls http://localhost:3001`.
- **Consensus internals**: `node darm-ann/cluster.js 4` (multi-process BFT over
  TCP), `node darm-ann/clusterRSM.js 4` (live node join + shared LTM).
- **Tests**: `node darm-ann/test.js` (87 unit + integration tests).
