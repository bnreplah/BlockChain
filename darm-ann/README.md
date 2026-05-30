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
seed (deterministic Ed25519 keys) and reaches consensus over sockets.

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

## HTTP API (via `app.js`)

`POST /darm/observe` · `GET /darm/query?q=` · `POST /darm/teach` ·
`POST /darm/refute` · `POST /darm/replay` · `POST /darm/triage` ·
`GET /darm/state`.

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
