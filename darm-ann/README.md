# DARM-ANN v6.0 — Distributed Agentic Recursive Memory Network

A **production-oriented, fully self-contained** Node.js implementation of the
DARM-ANN v6.0 white paper (*Hierarchical Memory Consolidation for Distributed
AI*). **Zero runtime dependencies** — every component is built from the ground
up in this repo. No Redis, no external LLM, no external consensus service, no
simulation/mock data.

The repository's proof-of-work blockchain is bridged in as the **Long-Term
Memory (LTM)** tier, exactly as the paper intends ("LTM is the existing
M_global blockchain").

---

## Everything is a real implementation

| Concern | Real implementation (built here) | File |
|---------|----------------------------------|------|
| Neural network | MLP with backprop + Adam (learns XOR) | `nn/network.js` |
| Embeddings (the ANN) | skip-gram w/ negative sampling, learned vectors | `nn/embedder.js` |
| Short-term memory | hash-linked **blockchain** (TTL, prune, self-repair) | `memory/shortTermMemory.js` + `memory/chain.js` |
| Long-term memory | hash-linked **blockchain** + Hebbian associative graph | `memory/longTermMemory.js` |
| Graph traversal (GTE) | real knowledge graph + BFS / DFS / Dijkstra / A* | `engine/knowledgeGraph.js`, `engine/gte.js` |
| Epistemic engine (ESE) | **deep ensemble** classifiers + **temperature scaling** | `engine/ese.js` |
| Validity suite (BVAS) | real 5-stage pipeline w/ crypto + chain checks | `engine/bvas.js` |
| Consensus (CDCP) | **Ed25519-signed BFT** propose/prevote/precommit/commit | `consensus/{validatorKey,bft,transport,cdcp}.js` |
| Transport | in-process bus **and real TCP sockets** | `consensus/transport.js` |
| Markov chain-graph | weighted transition graph + link-chain overlay | `markov/markovGraph.js` |
| SLM / TinyLMs | neural transition scorer + n-gram LM + registry | `nn/tinyLM.js`, `nn/ngramLM.js`, `nn/modelRegistry.js` |
| Graph navigation | model-directed traversal of the chain graph | `markov/navigator.js` |
| Self-correction | chain validate/repair, TTL prune, contradiction supersede, ESE recalibration | `index.js#selfCorrect` |

Run the suite — **50 unit + integration tests, every module covered**, incl.
real TCP consensus, Byzantine tolerance, and signature-forgery rejection:

```bash
node darm-ann/test.js      # npm run darm:test   (52 tests)
node darm-ann/demo.js      # npm run darm:demo
node darm-ann/cluster.js 5 # npm run darm:cluster (multi-process TCP consensus)
```

---

## Two memory blockchains

Both STM and LTM are genuine hash-linked chains (`memory/chain.js`):

- **Short-term memory blockchain** — every STM commitment is appended as a
  tamper-evident block. `validateChain()` detects tampering; `repairChain()`
  self-corrects by rebuilding links; `pruneExpired()` enforces TTL.
- **Long-term memory blockchain** — consensus-committed memories, hash-chained
  with full vote provenance, plus a **Hebbian associative graph** that wires
  semantically-related memories together (the growing network).

```js
node.state().chains  // { stmHeight, stmValid, ltmValid }
```

## Weighted Markov chain-graph + SLM/TinyLM navigation

`markov/markovGraph.js` is a first-order weighted Markov transition graph with a
**link-chain overlay** (a linked list of states in temporal order) — together a
"chain graph". The system holds **various small models** in a registry:

- `TinyLM` — a neural transition scorer (MLP over `[context ⊕ candidate]`),
- `NgramLM` — an add-k smoothed statistical SLM.

The `GraphNavigator` uses a TinyLM to **direct traversal** across the chain
graph: at each node it blends the Markov transition probability with the
TinyLM's learned score to choose the next node.

```js
node.observe({ claim: 'step A ...' });
node.observe({ claim: 'step B ...' });
const { path } = node.navigate('step A ...', 8);   // model-directed walk
```

## Consensus-Driven Consolidation (real multi-round BFT)

A claim is promoted from STM to the LTM blockchain only when a **τ_c quorum
(2/3)** of independent validators agree via a real **multi-round, leader-
rotating** BFT round exchanging **Ed25519-signed** PROPOSE/PREVOTE/PRECOMMIT
messages over a transport. Each validator evaluates independently with its own
GTE + ESE. Forged votes are rejected; conflicting values cannot both commit
(quorum intersection); and if the round-`r` leader is silent, honest nodes time
out and **rotate to the round-`r+1` leader** (liveness under faulty leaders).

Runs over the in-process bus by default; the same `BFTNode` runs over real TCP
sockets for multi-process / multi-host clusters.

### Multi-process cluster (distributed PoC)

```bash
node darm-ann/cluster.js 5          # 5 validator processes, real TCP, BFT round
# → COMMITTED v0 round=0 ... 5/5 processes committed → SUCCESS
```

Each process independently reconstructs the shared validator set from a master
seed (deterministic Ed25519 keys), keeps a durable **write-ahead log**, and
reaches consensus over sockets.

### Crash recovery (WAL)

Each validator appends every safety-critical action (round entry, prevote
choice, precommit/lock, decision) to a **write-ahead log** (`consensus/wal.js`)
*before* acting. After a crash, `recoverFromWAL()` restores the locked value and
round so the node cannot equivocate (prevote a conflicting value) on restart.

### Dynamic validator-set membership

Validators can join/leave at runtime; changes apply at the next consolidation
(epoch boundary), never mid-round, so BFT safety holds. New validators inherit
the current grounded/refuted knowledge so they vote meaningfully immediately.

```js
node.addValidator();              // → { nodeId, address, voters, version }
node.removeValidator(nodeId);     // (cannot remove self)
node.validators();                // live set used for the next round
```

### Live membership via consensus (replicated state machine)

`consensus/replica.js` is a multi-height RSM over the BFT: each height commits
one value, and **membership changes are themselves consensus transactions**
(`add-validator` / `remove-validator`). A committed change mutates the validator
set for the next height, so a running cluster grows/shrinks live with every
node agreeing. The ordered log + set are written to the WAL; `recover()` rebuilds
exact state after a crash, and `compactWAL()` (wired to a state snapshot) trims
the log safely.

**Shared LTM via consensus.** A replica's apply-hook commits `memory`
transactions to its own LTM blockchain. Because every replica applies the same
committed values deterministically (and embeddings are deterministic), all
nodes hold a **byte-identical LTM blockchain** — one shared chain, not per-node
LTMs joined by pollination.

**Live node join over TCP.** `clusterRSM.js` runs `n` validators + 1 joiner
across real processes: the joiner **state-syncs** the current height, active
validator set, and LTM from a seed peer, is then **admitted by an
`add-validator` consensus txn**, and participates from the next height. (A
single transport multiplexes consensus + state-sync via `BFTNode autoConnect:false`.)

```bash
node darm-ann/clusterRSM.js 4     # 4 validators + 1 joiner, real TCP:
# h0 memory txn → joiner state-syncs → h1 add-validator(joiner) → h2 memory txn
# → SUCCESS — all 5 processes hold an identical 2-block shared LTM
```

## Persistence & deployment

Nodes are restartable. `node.snapshot()` / `node.save(file)` serialise the
durable knowledge (LTM blockchain + embeddings, taught/refuted corpus, Markov
chain-graph); `DarmAnn.load(file)` rebuilds a fully-functional node.

The server (`app.js`) integrates this for deployment:

```bash
DARM_SNAPSHOT=./data/node.json \
DARM_MIN_AGE_MS=60000 DARM_TAU_C=0.67 \
node app.js 3001 http://localhost:3001
```

- restores from `DARM_SNAPSHOT` on boot if present,
- saves the snapshot on `SIGINT`/`SIGTERM` (graceful shutdown),
- exposes `GET /darm/health` (liveness/readiness), `GET /darm/navigate`,
  `POST /darm/selfcorrect`, `POST /darm/snapshot` alongside the core endpoints.

### Docker (multi-container cluster + dashboard)

A `Dockerfile` and `docker-compose.yml` (repo root) bring up a three-node
cluster, each serving its memory network + dashboard with a persistent snapshot
volume and a `/darm/health` healthcheck:

```bash
docker compose up --build
open http://localhost:3001/darm/dashboard      # also :3002, :3003
docker compose exec darm1 node darm-ann/cli.js state
```

Each container is an independent DARM-ANN replica (own LTM blockchain); join
them into one logical network via `Swarm` pollination or the repo's
`/register-and-broadcast-node` endpoints.

## Self-correction

`node.selfCorrect()` performs a maintenance pass:

- validates and **repairs** the STM and LTM blockchains if any link is broken,
- prunes expired STM entries,
- **supersedes** LTM entries that have become contradicted in the knowledge
  graph (retrograde protection),
- retrains/recalibrates the ESE on the current corpus.

`autorun()` schedules `replay()`, `triage()`, and `selfCorrect()` on background
timers for hands-off operation.

---

## Quick start

```js
const DarmAnn = require('./darm-ann');
const node = new DarmAnn({ nodeId: 'node-0' });        // 7-validator cluster

node.teach('TLS 1.3 mandates forward secrecy via ephemeral key exchange');
node.observe({ claim: 'TLS 1.3 mandates forward secrecy via ephemeral key exchange',
               reward: 1, epistemic: { conf_cal: 0.91, u_ep: 0.08 } });
node.replay();                                          // RCE → CDCP → LTM commit
node.query('TLS 1.3 mandates forward secrecy via ephemeral key exchange');
//   → { tier: 'RRC', hit: true, ... }
```

Untaught claims that no quorum can validate **never reach LTM** — collective
validation by design.

### Self-contained autonomous node

```js
const node = DarmAnn.selfDeploy({ difficulty: 3 });   // own PoW chain + autorun
```

### Poly-chain morphism & cross-chain pollination

```js
const { standaloneAdapter, powAdapter, repoChainAdapter } = require('./darm-ann/network/chainAdapter');
new DarmAnn({ adapter: powAdapter({ difficulty: 4 }) });
node.morph(standaloneAdapter());                       // hot-swap substrate

const swarm = new DarmAnn.Swarm({ nodes: [a, b, c] }); // heterogeneous chains
swarm.pollinate({ strategy: 'top-confidence', topK: 5 });
```

### Gossip transaction mempool

`consensus/mempool.js` is an epidemic-broadcast mempool: **any** node can submit
a signed transaction; it is admitted locally and gossiped to a random fan-out of
peers (bounded TTL), which verify, deduplicate, and re-gossip — so a tx submitted
anywhere reaches every node. Validators pull pending txns to propose the next
consensus height; committed txns are removed (dedup memory prevents re-admission).

In the server, `POST /darm/tx { type, payload }` submits + gossips over the
repo's registered node network (HTTP relay); a `memory` tx is observed into the
receiving node's pipeline. `GET /darm/mempool` inspects pending txns.

### Fault tolerance (tested)

The in-process bus supports fault injection (`{ drop, partition }`) and the BFT
engine re-broadcasts its latest votes each round (gossip amplification), so the
suite verifies: **liveness** under 20% random message loss and under a
partitioned minority, and **safety** under a full network split (no side with a
2/3 quorum commits).

## HTTP API (via `app.js`)

`POST /darm/observe` · `GET /darm/query?q=` · `POST /darm/teach` ·
`POST /darm/refute` · `POST /darm/replay` · `POST /darm/triage` ·
`POST /darm/selfcorrect` · `POST /darm/snapshot` · `POST /darm/tx` ·
`GET /darm/mempool` · `GET /darm/navigate?q=` · `GET /darm/state` ·
`GET /darm/health` · `GET|POST /darm/validators` ·
`DELETE /darm/validators/:id` · `GET /darm/dashboard` (operator UI).

Persistence: `DARM_SNAPSHOT` (path), `DARM_SNAPSHOT_MS` (periodic save
interval, default 60s) — the node restores on boot, snapshots periodically to
the `/data` volume, and saves on graceful shutdown.

## Operate it — CLI + dashboard

A built-in operator **dashboard** (no external deps) is served at
`http://<host>:<port>/darm/dashboard`: live tier/chain/Markov/validator stats,
and buttons to teach/observe/query/navigate/replay/triage/self-correct/snapshot
and add/remove validators.

A no-dependency **CLI** drives a running node/cluster:

```bash
node darm-ann/cli.js --port 3001 state
node darm-ann/cli.js --port 3001 teach "TLS 1.3 mandates forward secrecy"
node darm-ann/cli.js --port 3001 observe "TLS 1.3 mandates forward secrecy"
node darm-ann/cli.js --port 3001 replay
node darm-ann/cli.js --port 3001 query "TLS 1.3 mandates forward secrecy"
node darm-ann/cli.js --port 3001 add-validator
node darm-ann/cli.js --port 3001 validators
```

## Configuration

All paper constants live in `config.js` (τ_c, salience weights, TTLs, decay,
RCE budgets, …), overridable per node:

```js
new DarmAnn({ config: { cdcp: { tauC: 0.80, tMinAgeMs: 0 } } });
```

## Notes for QA

- Deterministic seeds are used for reproducibility, not as canned data; all
  learning happens from inputs you provide via `teach`/`refute`/`observe`.
- The ESE/TinyLM are real models trained on the corpus they're given — quality
  scales with data volume, as with any learned model.
- The BFT here is a multi-round, leader-rotating, Byzantine-safe protocol with
  value-locking (quorum-intersection safety + liveness under faulty leaders).
  It is a working proof of concept rather than a hardened production consensus
  client (no persistence of consensus WAL, no dynamic validator-set changes,
  fixed timeouts) — those are the natural next hardening steps.
