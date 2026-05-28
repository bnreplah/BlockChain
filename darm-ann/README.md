# DARM-ANN v6.0 — Distributed Agentic Recursive Memory Network

A self-contained, dependency-free Node.js implementation of the **DARM-ANN
v6.0** working white paper (*Hierarchical Memory Consolidation for Distributed
AI*, Cybopsec Research, April 2026), built **on top of this repository's
proof-of-work blockchain**.

The central idea of the paper maps directly onto this project: **the blockchain
is the Long-Term Memory (LTM) tier.** DARM-ANN wraps the chain in a five-tier
memory hierarchy and the consensus/replay machinery that decides what is worth
committing to it.

> The brain analogy (paper §1): STM/Episodic Buffer ↔ hippocampus (fast, local,
> temporary); the LTM blockchain ↔ neocortex (slow to write, distributed,
> permanent); the Replay Engine ↔ NREM-sleep replay; the Rapid Retrieval Cache
> ↔ the cortical engram.

---

## Why this exists

The chain on its own is a flat, binary memory: things are either ephemeral
(in a request) or permanent (on-chain). The paper identifies two problems with
that (§1):

1. **The Commitment Problem** — committing an uncertain thought permanently
   pollutes canonical memory; requiring full consensus for *every* claim is too
   slow to learn from.
2. **The Retrieval Cost Problem** — re-deriving an already-validated reasoning
   chain is wasteful when it just needs to be *recalled*.

DARM-ANN solves both with a graded pipeline (fast/uncertain → slow/certain) and
a pre-computed cache.

---

## The five tiers (paper §3)

| Tier | Module | Role |
|------|--------|------|
| 0 — Working Memory (WM) | `memory/workingMemory.js` | per-inference scratch pad |
| 1 — Episodic Buffer (EB) | `memory/episodicBuffer.js` | per-agent ring buffer of reasoning traces |
| 2 — Short-Term Memory (STM) | `memory/shortTermMemory.js` | node-local validated-claim staging (TTL, dedup, decay) |
| 3 — Long-Term Memory (LTM) | `memory/longTermMemory.js` | **the blockchain** — consensus-committed, permanent |
| 4 — Rapid Retrieval Cache (RRC) | `memory/rapidRetrievalCache.js` | LSH cache of hot LTM entries, O(1) recall |

Information flows **WM → EB → STM → LTM → RRC**, gaining evidence, consensus,
and salience as it moves toward permanence.

## The machinery

| Component | Module | Paper |
|-----------|--------|-------|
| Salience scoring | `pipeline/salience.js` | §4.2 |
| Memory formation (Algorithms 10–11) | `pipeline/memoryFormation.js` | §4 |
| Decay scoring (Ebbinghaus + spacing) | `pipeline/decay.js` | §8.1, P48 |
| Memory triage (Algorithm 17) | `pipeline/triage.js` | §8.2 |
| **CDCP** consensus consolidation (Algorithms 12–14) | `consensus/cdcp.js` | §5 |
| **RCE** replay engine (Algorithm 15) | `engine/rce.js` | §6 |
| GTE (graph traversal, v5.0) | `engine/gte.js` | §3 (v5.0) |
| ESE (epistemic skepticism, v5.0) | `engine/ese.js` | §5 (v5.0) |
| BVAS (validity suite, v5.0) | `engine/bvas.js` | §4 (v5.0) |
| Embeddings / LSH / hashing | `util/` | §3.2, §7.1, P43 |

The heart is **CDCP**: an STM entry is promoted to the blockchain only when a
**τ_c quorum (default 2/3)** of independent voter nodes each validate it with
their *own* GTE + ESE — no shared intermediate state. This is what bounds
hallucination pass-through (Proof P39) and guarantees every LTM entry is
*collective* network truth, not a single agent's assertion.

---

## Quick start

```js
const DarmAnn = require('./darm-ann');

const node = new DarmAnn({ nodeId: 'node-0' });   // 7-voter cluster, standalone LTM

// 1. Teach the cluster a fact (grounds it in every voter's knowledge graph)
node.teach('TLS 1.3 mandates forward secrecy via ephemeral key exchange');

// 2. Observe a completed inference (WM → EB → STM)
node.observe({
  claim: 'TLS 1.3 mandates forward secrecy via ephemeral key exchange',
  reward: 1,
  epistemic: { conf_cal: 0.91, u_ep: 0.08 },
});

// 3. Consolidate via CDCP consensus → commits to the blockchain (LTM)
node.replay();                 // or node.consolidate(claimId) to force one

// 4. Retrieve — RRC → STM → LTM → MISS, short-circuits at first hit
node.query('TLS 1.3 mandates forward secrecy via ephemeral key exchange');
//   → { tier: 'RRC', hit: true, result: '...', confidence: 1, ... }
```

`node observe`-only claims that nobody can validate **never reach LTM** — that
is the design (collective validation). Use `node.refute(text)` to ground a
contradiction so the quorum rejects a claim.

### Facade API (`index.js`)

| Method | Purpose |
|--------|---------|
| `observe({claim, reward, epistemic, agentId})` | ingest an inference (WM→EB→STM) |
| `query(text)` | hierarchy retrieval (RRC→STM→LTM→MISS) |
| `teach(text)` / `refute(text)` | seed cluster knowledge graph (G_K) |
| `replay(opts)` | one RCE cycle (nominates STM survivors to CDCP) |
| `triage(opts)` | STM lifecycle management (Algorithm 17) |
| `consolidate(claimId)` | force a CDCP run for one entry |
| `morph(adapter)` | hot-swap the LTM chain substrate |
| `autorun({replayMs,triageMs})` / `stop()` | background self-operation |
| `state()` | Σ(t) snapshot of tier occupancies + associative graph |
| `DarmAnn.selfDeploy(opts)` | one-call autonomous self-contained node |

---

## Self-contained & self-deploying

Everything runs in plain Node.js with **no Redis, no external LLM, no external
consensus service**. The paper's infrastructure is replaced by faithful,
documented in-process stand-ins (each marked `SWAP POINT` in source):

- **Redis STM** → in-process `Map` + LSH index with explicit TTL.
- **TinyLM embedder** → deterministic hashing-trick embedding (`util/embedding.js`).
- **Tendermint BFT** → in-process independent voter quorum (`consensus/cdcp.js`).
- **LLM inference / GTE / ESE / BVAS** → lightweight knowledge-graph stand-ins.

Spin up a fully autonomous node that builds its own chain from scratch and
keeps consolidating in the background:

```js
const node = DarmAnn.selfDeploy({ difficulty: 3 });   // self-contained PoW substrate + autorun
```

---

## Poly-chain morphism (substrate-agnostic)

The LTM tier only needs a substrate that can `commit(payload, prevHash) → {hash}`.
That single contract makes DARM-ANN **multipurpose and chain-agnostic**, and
lets a node **morph** between substrates at runtime. Built-in adapters
(`network/chainAdapter.js`):

```js
const { standaloneAdapter, powAdapter, repoChainAdapter } = require('./darm-ann/network/chainAdapter');

new DarmAnn({ adapter: standaloneAdapter() });          // pure hash chain
new DarmAnn({ adapter: powAdapter({ difficulty: 4 }) }); // self-contained PoW
new DarmAnn({ adapter: repoChainAdapter(Bcoin) });       // bridge the repo's PoW chain

node.morph(powAdapter({ difficulty: 5 }));               // swap at runtime; blocks preserved
```

When bridged to `structures/Blockchain.js`, every consolidated memory is **mined
as a real block** — the repository's chain literally becomes the long-term
memory tier (this is how `app.js` runs it).

---

## Cross-chain dissemination & pollination (`network/swarm.js`)

A **Swarm** is a set of nodes that may sit on *different* substrates. It
implements **pollination**: high-value consolidated memories migrate to peers,
where each peer **independently re-validates** them through its own CDCP quorum
before committing to its own chain. Knowledge spreads; trust is never copied.

```js
const { Swarm } = DarmAnn;
const swarm = new Swarm({ nodes: [a, b, c] });
swarm.pollinate({ strategy: 'top-confidence', topK: 5 });  // cross-pollinate
swarm.growth();   // { nodes, totalLTM, associativeEdges, substrates: {...} }
```

### Growing neural network

As related memories consolidate, the LTM grows a **Hebbian associative graph**
(`longTermMemory.js` → `_grow`, `neighbors`, `graphStats`): memories that are
semantically close "wire together," so the long-term store behaves as a growing
weighted network rather than a flat ledger.

---

## HTTP API (via `app.js`)

When the server runs, DARM-ANN is bridged to the node's `Bcoin` chain and
exposed at:

| Method & path | Action |
|---------------|--------|
| `POST /darm/observe` | ingest `{claim, reward, epistemic}` |
| `GET  /darm/query?q=...` | hierarchy retrieval |
| `POST /darm/teach` / `POST /darm/refute` | seed G_K with `{claim}` |
| `POST /darm/replay` | run an RCE cycle |
| `POST /darm/triage` | run STM triage |
| `GET  /darm/state` | Σ(t) snapshot |

---

## Run it

```bash
node darm-ann/test.js     # 24-test suite (npm run darm:test)
node darm-ann/demo.js     # narrated end-to-end demo (npm run darm:demo)
```

## Configuration

All thresholds from the paper live in `config.js` (τ_c, salience weights, TTLs,
decay rates, RCE budgets, …) and are overridable per node:

```js
new DarmAnn({ config: { cdcp: { tauC: 0.80, tMinAgeMs: 0 }, stm: { ttlMs: 3600000 } } });
```

## Faithfulness & limitations

This is a **reference implementation** of the architecture, not the production
distributed system. The consensus, embedding, and reasoning engines are
in-process stand-ins (clearly marked) that preserve the *contracts and control
flow* of the paper — quorum math (P40/P46), VoteWeight scaling (§5.7), decay
correspondence (P48), RRC recall geometry (P43) — so the behavior matches spec
and each stand-in can be swapped for the real component without touching the
rest of the system.
