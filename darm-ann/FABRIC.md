# DARM-ANN v7.2 — The Distributed AI Lens (Fabric)

v7.2 reframes each DARM-ANN deployment as an **Autonomous Cognitive System
(ACS)** — analogous to a BGP Autonomous System — and the nodes within it as
**routers between the subnets they participate in**. The result is a recursive
network-of-networks: an *inter-net of intelligence*. This is implemented in
`darm-ann/fabric/` and exposed at `/fabric/*`.

Normative core is **substrate- and vendor-agnostic** (v7.2 §9.2): the fabric
modules name no network, cloud, chain, or product — a CI grep test enforces it.

## Modules

| Module | Whitepaper | Purpose |
|---|---|---|
| `fabric/acs.js` | Part II §2.2 | ACS identity (Ed25519 = ACSN) + signed capability advertisements + peering policy |
| `fabric/rib.js` | §2.3 | Routing Information Base — verified advertisements + peering graph (no directory authority) |
| `fabric/dirp.js` | §2.4 | DIRP-1 path selection: **trust-pruned Dijkstra** over the RIB graph; ACS-path loop prevention |
| `fabric/privacy.js` | Part III | Confidential-execution ladder (`redact`/`attested`/`blind`/`sealed`) + onion routing (≥3 relays) |
| `fabric/ccil.js` | Part IV | CCIL role ladder (LEAF→RELAY→ANCHOR→VALIDATOR) + PoUI (spot-check, incentive math) |
| `fabric/sal.js` | §4.4, §4.6 | Substrate Abstraction Layer provider classes (CSP/SRP/CEP/MRP/TAP) + Rail Profile Registry |
| `fabric/index.js` | Parts II–IV | `Fabric` facade — the full `ADVERTISE→ROUTE→execute→ATTEST→SETTLE` lifecycle |

## The core payoff: routing = memory traversal

"Memory traversal and network routing are the same algorithm over different
graphs" (§2.4). DIRP-1 reuses the same shortest-path primitive the GTE uses over
the knowledge graph, now over the RIB capability graph:

```
cost(path) = Σ (latency_i + price_i·β)   s.t.   Π trust_i ≥ T_floor
```

Proof obligations implemented as **testable code + assertions**:
- **P63** — trust-pruned Dijkstra stays O(E + V log V) (pruning before relaxation).
- **P64** — ACS-path loop prevention → loop-free forwarding (BGP path-vector analogue).
- **P65** — onion mode requires ≥3 non-colluding relays.
- **P67** — PoUI soundness: P(undetected fraud over k jobs) ≤ (1−q)^k.
- **P68** — incentive compatibility: S_min = (1−q)/q · cheat_gain.
- **P79** — substrate independence: any conforming provider substitutes within a class.
- **P81** — neutrality: `cost(path)` uses only advertised/measured/attested properties.
- **P82** — settlement survives while ≥1 conforming rail is registered.

## HTTP API (`/fabric/*`)

`GET /fabric/state` · `POST /fabric/advertise` · `POST /fabric/gossip` ·
`POST /fabric/peer` · `POST /fabric/route` · `POST /fabric/job` ·
`GET|POST /fabric/rails` · `POST /fabric/adapters`.

Metrics: `darm_fabric_advertisements`, `darm_fabric_rib_acs`,
`darm_fabric_rib_peering_edges`, `darm_fabric_sal_adapters`,
`darm_fabric_sal_rails`, `darm_fabric_settlement_live`,
`darm_fabric_attestations`, `darm_fabric_ccil_role{role}`.

## Phase-1 demo (the next stage of testing)

```bash
node darm-ann/fabricDemo.js      # npm run darm:fabric
```

Demonstrates the roadmap §9.1 exit gate: a job originating in ACS-A executes in
ACS-B with a verifiable ATTEST receipt and settlement, routed via DIRP-1 as
`sync_class=async, conf_class=redact`, plus onion routing (P65), a cloud joining
as an Adapter ACS (P79 neutrality), and the CCIL incentive math.

## One stand-in (clearly marked)

The onion layer uses real X25519 ECDH per hop (Node `crypto`). The paper
specifies X25519 wrapped in ML-KEM-768 (hybrid, PQ). Node has no ML-KEM
primitive, so the KEM slot is the single cryptographic stand-in in the fabric
layer — the layering, per-hop key separation, padding, unwrap semantics, and
redaction are all real. Marked in `fabric/privacy.js` for a hybrid upgrade.
