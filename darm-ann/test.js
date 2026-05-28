'use strict';

/**
 * DARM-ANN v6.0 — self-contained test suite (no framework, no deps).
 * Run: `node darm-ann/test.js`
 */

const assert = require('assert');
const DarmAnn = require('./index');
const { LSHIndex } = require('./util/lsh');
const { embed, cosineSimilarity } = require('./util/embedding');
const { decayScore } = require('./pipeline/decay');
const { DEFAULT_CONFIG } = require('./config');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

// Fast config for tests: no minimum age gate so consolidation can run inline.
function fastNode(extra = {}) {
  return new DarmAnn({
    nodeId: 'test-node',
    config: { cdcp: { tMinAgeMs: 0 }, ...extra },
  });
}

console.log('\nDARM-ANN v6.0 test suite\n');

console.log('[util] embeddings & LSH');
test('embed is deterministic and normalised', () => {
  const a = embed('forward secrecy', 64);
  const b = embed('forward secrecy', 64);
  assert.deepStrictEqual(Array.from(a), Array.from(b));
  let norm = 0;
  for (const x of a) norm += x * x;
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-9, 'should be unit length');
});
test('cosine similarity: identical=1, unrelated<identical', () => {
  const a = embed('transport layer security handshake', 64);
  const b = embed('transport layer security handshake', 64);
  const c = embed('banana smoothie recipe', 64);
  assert.ok(Math.abs(cosineSimilarity(a, b) - 1) < 1e-9);
  assert.ok(cosineSimilarity(a, c) < cosineSimilarity(a, b));
});
test('LSH retrieves a near-identical vector as candidate', () => {
  const idx = new LSHIndex({ dim: 64, tables: 3, bits: 16 });
  const e = embed('byzantine fault tolerance quorum', 64);
  idx.insert('x', e, { v: 1 });
  assert.ok(idx.candidates(e).has('x'));
});

console.log('\n[tiers] observe → STM');
test('observe encodes a salient claim into STM', () => {
  const node = fastNode();
  const r = node.observe({ claim: 'TLS 1.3 mandates forward secrecy', reward: 1, epistemic: { conf_cal: 0.91, u_ep: 0.08 } });
  assert.strictEqual(r.encoded, 1);
  assert.strictEqual(r.persisted[0].status, 'PROMOTED_TO_STM');
  assert.strictEqual(node.state().tiers.STM, 1);
});
test('low-confidence claim is held in EB, not persisted to STM', () => {
  const node = fastNode();
  const r = node.observe({ claim: 'maybe true maybe not', reward: 0.2, epistemic: { conf_cal: 0.3, u_ep: 0.5 } });
  // fails ESE gate at encode → not even encoded
  assert.strictEqual(r.encoded, 0);
  assert.strictEqual(node.state().tiers.STM, 0);
});
test('duplicate observation merges instead of duplicating', () => {
  const node = fastNode();
  node.observe({ claim: 'merkle proofs verify inclusion', reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
  const r2 = node.observe({ claim: 'merkle proofs verify inclusion', reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
  assert.strictEqual(r2.persisted[0].status, 'MERGED');
  assert.strictEqual(node.state().tiers.STM, 1);
});

console.log('\n[CDCP] consensus-driven consolidation');
test('untaught claim cannot reach quorum (collective validation)', () => {
  const node = fastNode();
  node.observe({ claim: 'unverifiable assertion about xyz', reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
  const entry = node.stm.all()[0];
  const res = node.consolidate(entry.claim_id);
  assert.notStrictEqual(res.status, 'PROMOTED');
  assert.strictEqual(node.state().tiers.LTM, 0);
});
test('taught claim reaches τ_c quorum and commits to LTM', () => {
  const node = fastNode();
  const claim = 'TLS 1.3 mandates forward secrecy via ephemeral key exchange';
  node.teach(claim); // all voters now ground this fact
  node.observe({ claim, reward: 1, epistemic: { conf_cal: 0.91, u_ep: 0.08 } });
  const entry = node.stm.all()[0];
  const res = node.consolidate(entry.claim_id);
  assert.strictEqual(res.status, 'PROMOTED', `expected PROMOTED, got ${res.status}`);
  assert.strictEqual(node.state().tiers.LTM, 1);
  assert.ok(res.consolidatedConf > 0.6);
});
test('refuted claim is rejected by quorum', () => {
  const node = fastNode();
  const claim = 'the chain accepts double-spends freely';
  node.refute(claim);
  node.observe({ claim, reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
  const entry = node.stm.all()[0];
  // It may be contradicted at persist; if persisted, consensus must not promote.
  if (entry) {
    const res = node.consolidate(entry.claim_id);
    assert.notStrictEqual(res.status, 'PROMOTED');
  }
  assert.strictEqual(node.state().tiers.LTM, 0);
});
test('VoteWeight scales with G_K maturity (§5.7)', () => {
  const node = fastNode();
  const v = node.self;
  const sparse = v.voteWeight(1000);
  for (let i = 0; i < 1000; i++) node.gte.addGrounded(`fact number ${i}`);
  const mature = v.voteWeight(1000);
  assert.ok(mature > sparse);
  assert.ok(mature <= 1);
});

console.log('\n[RRC] rapid retrieval cache');
test('consolidated memory is retrievable from RRC in one hop', () => {
  const node = fastNode();
  const claim = 'sharp wave ripples drive memory replay during NREM sleep';
  node.teach(claim);
  node.observe({ claim, reward: 1, epistemic: { conf_cal: 0.92, u_ep: 0.05 } });
  node.consolidate(node.stm.all()[0].claim_id);
  const q = node.query(claim);
  assert.strictEqual(q.tier, 'RRC', `expected RRC hit, got ${q.tier}`);
  assert.ok(q.hit);
});
test('query for novel topic is a MISS', () => {
  const node = fastNode();
  const q = node.query('completely unrelated novel topic never seen');
  assert.strictEqual(q.tier, 'MISS');
  assert.strictEqual(q.hit, false);
});
test('RRC invalidation removes a superseded entry', () => {
  const node = fastNode();
  const claim = 'incumbent fact to be superseded later';
  node.teach(claim);
  node.observe({ claim, reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
  node.consolidate(node.stm.all()[0].claim_id);
  const block = node.ltm.blocks[0];
  assert.ok(node.rrc.bySource.has(block.hash));
  node.rrc.invalidate(block.hash);
  assert.ok(!node.rrc.bySource.has(block.hash));
});

console.log('\n[RCE] replay & consolidation');
test('replay cycle nominates taught STM survivors to LTM', () => {
  const node = fastNode();
  const claim = 'GRPO optimises group-relative policy advantages';
  node.teach(claim);
  node.observe({ claim, reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
  const report = node.replay();
  assert.ok(report.replayed >= 1);
  assert.ok(report.promoted >= 1, `expected ≥1 promotion, got ${report.promoted}`);
  assert.strictEqual(node.state().tiers.LTM, 1);
});
test('replay decays an unsupported STM entry', () => {
  const node = fastNode();
  node.observe({ claim: 'ungrounded floating claim', reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
  const before = node.stm.all()[0].salience;
  node.replay();
  const entry = node.stm.get(node.stm.all()[0] && node.stm.all()[0].claim_id);
  // either decayed in place or expired out
  if (entry) assert.ok(entry.salience < before);
});

console.log('\n[lifecycle] decay & triage');
test('decay score follows Ebbinghaus (older ⇒ smaller)', () => {
  const entry = { salience: 0.8, created_at: Date.now(), replays: 0 };
  const fresh = decayScore(entry, Date.now(), DEFAULT_CONFIG);
  const old = decayScore(entry, Date.now() + 24 * 3600 * 1000, DEFAULT_CONFIG);
  assert.ok(old < fresh);
});
test('reinforcement (replays) raises decay score', () => {
  const base = { salience: 0.8, created_at: Date.now(), replays: 0 };
  const rehearsed = { salience: 0.8, created_at: Date.now(), replays: 10 };
  const t = Date.now() + 3600 * 1000;
  assert.ok(decayScore(rehearsed, t, DEFAULT_CONFIG) > decayScore(base, t, DEFAULT_CONFIG));
});
test('triage expires fully-decayed entries', () => {
  const node = fastNode();
  node.observe({ claim: 'transient low-value note', reward: 0.6, epistemic: { conf_cal: 0.65, u_ep: 0.2 } });
  // advance time well past the half-life
  const report = node.triage({ now: Date.now() + 1000 * 3600 * 1000 });
  assert.ok(report.expired >= 1 || node.state().tiers.STM === 0);
});

console.log('\n[self-contained] PoW substrate, morphism, autorun');
test('self-contained PoW adapter mines valid leading-zero hashes', () => {
  const { powAdapter } = require('./network/chainAdapter');
  const node = new DarmAnn({ nodeId: 'pow', config: { cdcp: { tMinAgeMs: 0 } }, adapter: powAdapter({ difficulty: 2 }) });
  const claim = 'self-contained pow consolidation works';
  node.teach(claim);
  node.observe({ claim, reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
  const res = node.consolidate(node.stm.all()[0].claim_id);
  assert.strictEqual(res.status, 'PROMOTED');
  assert.ok(res.block.hash.startsWith('00'), 'PoW hash should have 2 leading zeros');
  assert.ok(node.ltm.mode.startsWith('poly:pow'));
});
test('poly-chain morphism swaps substrate at runtime, preserving blocks', () => {
  const { standaloneAdapter, powAdapter } = require('./network/chainAdapter');
  const node = new DarmAnn({ nodeId: 'morph', config: { cdcp: { tMinAgeMs: 0 } }, adapter: standaloneAdapter() });
  const c1 = 'distributed ledgers use cryptographic hash chains';
  node.teach(c1);
  node.observe({ claim: c1, reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
  node.consolidate(node.stm.all()[0].claim_id);
  assert.strictEqual(node.ltm.size, 1);
  node.morph(powAdapter({ difficulty: 2 }));
  const c2 = 'unrelated topic about photosynthesis in plants';
  node.teach(c2);
  node.observe({ claim: c2, reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
  node.consolidate(node.stm.all().find((e) => !e.promoted).claim_id);
  assert.strictEqual(node.ltm.size, 2, 'old block preserved across morph');
  assert.ok(node.ltm.blocks[1].hash.startsWith('00'));
});
test('selfDeploy returns an autonomous node and stop() clears timers', () => {
  const node = DarmAnn.selfDeploy({ difficulty: 1, config: { cdcp: { tMinAgeMs: 0 } } });
  assert.ok(node._timers && node._timers.length === 2);
  node.stop();
  assert.strictEqual(node._timers, null);
});

console.log('\n[growth] associative network');
test('consolidating related memories grows associative edges', () => {
  const node = fastNode();
  const claims = [
    'byzantine fault tolerance requires two thirds honest validators for safety',
    'byzantine fault tolerance quorum intersection guarantees consensus safety',
  ];
  for (const c of claims) {
    node.teach(c);
    node.observe({ claim: c, reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
  }
  for (const e of node.stm.all()) node.consolidate(e.claim_id);
  const g = node.ltm.graphStats();
  assert.strictEqual(g.nodes, 2);
  assert.ok(g.edges >= 1, 'related memories should wire together');
});

console.log('\n[swarm] cross-chain pollination');
test('pollination disseminates a memory to a peer chain', () => {
  const { Swarm } = DarmAnn;
  const { standaloneAdapter, powAdapter } = DarmAnn.adapters;
  const a = new DarmAnn({ nodeId: 'A', config: { cdcp: { tMinAgeMs: 0 } }, adapter: standaloneAdapter() });
  const b = new DarmAnn({ nodeId: 'B', config: { cdcp: { tMinAgeMs: 0 } }, adapter: powAdapter({ difficulty: 1 }) });
  const claim = 'cross chain pollination spreads validated knowledge';
  a.teach(claim);
  a.observe({ claim, reward: 1, epistemic: { conf_cal: 0.95, u_ep: 0.05 } });
  a.consolidate(a.stm.all()[0].claim_id);
  assert.strictEqual(a.ltm.size, 1);
  assert.strictEqual(b.ltm.size, 0);

  const swarm = new Swarm({ nodes: [a, b] });
  const report = swarm.pollinate({ topK: 5 });
  assert.ok(report.accepted >= 1);
  assert.ok(b.ltm.size >= 1, 'peer B should have re-consolidated the pollinated memory');
  const growth = swarm.growth();
  assert.strictEqual(growth.nodes, 2);
  assert.ok(Object.keys(growth.substrates).length >= 1);
});
test('poly-chain swarm reports heterogeneous substrates', () => {
  const { powAdapter, standaloneAdapter } = DarmAnn.adapters;
  const swarm = DarmAnn.Swarm.deploy({
    count: 2,
    config: { cdcp: { tMinAgeMs: 0 } },
    substrateFactory: (i) => (i === 0 ? standaloneAdapter() : powAdapter({ difficulty: 1 })),
  });
  const g = swarm.growth();
  assert.strictEqual(g.nodes, 2);
  assert.ok(g.substrates['poly:standalone'] === 1, JSON.stringify(g.substrates));
  assert.ok(g.substrates['poly:pow-d1'] === 1, JSON.stringify(g.substrates));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
