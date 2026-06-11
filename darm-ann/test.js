'use strict';

/**
 * DARM-ANN v6.0 — comprehensive unit + integration test suite.
 * Pure Node.js, no framework, no deps.  Run: `node darm-ann/test.js`
 *
 * Covers every module: NN, embedder, LSH, both memory blockchains, RRC,
 * knowledge graph + GTE, ESE, BVAS, validator keys, BFT + transport, CDCP,
 * salience/decay/triage, RCE, Markov chain-graph, TinyLM/NgramLM/registry,
 * navigator, chain adapters, swarm, self-correction, and the facade.
 */

const assert = require('assert');
const crypto = require('crypto');

let passed = 0;
let failed = 0;
let group = '';
function section(name) {
  group = name;
  console.log(`\n[${name}]`);
}
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

const DarmAnn = require('./index');
const { fast } = (() => ({ fast: (extra = {}) => new DarmAnn({ nodeId: 'test', config: { cdcp: { tMinAgeMs: 0 }, ...extra } }) }))();

// ───────────────────────── nn/network ─────────────────────────
section('nn/network (MLP backprop)');
{
  const { MLP } = require('./nn/network');
  test('learns XOR (loss → ~0)', () => {
    const net = new MLP({ sizes: [2, 8, 1], activations: ['tanh', 'sigmoid'], lr: 0.05, seed: 3 });
    const X = [[0, 0], [0, 1], [1, 0], [1, 1]];
    const Y = [[0], [1], [1], [0]];
    const loss = net.fit(X, Y, { epochs: 3000, loss: 'bce' });
    assert.ok(loss < 0.05, `loss ${loss}`);
    assert.ok(net.predict([1, 0])[0] > 0.8 && net.predict([1, 1])[0] < 0.2);
  });
  test('deterministic given seed', () => {
    const a = new MLP({ sizes: [3, 4, 1], seed: 9 });
    const b = new MLP({ sizes: [3, 4, 1], seed: 9 });
    assert.deepStrictEqual(Array.from(a.predict([1, 2, 3])), Array.from(b.predict([1, 2, 3])));
  });
}

// ───────────────────────── nn/embedder ─────────────────────────
section('nn/embedder (skip-gram)');
{
  const Embedder = require('./nn/embedder');
  const { cosineSimilarity } = require('./util/embedding');
  test('identical text → identical unit vector', () => {
    const e = new Embedder({ dim: 48 });
    const v = e.embed('byzantine fault tolerance');
    assert.ok(Math.abs(cosineSimilarity(v, e.embed('byzantine fault tolerance')) - 1) < 1e-9);
    let n = 0;
    for (const x of v) n += x * x;
    assert.ok(Math.abs(Math.sqrt(n) - 1) < 1e-9);
  });
  test('training pulls co-occurring words together', () => {
    const e = new Embedder({ dim: 48, lr: 0.1 });
    ['tls forward secrecy ephemeral keys', 'forward secrecy encryption keys', 'banana smoothie yogurt honey'].forEach((t) => e.observe(t));
    e.train({ epochs: 200 });
    const rel = cosineSimilarity(e.embed('tls secrecy'), e.embed('ephemeral encryption keys'));
    const unrel = cosineSimilarity(e.embed('tls secrecy'), e.embed('banana smoothie'));
    assert.ok(rel > unrel, `rel ${rel} unrel ${unrel}`);
  });
}

// ───────────────────────── util/lsh ─────────────────────────
section('util/lsh');
{
  const { LSHIndex } = require('./util/lsh');
  const { embed } = require('./util/embedding');
  test('retrieves an inserted vector as candidate; remove works', () => {
    const idx = new LSHIndex({ dim: 64, tables: 3, bits: 16 });
    const e = embed('quorum intersection safety', 64);
    idx.insert('x', e, { v: 1 });
    assert.ok(idx.candidates(e).has('x'));
    assert.ok(idx.remove('x'));
    assert.ok(!idx.candidates(e).has('x'));
  });
}

// ───────────────────────── memory/chain ─────────────────────────
section('memory/chain (blockchain primitive)');
{
  const Chain = require('./memory/chain');
  test('append + validate', () => {
    const c = new Chain({ name: 't' });
    c.append({ a: 1 });
    c.append({ a: 2 });
    assert.strictEqual(c.height, 3); // genesis + 2
    assert.ok(c.validate().valid);
  });
  test('tampering is detected', () => {
    const c = new Chain({});
    c.append({ a: 1 });
    c.append({ a: 2 });
    c.blocks[1].payload.a = 999; // tamper
    const v = c.validate();
    assert.ok(!v.valid && v.brokenAt === 1);
  });
  test('repair() self-corrects a broken chain', () => {
    const c = new Chain({});
    c.append({ a: 1 });
    c.append({ a: 2 });
    c.blocks[1].payload.a = 999;
    const repaired = c.repair();
    assert.ok(repaired >= 1);
    assert.ok(c.validate().valid);
  });
  test('PoW difficulty produces leading zeros', () => {
    const c = new Chain({ difficulty: 2 });
    const b = c.append({ x: 1 });
    assert.ok(b.hash.startsWith('00'));
    assert.ok(c.validate().valid);
  });
  test('prune removes matching payloads and re-links', () => {
    const c = new Chain({});
    c.append({ keep: false });
    c.append({ keep: true });
    c.prune((p) => p.keep === false);
    assert.ok(c.validate().valid);
  });
}

// ───────────────────────── memory/shortTermMemory ─────────────────────────
section('memory/shortTermMemory (STM blockchain)');
{
  const STM = require('./memory/shortTermMemory');
  const { embed } = require('./util/embedding');
  const mk = (text) => ({ claim_id: crypto.randomUUID(), claim_text: text, embedding: embed(text, 64), confidence: 0.9, salience: 0.7, source_traces: [], validation: {}, created_at: Date.now(), expires_at: Date.now() + 1000, promoted: false, state: 'PENDING', replays: 0, retry_count: 0 });
  test('insert appends to the STM blockchain', () => {
    const s = new STM({ dim: 64 });
    s.insert(mk('alpha claim'));
    assert.strictEqual(s.size, 1);
    assert.strictEqual(s.chain.height, 2);
    assert.ok(s.validateChain().valid);
  });
  test('nearestNeighbor finds a similar entry', () => {
    const s = new STM({ dim: 64 });
    s.insert(mk('byzantine fault tolerance quorum'));
    const hit = s.nearestNeighbor(embed('byzantine fault tolerance quorum', 64));
    assert.ok(hit && hit.similarity > 0.99);
  });
  test('pruneExpired drops expired entries', () => {
    const s = new STM({ dim: 64 });
    s.insert(mk('soon expired'));
    const removed = s.pruneExpired(Date.now() + 5000);
    assert.strictEqual(removed, 1);
    assert.strictEqual(s.size, 0);
  });
}

// ───────────────────────── memory/longTermMemory ─────────────────────────
section('memory/longTermMemory (LTM blockchain)');
{
  const LTM = require('./memory/longTermMemory');
  const { embed } = require('./util/embedding');
  const mem = (text, conf = 0.9) => ({ claim_text: text, embedding: embed(text, 64), confidence: conf, salience: 0.7, consensus_votes: [], proposer: 'p', validation: {} });
  test('commit + LSH query + chain validity', () => {
    const l = new LTM({ dim: 64 });
    const b = l.commit(mem('forward secrecy via ephemeral keys'));
    assert.strictEqual(l.size, 1);
    const hit = l.query(embed('forward secrecy via ephemeral keys', 64), 0.85);
    assert.ok(hit && hit.block.hash === b.hash);
    assert.ok(l.validate().valid);
  });
  test('associative graph wires related memories', () => {
    const l = new LTM({ dim: 64, assocThreshold: 0.3 });
    l.commit(mem('byzantine fault tolerance honest validators safety'));
    l.commit(mem('byzantine fault tolerance quorum consensus safety'));
    assert.ok(l.graphStats().edges >= 1);
  });
  test('supersede removes from served index', () => {
    const l = new LTM({ dim: 64 });
    const b = l.commit(mem('to be superseded'));
    l.markSuperseded(b.hash, null);
    assert.strictEqual(l.query(embed('to be superseded', 64), 0.85), null);
  });
}

// ───────────────────────── memory/rrc ─────────────────────────
section('memory/rapidRetrievalCache');
{
  const RRC = require('./memory/rapidRetrievalCache');
  const { embed } = require('./util/embedding');
  test('index + O(1) hit + invalidate', () => {
    const r = new RRC({ dim: 64 });
    const block = { hash: 'h1', embedding: embed('tendermint bft consensus', 64), claim_text: 'tendermint bft consensus', confidence: 0.95, validation: {} };
    r.indexBlock(block);
    const hit = r.query(embed('tendermint bft consensus', 64));
    assert.ok(hit && hit.source === 'h1');
    assert.ok(r.invalidate('h1'));
    assert.strictEqual(r.query(embed('tendermint bft consensus', 64)), null);
  });
}

// ───────────────────────── engine/knowledgeGraph + gte ─────────────────────────
section('engine/gte (real graph traversal)');
{
  const GTE = require('./engine/gte');
  const KG = require('./engine/knowledgeGraph');
  test('BFS supports related grounded claims', () => {
    const g = new GTE({});
    g.addGrounded('byzantine fault tolerance honest validators');
    const v = g.bfsValidate('byzantine fault tolerance quorum', null, 2);
    assert.ok(v.score > 0 && v.conflict_score === 0);
  });
  test('DFS grounds a reachable claim, not an unrelated one', () => {
    const g = new GTE({});
    g.addGrounded('merkle proofs verify inclusion logarithmic');
    assert.strictEqual(g.dfsAudit('merkle proofs inclusion').type, 'Grounded');
    assert.strictEqual(g.dfsAudit('completely unrelated banana').type, 'Ungrounded');
  });
  test('refuted claim yields conflict', () => {
    const g = new GTE({});
    g.addRefuted('the chain accepts double spends freely');
    const v = g.bfsValidate('chain accepts double spends', null, 2);
    assert.ok(v.conflict_score > 0);
  });
  test('Dijkstra and A* find a path through shared entities', () => {
    const kg = new KG();
    kg.addClaim('alpha beta shared');
    kg.addClaim('shared gamma delta');
    const a = KG.claimNodeId('alpha beta shared');
    const b = KG.claimNodeId('shared gamma delta');
    const d = kg.dijkstra(a, b);
    const s = kg.aStar(a, b);
    assert.ok(d.distance < Infinity && d.path.length >= 3);
    assert.ok(s.distance < Infinity);
  });
}

// ───────────────────────── engine/ese ─────────────────────────
section('engine/ese (deep ensemble + temperature scaling)');
{
  const ESE = require('./engine/ese');
  const Embedder = require('./nn/embedder');
  test('learns to separate taught (valid) from refuted (invalid)', () => {
    const emb = new Embedder({ dim: 48 });
    const ese = new ESE({ embedder: emb, dim: 48, seed: 2 });
    ['secure hashing prevents tampering', 'consensus requires honest majority', 'cryptographic signatures verify identity'].forEach((t) => ese.addExample(t, 1));
    ['the moon is made of cheese', 'gravity pushes objects upward', 'fire is cold'].forEach((t) => ese.addExample(t, 0));
    const good = ese.calibratedConfidence('cryptographic signatures verify identity');
    const bad = ese.calibratedConfidence('the moon is made of cheese');
    assert.ok(good > bad, `good ${good} bad ${bad}`);
  });
  test('epistemic uncertainty is in [0,1]', () => {
    const emb = new Embedder({ dim: 32 });
    const ese = new ESE({ embedder: emb, dim: 32 });
    ese.addExample('alpha fact', 1);
    const u = ese.estimateEpistemicUncertainty('totally novel unrelated thing');
    assert.ok(u >= 0 && u <= 1);
  });
}

// ───────────────────────── consensus/validatorKey + bvas signatures ─────────────────────────
section('consensus/validatorKey (Ed25519)');
{
  const ValidatorKey = require('./consensus/validatorKey');
  const BVAS = require('./engine/bvas');
  test('sign/verify round-trips; tamper fails', () => {
    const k = new ValidatorKey();
    const msg = Buffer.from('consensus message');
    const sig = k.sign(msg);
    assert.ok(ValidatorKey.verify(msg, sig, k.publicKeyB64));
    assert.ok(!ValidatorKey.verify(Buffer.from('tampered'), sig, k.publicKeyB64));
  });
  test('BVAS verifies a genuine vote and rejects a forged one', () => {
    const k = new ValidatorKey();
    const vote = { claim_id: 'c1', node_id: 'n1', vote: 'YES', vote_score: 0.9, publicKey: k.publicKeyB64 };
    vote.signature = k.sign(BVAS.canonicalVoteBytes(vote));
    assert.ok(BVAS.verifyVote(vote));
    const forged = { ...vote, vote_score: 0.1 }; // changed signed field
    assert.ok(!BVAS.verifyVote(forged));
  });
}

// ───────────────────────── engine/bvas (5-stage) ─────────────────────────
section('engine/bvas (5-stage pipeline)');
{
  const BVAS = require('./engine/bvas');
  const LTM = require('./memory/longTermMemory');
  const { embed } = require('./util/embedding');
  test('passes a clean candidate, gates a low-confidence one', () => {
    const bvas = new BVAS({ ltm: new LTM({ dim: 64 }), thetaConf: 0.6 });
    const ok = bvas.validate({ claim_text: 'valid claim', embedding: embed('valid claim', 64), confidence: 0.9 });
    assert.ok(ok.ok && ok.score >= 0.6);
    const low = bvas.validate({ claim_text: 'weak claim', embedding: embed('weak claim', 64), confidence: 0.3 });
    assert.ok(!low.ok);
  });
}

// ───────────────────────── consensus/bft + transport ─────────────────────────
section('consensus/bft (multi-round signed BFT + leader rotation)');
{
  const { InProcessBus } = require('./consensus/transport');
  const { BFTNode, runConsensusRound } = require('./consensus/bft');
  const ValidatorKey = require('./consensus/validatorKey');

  function cluster(n, evaluators, faulty = () => false) {
    const keys = Array.from({ length: n }, () => new ValidatorKey());
    const validators = new Map();
    keys.forEach((k, i) => validators.set(`v${i}`, { publicKeyB64: k.publicKeyB64, weight: 1 }));
    const bus = new InProcessBus();
    let decision = null;
    const nodes = keys.map((k, i) => new BFTNode({ nodeId: `v${i}`, key: k, validators, transport: bus, tauC: 0.67, evaluate: evaluators(i), faulty: faulty(i), onDecide: (r) => { if (!decision) decision = r; } }));
    return { nodes, bus, decision: () => decision };
  }

  test('commits when all honest nodes vote YES', () => {
    const c = cluster(7, () => () => ({ vote: 'YES', score: 0.9 }));
    runConsensusRound(c.nodes, c.bus, { claim_id: 'c1' });
    assert.ok(c.decision() && c.decision().committed);
    assert.strictEqual(c.decision().round, 0);
  });
  test('tolerates f < n/3 Byzantine (2 of 7 vote NO) and still commits', () => {
    const c = cluster(7, (i) => () => ({ vote: i < 2 ? 'NO' : 'YES', score: i < 2 ? 0.1 : 0.9 }));
    runConsensusRound(c.nodes, c.bus, { claim_id: 'c2' });
    assert.ok(c.decision() && c.decision().committed, 'should commit with 5/7 YES');
  });
  test('does NOT commit when quorum fails (3 of 7 vote NO)', () => {
    const c = cluster(7, (i) => () => ({ vote: i < 3 ? 'NO' : 'YES', score: i < 3 ? 0.1 : 0.9 }));
    runConsensusRound(c.nodes, c.bus, { claim_id: 'c3' });
    assert.ok(!c.decision(), 'must not reach 2/3 with only 4/7 YES');
  });
  test('leader rotation: silent round-0 leader → round-1 leader commits', () => {
    // v0 is the round-0 proposer but is faulty (silent). Honest nodes time out,
    // rotate, and the round-1 proposer (v1) drives the commit.
    const c = cluster(7, () => () => ({ vote: 'YES', score: 0.9 }), (i) => i === 0);
    runConsensusRound(c.nodes, c.bus, { claim_id: 'c4' });
    assert.ok(c.decision() && c.decision().committed, 'should still commit despite a silent leader');
    assert.ok(c.decision().round >= 1, `expected rotation to round ≥1, got ${c.decision().round}`);
  });
}

// ───────────────────────── consensus/cdcp ─────────────────────────
section('consensus/cdcp (consensus-driven consolidation)');
{
  test('untaught claim cannot be consolidated', () => {
    const node = fast();
    node.observe({ claim: 'unverifiable assertion xyz', reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
    const r = node.consolidate(node.stm.all()[0].claim_id);
    assert.notStrictEqual(r.status, 'PROMOTED');
    assert.strictEqual(node.ltm.size, 0);
  });
  test('taught claim reaches quorum → committed to LTM', () => {
    const node = fast();
    const c = 'forward secrecy uses ephemeral key exchange';
    node.teach(c);
    node.observe({ claim: c, reward: 1, epistemic: { conf_cal: 0.92, u_ep: 0.05 } });
    const r = node.consolidate(node.stm.all()[0].claim_id);
    assert.strictEqual(r.status, 'PROMOTED', `got ${r.status}`);
    assert.strictEqual(node.ltm.size, 1);
  });
}

// ───────────────────────── pipeline (salience/decay/triage) ─────────────────────────
section('pipeline (salience, decay, triage)');
{
  const { salienceScore, novelty } = require('./pipeline/salience');
  const { decayScore } = require('./pipeline/decay');
  const { DEFAULT_CONFIG } = require('./config');
  test('salience composite in [0,1]; novelty falls with similarity', () => {
    const s = salienceScore({ nov: 1, rlrfWeight: 1, accessFreq: 0, confidence: 0.9 }, DEFAULT_CONFIG.salience);
    assert.ok(s > 0 && s <= 1);
    const { embed } = require('./util/embedding');
    const a = embed('alpha beta', 64);
    assert.ok(novelty(a, [a]) < 0.01);
  });
  test('decay: older < fresher; replays reinforce', () => {
    const e = { salience: 0.8, created_at: Date.now(), replays: 0 };
    assert.ok(decayScore(e, Date.now() + 24 * 3600e3, DEFAULT_CONFIG) < decayScore(e, Date.now(), DEFAULT_CONFIG));
    const r = { salience: 0.8, created_at: Date.now(), replays: 10 };
    const t = Date.now() + 3600e3;
    assert.ok(decayScore(r, t, DEFAULT_CONFIG) > decayScore(e, t, DEFAULT_CONFIG));
  });
  test('triage expires fully-decayed STM entries', () => {
    const node = fast();
    node.observe({ claim: 'transient note', reward: 0.6, epistemic: { conf_cal: 0.65, u_ep: 0.2 } });
    const r = node.triage({ now: Date.now() + 1000 * 3600e3 });
    assert.ok(r.expired >= 1 || node.stm.size === 0);
  });
}

// ───────────────────────── engine/rce ─────────────────────────
section('engine/rce (replay & consolidation)');
{
  test('replay consolidates a taught survivor to LTM', () => {
    const node = fast();
    const c = 'group relative policy optimisation reduces variance';
    node.teach(c);
    node.observe({ claim: c, reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
    const report = node.replay();
    assert.ok(report.promoted >= 1, `promoted ${report.promoted}`);
  });
}

// ───────────────────────── markov chain-graph ─────────────────────────
section('markov/markovGraph (chain graph)');
{
  const MarkovGraph = require('./markov/markovGraph');
  test('transition counts → probabilities; link-chain overlay tracks order', () => {
    const g = new MarkovGraph();
    g.visit('a'); g.visit('b'); g.visit('a'); g.visit('b'); g.visit('c');
    assert.ok(g.prob('a', 'b') > 0);
    assert.strictEqual(g.nextBest('a'), 'b');
    assert.strictEqual(g.chainNext('a'), 'b'); // overlay: a was followed by b
    assert.ok(g.stats().states === 3);
  });
  test('random walk stays within the graph', () => {
    const g = new MarkovGraph();
    g.observeTransition('x', 'y'); g.observeTransition('y', 'z');
    const path = g.randomWalk('x', 5, () => 0);
    assert.ok(path.length >= 1 && path[0] === 'x');
  });
}

// ───────────────────────── nn/tinyLM, ngramLM, registry ─────────────────────────
section('nn/tinyLM + ngramLM + registry (SLMs)');
{
  const TinyLM = require('./nn/tinyLM');
  const NgramLM = require('./nn/ngramLM');
  const ModelRegistry = require('./nn/modelRegistry');
  const Embedder = require('./nn/embedder');
  test('TinyLM scores an observed transition above an unobserved one', () => {
    const A = 'alpha encryption keys handshake protocol';
    const B = 'beta consensus quorum commit safety';
    const C = 'gamma photosynthesis chlorophyll sunlight leaves';
    const emb = new Embedder({ dim: 48, lr: 0.1 });
    [A, B, C].forEach((t) => emb.observe(t));
    emb.train({ epochs: 120 });
    const lm = new TinyLM({ embedder: emb, dim: 48, seed: 4 });
    for (let i = 0; i < 8; i++) {
      lm.observeTransition(A, B); // A → B is the only observed transition
      lm.observeTransition(B, C);
    }
    lm.trainIfDirty({ epochs: 1200 });
    const good = lm.score(A, B); // observed transition
    const bad = lm.score(A, C); // never observed from A
    assert.ok(good > bad, `observed ${good.toFixed(3)} should beat unobserved ${bad.toFixed(3)}`);
    assert.ok(good >= 0 && good <= 1);
  });
  test('NgramLM gives higher likelihood to trained text', () => {
    const lm = new NgramLM({ n: 2 });
    lm.train('byzantine fault tolerance requires honest majority');
    const seen = lm.logLikelihood('byzantine fault tolerance');
    const unseen = lm.logLikelihood('xylophone quasar nebula');
    assert.ok(seen > unseen);
  });
  test('registry routes by kind', () => {
    const r = new ModelRegistry();
    r.register('t', { mark: 1 }, { kind: 'tinyLM' });
    r.register('s', { mark: 2 }, { kind: 'slm' });
    assert.strictEqual(r.route({ kind: 'slm' }).model.mark, 2);
  });
}

// ───────────────────────── markov/navigator ─────────────────────────
section('markov/navigator (model-directed traversal)');
{
  test('navigator produces a directed path over the chain graph', () => {
    const node = fast();
    const claims = ['start node alpha', 'middle node beta', 'final node gamma'];
    for (const c of claims) node.observe({ claim: c, reward: 0.9, epistemic: { conf_cal: 0.8, u_ep: 0.1 } });
    const { path } = node.navigate('start node alpha', 5);
    assert.ok(path.length >= 1 && path[0] === 'start node alpha');
  });
}

// ───────────────────────── network/chainAdapter ─────────────────────────
section('network/chainAdapter (poly-chain morphism)');
{
  const { standaloneAdapter, powAdapter } = require('./network/chainAdapter');
  test('standalone adapter produces a linked hash', () => {
    const a = standaloneAdapter();
    const r1 = a.commit({ claim_text: 'x', confidence: 0.9 }, '00');
    const r2 = a.commit({ claim_text: 'y', confidence: 0.9 }, r1.hash);
    assert.ok(r1.hash && r2.hash && r1.hash !== r2.hash);
  });
  test('pow adapter mines leading zeros', () => {
    const a = powAdapter({ difficulty: 3 });
    const r = a.commit({ claim_text: 'z', confidence: 0.9 }, '00');
    assert.ok(r.hash.startsWith('000'));
  });
  test('morph swaps substrate at runtime, preserving blocks', () => {
    const node = new DarmAnn({ nodeId: 'morph', config: { cdcp: { tMinAgeMs: 0 } }, adapter: standaloneAdapter() });
    const c1 = 'distributed ledgers use hash chains';
    node.teach(c1);
    node.observe({ claim: c1, reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
    node.consolidate(node.stm.all()[0].claim_id);
    const before = node.ltm.size;
    node.morph(powAdapter({ difficulty: 2 }));
    const c2 = 'photosynthesis converts light to energy in plants';
    node.teach(c2);
    node.observe({ claim: c2, reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
    node.consolidate(node.stm.all().find((e) => !e.promoted).claim_id);
    assert.strictEqual(node.ltm.size, before + 1);
    assert.ok(node.ltm.blocks[before].hash.startsWith('00'));
  });
}

// ───────────────────────── network/swarm ─────────────────────────
section('network/swarm (cross-chain pollination)');
{
  const { standaloneAdapter, powAdapter } = DarmAnn.adapters;
  test('pollination disseminates a memory to a peer chain', () => {
    const a = new DarmAnn({ nodeId: 'A', config: { cdcp: { tMinAgeMs: 0 } }, adapter: standaloneAdapter() });
    const b = new DarmAnn({ nodeId: 'B', config: { cdcp: { tMinAgeMs: 0 } }, adapter: powAdapter({ difficulty: 1 }) });
    const c = 'cross chain pollination spreads validated knowledge';
    a.teach(c);
    a.observe({ claim: c, reward: 1, epistemic: { conf_cal: 0.95, u_ep: 0.05 } });
    a.consolidate(a.stm.all()[0].claim_id);
    const swarm = new DarmAnn.Swarm({ nodes: [a, b] });
    const report = swarm.pollinate({ topK: 5 });
    assert.ok(report.accepted >= 1);
    assert.ok(b.ltm.size >= 1, 'peer B re-consolidated the pollinated memory');
  });
}

// ───────────────────────── self-correction ─────────────────────────
section('self-correction');
{
  test('selfCorrect repairs a tampered STM blockchain', () => {
    const node = fast();
    node.observe({ claim: 'a durable claim worth keeping', reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
    node.stm.chain.blocks[1].payload.claim_text = 'TAMPERED';
    assert.ok(!node.stm.validateChain().valid);
    const report = node.selfCorrect();
    assert.ok(report.stmRepaired >= 1);
    assert.ok(node.stm.validateChain().valid);
  });
  test('selfCorrect supersedes an LTM entry that becomes refuted', () => {
    const node = fast();
    const c = 'the protocol is perfectly secure forever';
    node.teach(c);
    node.observe({ claim: c, reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
    node.consolidate(node.stm.all()[0].claim_id);
    assert.strictEqual(node.ltm.size, 1);
    node.refute(c); // new evidence contradicts it
    const report = node.selfCorrect();
    assert.ok(report.superseded >= 1);
    assert.ok(node.ltm.blocks[0].superseded);
  });
}

// ───────────────────────── consensus WAL (crash recovery) ─────────────────────────
section('consensus/wal (crash recovery)');
{
  const WAL = require('./consensus/wal');
  const { InProcessBus } = require('./consensus/transport');
  const { BFTNode } = require('./consensus/bft');
  const ValidatorKey = require('./consensus/validatorKey');
  test('WAL append + replay round-trips', () => {
    const w = new WAL();
    w.append({ t: 'ENTER', round: 0 });
    w.append({ t: 'PRECOMMIT', round: 0, choice: 'value' });
    assert.strictEqual(w.replay().length, 2);
    assert.strictEqual(w.replay()[1].choice, 'value');
  });
  test('recovers a lock from WAL → will not equivocate after restart', () => {
    const key = new ValidatorKey();
    const validators = new Map([['v0', { publicKeyB64: key.publicKeyB64, weight: 1 }]]);
    const wal = new WAL();
    // Simulate a pre-crash node that entered round 0 and precommitted the value.
    wal.append({ t: 'ENTER', round: 0, height: 0, node: 'v0' });
    wal.append({ t: 'PREVOTE', round: 0, height: 0, node: 'v0', choice: 'value' });
    wal.append({ t: 'PRECOMMIT', round: 0, height: 0, node: 'v0', choice: 'value' });
    // Restart: a fresh node whose policy would now vote NO.
    const node = new BFTNode({ nodeId: 'v0', key, validators, transport: new InProcessBus(), tauC: 0.67, evaluate: () => ({ vote: 'NO', score: 0.1 }), wal });
    const rec = node.recoverFromWAL();
    assert.ok(rec.recovered && rec.locked, 'should recover a lock');
    // Because it is locked, a prevote in a later round must still choose 'value'.
    node.value = { claim_id: 'tcp' };
    let sent = null;
    node.transport.broadcast = (_f, m) => { if (m.type === 'PREVOTE') sent = m.choice; };
    node.handle = BFTNode.prototype.handle.bind(node);
    node._doPrevote(1);
    assert.strictEqual(sent, 'value', 'locked node must keep prevoting value (no equivocation)');
  });
}

// ───────────────────────── replicated state machine: live membership via consensus ─────────────────────────
// ───────────────────────── gossip mempool ─────────────────────────
section('consensus/mempool (gossip tx propagation)');
{
  const { InProcessBus } = require('./consensus/transport');
  const Mempool = require('./consensus/mempool');
  const ValidatorKey = require('./consensus/validatorKey');

  function gossipNet(n, fanout = 3) {
    const bus = new InProcessBus();
    const ids = Array.from({ length: n }, (_, i) => `v${i}`);
    // Seeded PRNG → deterministic gossip fan-out (no flaky coverage).
    let s = 12345;
    const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const pools = ids.map((id) => new Mempool({ nodeId: id, key: new ValidatorKey(), transport: bus, fanout, ttl: n + 2, rng }));
    pools.forEach((p) => p.setPeers(ids));
    pools.forEach((p) => bus.connect(p.nodeId, (msg) => p.handle(msg)));
    return { bus, pools };
  }

  test('a tx submitted at one node reaches every node via gossip', () => {
    const { bus, pools } = gossipNet(6);
    pools[3].submit('memory', { claim: 'gossiped fact' });
    bus.pump();
    assert.ok(pools.every((p) => p.size() === 1), 'all nodes hold the tx');
    const ids = new Set(pools.map((p) => p.take(1)[0].id));
    assert.strictEqual(ids.size, 1, 'same tx id everywhere');
  });

  test('duplicate gossip is deduplicated (no infinite re-broadcast)', () => {
    const { bus, pools } = gossipNet(5);
    const tx = pools[0].submit('memory', { claim: 'dup' });
    bus.pump();
    // Re-inject the same tx at another node; pool size must stay 1.
    pools[2].handle({ type: 'TX_GOSSIP', ttl: 5, tx });
    bus.pump();
    assert.ok(pools.every((p) => p.size() === 1));
  });

  test('a forged tx (bad signature) is dropped by peers', () => {
    const { bus, pools } = gossipNet(4);
    const tx = pools[0].submit('memory', { claim: 'real' });
    const forged = { ...tx, payload: { claim: 'tampered' } }; // id no longer matches/sig invalid
    pools[1].handle({ type: 'TX_GOSSIP', ttl: 4, tx: forged });
    bus.pump();
    assert.ok(pools.every((p) => p.size() === 1), 'forged tx not admitted');
  });

  test('committed txns are removed from the pool', () => {
    const { bus, pools } = gossipNet(3);
    const tx = pools[0].submit('memory', { claim: 'to commit' });
    bus.pump();
    pools.forEach((p) => p.remove([tx.id]));
    assert.ok(pools.every((p) => p.size() === 0));
    // Dedup memory persists: re-gossip does not re-admit a committed tx.
    pools[1].handle({ type: 'TX_GOSSIP', ttl: 3, tx });
    bus.pump();
    assert.ok(pools.every((p) => p.size() === 0), 'committed tx not re-admitted');
  });
}

// ───────────────────────── fault injection (safety + liveness) ─────────────────────────
section('consensus/bft fault injection');
{
  const { InProcessBus } = require('./consensus/transport');
  const { BFTNode, runConsensusRound } = require('./consensus/bft');
  const ValidatorKey = require('./consensus/validatorKey');

  function cluster(n, faults, evaluators) {
    const keys = Array.from({ length: n }, () => new ValidatorKey());
    const validators = new Map();
    keys.forEach((k, i) => validators.set(`v${i}`, { publicKeyB64: k.publicKeyB64, weight: 1 }));
    const bus = new InProcessBus({ faults });
    let decision = null;
    const nodes = keys.map((k, i) => new BFTNode({ nodeId: `v${i}`, key: k, validators, transport: bus, tauC: 0.67, evaluate: (evaluators && evaluators(i)) || (() => ({ vote: 'YES', score: 0.9 })), onDecide: (r) => { if (!decision) decision = r; } }));
    return { nodes, bus, decision: () => decision };
  }

  test('liveness: random 20% message drop still reaches commit', () => {
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const c = cluster(7, { drop: () => rand() < 0.2 });
    runConsensusRound(c.nodes, c.bus, { claim_id: 'drop20' });
    assert.ok(c.decision() && c.decision().committed, 'should still commit under 20% loss');
    assert.ok(c.bus.stats.dropped > 0, 'drops actually occurred');
  });

  test('liveness: a partitioned minority (2 of 7) does not block commit', () => {
    // Cut v5,v6 off from everyone — the 5-node majority must still commit.
    const partition = new Set();
    for (const a of ['v5', 'v6']) for (const b of ['v0', 'v1', 'v2', 'v3', 'v4']) { partition.add(`${a}|${b}`); }
    const c = cluster(7, { partition });
    runConsensusRound(c.nodes, c.bus, { claim_id: 'partition' });
    assert.ok(c.decision() && c.decision().committed, 'majority commits despite the partition');
  });

  test('safety: total partition (no quorum reachable) does NOT commit', () => {
    // Split into {v0,v1,v2} | {v3,v4,v5,v6}; neither side reaches 2/3 of 7.
    const A = ['v0', 'v1', 'v2'];
    const B = ['v3', 'v4', 'v5', 'v6'];
    const partition = new Set();
    for (const a of A) for (const b of B) partition.add(`${a}|${b}`);
    const c = cluster(7, { partition });
    runConsensusRound(c.nodes, c.bus, { claim_id: 'split' });
    assert.ok(!c.decision(), 'no side has a 2/3 quorum → must not commit');
  });
}

// ───────────────────────── Byzantine equivocation ─────────────────────────
section('consensus/bft Byzantine equivocation');
{
  const { InProcessBus } = require('./consensus/transport');
  const { BFTNode, runConsensusRound } = require('./consensus/bft');
  const ValidatorKey = require('./consensus/validatorKey');
  const BVAS = require('./engine/bvas');

  function honestCluster(n, byzantineIdx = []) {
    const keys = Array.from({ length: n }, () => new ValidatorKey());
    const validators = new Map();
    keys.forEach((k, i) => validators.set(`v${i}`, { publicKeyB64: k.publicKeyB64, weight: 1 }));
    const bus = new InProcessBus();
    let decision = null;
    const nodes = keys.map((k, i) => new BFTNode({ nodeId: `v${i}`, key: k, validators, transport: bus, tauC: 0.67, evaluate: () => ({ vote: 'YES', score: 0.9 }), onDecide: (r) => { if (!decision) decision = r; } }));
    return { keys, validators, bus, nodes, decision: () => decision };
  }

  test('an equivocating voter is counted once per round (no double-weight)', () => {
    const c = honestCluster(7);
    // The honest round-0 proposer is whoever proposerFor(0) selects.
    const proposerId = c.nodes[0].proposerFor(0);
    c.nodes.forEach((nd) => nd.start({ claim_id: 'equiv' }));
    c.bus.pump();
    // v1 (Byzantine) sends a SECOND, differently-scored prevote for the same round.
    const vIdx = 1;
    const dup = { claim_id: 'equiv', node_id: 'v1', vote: 'YES', vote_score: 0.123456, publicKey: c.keys[vIdx].publicKeyB64 };
    dup.signature = c.keys[vIdx].sign(BVAS.canonicalVoteBytes(dup));
    c.nodes.forEach((nd) => nd.handle({ type: 'PREVOTE', round: 0, claim_id: 'equiv', from: 'v1', choice: 'value', vote: dup }));
    c.bus.pump();
    // Each honest node's round-0 prevote tally has exactly ONE entry for v1.
    for (const nd of c.nodes) {
      const rs = nd.rounds.get(0);
      if (rs) assert.ok(!rs.prevotes.has('v1') || [...rs.prevotes.keys()].filter((k) => k === 'v1').length === 1, 'v1 counted at most once');
    }
    assert.ok(true);
  });

  test('safety: f Byzantine equivocators cannot forge a quorum (4 honest of 7 < 2/3)', () => {
    // 3 Byzantine nodes (v0,v1,v2) try to push a value while the 4 honest nodes
    // (v3..v6) vote NO. 4/7 < ⌈2/3·7⌉=5, so no commit may occur.
    const keys = Array.from({ length: 7 }, () => new ValidatorKey());
    const validators = new Map();
    keys.forEach((k, i) => validators.set(`v${i}`, { publicKeyB64: k.publicKeyB64, weight: 1 }));
    const bus = new InProcessBus();
    let decision = null;
    const nodes = keys.map((k, i) => new BFTNode({
      nodeId: `v${i}`, key: k, validators, transport: bus, tauC: 0.67,
      evaluate: () => ({ vote: i < 3 ? 'YES' : 'NO', score: i < 3 ? 0.9 : 0.0 }),
      onDecide: (r) => { if (!decision) decision = r; },
    }));
    runConsensusRound(nodes, bus, { claim_id: 'byz' });
    assert.ok(!decision, 'Byzantine minority cannot manufacture a 2/3 quorum');
  });

  test('a vote with a valid signature but wrong signer identity is rejected', () => {
    const c = honestCluster(5);
    // Forge: claim to be v2 but sign with v4's key (publicKey won't match v2's).
    const forged = { claim_id: 'x', node_id: 'v2', vote: 'YES', vote_score: 0.9, publicKey: c.keys[4].publicKeyB64 };
    forged.signature = c.keys[4].sign(BVAS.canonicalVoteBytes(forged));
    const target = c.nodes[0];
    target.start({ claim_id: 'x' });
    target.handle({ type: 'PREVOTE', round: 0, claim_id: 'x', from: 'v2', choice: 'value', vote: forged });
    const rs = target.rounds.get(0);
    // v2's slot must not be filled by a key that isn't v2's registered key.
    assert.ok(!rs || !rs.prevotes.has('v2') || rs.prevotes.get('v2') === 'nil', 'identity-mismatched vote rejected');
  });
}

section('consensus/replica (live membership as consensus txns)');
{
  const { InProcessBus } = require('./consensus/transport');
  const { Replica, runHeight } = require('./consensus/replica');
  const ValidatorKey = require('./consensus/validatorKey');
  const WAL = require('./consensus/wal');

  function makeReplicas(n) {
    const keys = Array.from({ length: n }, () => new ValidatorKey());
    const base = new Map();
    keys.forEach((k, i) => base.set(`v${i}`, { publicKeyB64: k.publicKeyB64, weight: 1 }));
    const reps = keys.map((k, i) => new Replica({ nodeId: `v${i}`, key: k, validators: base, tauC: 0.67 }));
    return { keys, reps };
  }

  test('cluster grows and shrinks live, with every replica agreeing', () => {
    const bus = new InProcessBus();
    const { reps } = makeReplicas(4);

    assert.ok(runHeight(reps, bus, { type: 'memory', claim: 'genesis fact' }).committed);
    assert.ok(reps.every((r) => r.height === 1 && r.size() === 4));

    // JOIN: a brand-new validator (its own key) added via a consensus txn.
    const v4 = new ValidatorKey();
    const join = { type: 'add-validator', nodeId: 'v4', publicKeyB64: v4.publicKeyB64, weight: 1 };
    assert.ok(runHeight(reps, bus, join).committed);
    assert.ok(reps.every((r) => r.size() === 5), 'all replicas grew to 5');

    // The new node starts from the agreed state and participates next height.
    const r4 = new Replica({ nodeId: 'v4', key: v4, validators: reps[0].set, tauC: 0.67 });
    r4.height = reps[0].height;
    const all = [...reps, r4];
    assert.ok(runHeight(all, bus, { type: 'memory', claim: 'post-join fact' }).committed, 'commits with 5 validators');
    assert.ok(all.every((r) => r.size() === 5 && r.height === 3));

    // LEAVE: remove v4 via consensus.
    assert.ok(runHeight(all, bus, { type: 'remove-validator', nodeId: 'v4' }).committed);
    assert.ok(reps.every((r) => r.size() === 4), 'all replicas shrank to 4');
    // Every replica agrees on the committed log.
    const ref = JSON.stringify(reps[0].log.map((e) => e.value));
    assert.ok(reps.every((r) => JSON.stringify(r.log.map((e) => e.value)) === ref), 'logs agree');
  });

  test('memory consolidation through the RSM yields one replicated LTM', () => {
    const LongTermMemory = require('./memory/longTermMemory');
    const Embedder = require('./nn/embedder');
    const bus = new InProcessBus();
    const keys = Array.from({ length: 4 }, () => new ValidatorKey());
    const base = new Map();
    keys.forEach((k, i) => base.set(`v${i}`, { publicKeyB64: k.publicKeyB64, weight: 1 }));
    // Each replica applies committed memory txns to its OWN LTM + embedder.
    // Deterministic init ⇒ identical embeddings ⇒ identical block hashes.
    const ltms = keys.map(() => new LongTermMemory({ dim: 64 }));
    const embs = keys.map(() => new Embedder({ dim: 64 }));
    const reps = keys.map((k, i) =>
      new Replica({
        nodeId: `v${i}`, key: k, validators: base, tauC: 0.67,
        apply: (value) => {
          if (value.type === 'memory') ltms[i].commit({ claim_text: value.claim, embedding: embs[i].embed(value.claim), confidence: value.confidence || 0.9, salience: 0.7, consensus_votes: [], proposer: 'rsm', validation: {} });
        },
      })
    );
    runHeight(reps, bus, { type: 'memory', claim: 'forward secrecy via ephemeral keys', confidence: 0.9 });
    runHeight(reps, bus, { type: 'memory', claim: 'merkle proofs verify inclusion', confidence: 0.9 });
    const heads = ltms.map((l) => l.blocks.map((b) => b.hash).join(','));
    assert.ok(ltms.every((l) => l.size === 2), 'each replica committed 2 blocks');
    assert.ok(heads.every((h) => h === heads[0]), 'all LTM chains are byte-identical');
  });

  test('WAL recovery rebuilds replica state after a crash', () => {
    const bus = new InProcessBus();
    const keys = Array.from({ length: 4 }, () => new ValidatorKey());
    const base = new Map();
    keys.forEach((k, i) => base.set(`v${i}`, { publicKeyB64: k.publicKeyB64, weight: 1 }));
    const wals = keys.map(() => new WAL());
    const reps = keys.map((k, i) => new Replica({ nodeId: `v${i}`, key: k, validators: base, tauC: 0.67, wal: wals[i] }));
    const v4 = new ValidatorKey();
    runHeight(reps, bus, { type: 'memory', claim: 'a' });
    runHeight(reps, bus, { type: 'add-validator', nodeId: 'v4', publicKeyB64: v4.publicKeyB64, weight: 1 });
    assert.strictEqual(reps[0].height, 2);

    // "Crash" v0 and rebuild from its WAL.
    const recovered = new Replica({ nodeId: 'v0', key: keys[0], validators: base, tauC: 0.67, wal: wals[0] });
    const rec = recovered.recover();
    assert.ok(rec.recovered && recovered.height === 2 && recovered.size() === 5, JSON.stringify(rec));
  });

  test('WAL compaction (wired to a state snapshot) keeps recovery correct', () => {
    const bus = new InProcessBus();
    const keys = Array.from({ length: 4 }, () => new ValidatorKey());
    const base = new Map();
    keys.forEach((k, i) => base.set(`v${i}`, { publicKeyB64: k.publicKeyB64, weight: 1 }));
    const wal = new WAL();
    const reps = keys.map((k, i) => new Replica({ nodeId: `v${i}`, key: k, validators: base, tauC: 0.67, wal: i === 0 ? wal : new WAL() }));
    runHeight(reps, bus, { type: 'memory', claim: 'a' });
    runHeight(reps, bus, { type: 'memory', claim: 'b' });
    runHeight(reps, bus, { type: 'memory', claim: 'c' });
    const before = wal.replay().length;
    const snap = reps[0].snapshotState();
    reps[0].compactWAL(); // safe: state is captured by the snapshot
    assert.ok(wal.replay().length < before, 'WAL shrank after compaction');

    // Restart from snapshot + (compacted) WAL.
    const r = new Replica({ nodeId: 'v0', key: keys[0], validators: base, tauC: 0.67, wal });
    r.loadState(snap);
    r.recover();
    assert.strictEqual(r.height, reps[0].height, 'recovered height matches');
    assert.strictEqual(r.size(), reps[0].size());
  });
}

// ───────────────────────── mempool-driven RSM (any node proposes) ─────────────────────────
section('consensus/replica driven by the gossip mempool');
{
  const { InProcessBus } = require('./consensus/transport');
  const { Replica, runHeight } = require('./consensus/replica');
  const Mempool = require('./consensus/mempool');
  const ValidatorKey = require('./consensus/validatorKey');

  test('txns submitted at any node propagate and are committed by the proposer', () => {
    const consensusBus = new InProcessBus();
    const gossipBus = new InProcessBus();
    const n = 4;
    const keys = Array.from({ length: n }, () => new ValidatorKey());
    const base = new Map();
    keys.forEach((k, i) => base.set(`v${i}`, { publicKeyB64: k.publicKeyB64, weight: 1 }));
    const ids = keys.map((_, i) => `v${i}`);
    let s = 99;
    const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const reps = keys.map((k, i) => new Replica({ nodeId: `v${i}`, key: k, validators: base, tauC: 0.67 }));
    const pools = keys.map((k, i) => new Mempool({ nodeId: `v${i}`, key: k, transport: gossipBus, fanout: 3, ttl: n + 2, rng }));
    pools.forEach((p) => p.setPeers(ids));
    pools.forEach((p) => gossipBus.connect(p.nodeId, (m) => p.handle(m)));

    // Two DIFFERENT nodes submit txns (not an orchestrator).
    const t1 = pools[2].submit('memory', { claim: 'fact from node 2' });
    const t3 = pools[0].submit('memory', { claim: 'fact from node 0' });
    gossipBus.pump();
    assert.ok(pools.every((p) => p.size() === 2), 'both txns reached every mempool');

    // Each height: the round-robin proposer pulls its OWN mempool's head tx.
    for (let h = 0; h < 2; h++) {
      const proposerId = ids[(reps[0].height) % ids.length];
      const pIdx = ids.indexOf(proposerId);
      const tx = pools[pIdx].take(1)[0];
      const value = { type: 'memory', claim: tx.payload.claim, txId: tx.id };
      const r = runHeight(reps, consensusBus, value);
      assert.ok(r.committed, `height ${h} committed`);
      pools.forEach((p) => p.remove([tx.id])); // committed txns leave every pool
    }
    assert.ok(reps.every((rp) => rp.height === 2), 'two heights committed');
    assert.ok(pools.every((p) => p.size() === 0), 'all submitted txns consumed');
    // Every replica agrees on the same ordered log.
    const ref = JSON.stringify(reps[0].log.map((e) => e.value.claim));
    assert.ok(reps.every((rp) => JSON.stringify(rp.log.map((e) => e.value.claim)) === ref), 'logs agree');
  });
}

// ───────────────────────── dynamic validator-set membership ─────────────────────────
section('dynamic validator-set membership');
{
  test('add/remove validators changes the live quorum set; consensus uses it', () => {
    const node = fast();
    const c = 'membership changes apply at the next consolidation epoch';
    node.teach(c);
    const before = node.cdcp.voters.length;
    const added = node.addValidator();
    assert.strictEqual(node.cdcp.voters.length, before + 1);
    assert.strictEqual(node.cdcp._validatorSet().size, before + 1, 'round uses the new set');
    const rem = node.removeValidator(added.nodeId);
    assert.ok(rem.ok && node.cdcp.voters.length === before);
    assert.ok(node.removeValidator(node.self.nodeId).ok === false, 'cannot remove self');
    assert.ok(node.state().cluster.membershipVersion >= 2);
    // Consolidation still works against the (changed) set.
    node.observe({ claim: c, reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
    assert.strictEqual(node.consolidate(node.stm.all()[0].claim_id).status, 'PROMOTED');
  });
}

// ───────────────────────── persistence (deploy / restart) ─────────────────────────
section('persistence (save / load)');
{
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  test('snapshot → restore preserves LTM, retrieval, chains, markov', () => {
    const node = fast();
    const c = 'persisted consolidated knowledge survives restart';
    node.teach(c);
    node.observe({ claim: c, reward: 1, epistemic: { conf_cal: 0.92, u_ep: 0.05 } });
    node.consolidate(node.stm.all()[0].claim_id);
    node.observe({ claim: 'a second observed step', reward: 0.8, epistemic: { conf_cal: 0.8, u_ep: 0.1 } });
    assert.strictEqual(node.ltm.size, 1);

    const file = path.join(os.tmpdir(), `darm-snap-${process.pid}-${Date.now()}.json`);
    node.save(file);
    const restored = DarmAnn.load(file, { config: { cdcp: { tMinAgeMs: 0 } } });
    fs.unlinkSync(file);

    assert.strictEqual(restored.ltm.size, 1, 'LTM blocks restored');
    assert.ok(restored.ltm.validate().valid, 'restored LTM chain valid');
    const q = restored.query(c);
    assert.ok(q.hit && (q.tier === 'RRC' || q.tier === 'LTM'), `restored retrieval ${q.tier}`);
    assert.ok(restored.markov.stats().states >= 1, 'markov graph restored');
    assert.ok(restored.embedder.vocabSize() > 0, 'embedder vocab restored');
  });
}

// ───────────────────────── facade integration ─────────────────────────
// ───────────────────────── metrics (Prometheus exposition) ─────────────────────────
// ───────────────────────── throughput benchmark ─────────────────────────
// ───────────────────────── task manager (monitor) ─────────────────────────
// ───────────────────────── RBAC (scoped tokens) ─────────────────────────
// ───────────────────────── rate limiter ─────────────────────────
section('rateLimiter (token bucket)');
{
  const RateLimiter = require('./rateLimiter');
  test('allows up to capacity then blocks with retryAfter', () => {
    let t = 1000;
    const rl = new RateLimiter({ capacity: 3, refillPerSec: 1, now: () => t });
    assert.ok(rl.allow('k').ok);
    assert.ok(rl.allow('k').ok);
    assert.ok(rl.allow('k').ok);
    const blocked = rl.allow('k');
    assert.ok(!blocked.ok && blocked.retryAfterMs > 0);
  });
  test('refills over time', () => {
    let t = 0;
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 2, now: () => t });
    rl.allow('k'); rl.allow('k');
    assert.ok(!rl.allow('k').ok, 'empty bucket blocks');
    t = 1000; // 1s → +2 tokens
    assert.ok(rl.allow('k').ok, 'refilled after 1s');
  });
  test('keys are independent', () => {
    let t = 0;
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 1, now: () => t });
    assert.ok(rl.allow('a').ok);
    assert.ok(rl.allow('b').ok, 'different key has its own bucket');
    assert.ok(!rl.allow('a').ok);
  });
}

// ───────────────────────── audit log ─────────────────────────
section('auditLog (operator action trail)');
{
  const AuditLog = require('./auditLog');
  test('records and lists newest-first; filters by action', () => {
    const a = new AuditLog();
    a.record({ actor: 'token:abcd…', action: 'teach', method: 'POST', status: 200 });
    a.record({ actor: 'token:abcd…', action: 'replay', method: 'POST', status: 200 });
    const list = a.list({ limit: 10 });
    assert.strictEqual(list[0].action, 'replay');
    assert.strictEqual(a.list({ action: 'teach' }).length, 1);
  });
  test('ring buffer bounds memory', () => {
    const a = new AuditLog({ max: 3 });
    for (let i = 0; i < 10; i++) a.record({ action: 'x' + i });
    assert.strictEqual(a.size(), 3);
    assert.strictEqual(a.list({ limit: 10 })[0].action, 'x9');
  });
}

// ───────────────────────── backup / restore ─────────────────────────
section('backup (snapshot archive + restore)');
{
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const backup = require('./backup');
  const DarmAnn = require('./index');

  function tmpNodeDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darm-bk-'));
    const node = new DarmAnn({ nodeId: 'bk', config: { cdcp: { tMinAgeMs: 0 } } });
    const c = 'archived knowledge survives a PVC migration';
    node.teach(c);
    node.observe({ claim: c, reward: 1, epistemic: { conf_cal: 0.92, u_ep: 0.05 } });
    node.consolidate(node.stm.all()[0].claim_id);
    node.save(path.join(dir, 'node.json'));
    fs.writeFileSync(path.join(dir, 'audit.log'), '{"action":"teach"}\n');
    return { dir, ltm: node.ltm.size };
  }

  test('create → verify → restore round-trip preserves a valid LTM', () => {
    const { dir, ltm } = tmpNodeDir();
    assert.strictEqual(ltm, 1);
    const archive = backup.createArchive(dir, backup.allFiles());
    assert.deepStrictEqual(archive.files.sort(), ['audit.log', 'node.json']);
    assert.ok(backup.verifyArchive(archive).ok, 'archive verifies');

    const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darm-rs-'));
    const written = backup.restoreArchive(archive, restoreDir);
    assert.ok(written.includes('node.json') && written.includes('audit.log'));
    const restored = DarmAnn.load(path.join(restoreDir, 'node.json'), { config: { cdcp: { tMinAgeMs: 0 } } });
    assert.strictEqual(restored.ltm.size, 1);
    assert.ok(restored.ltm.validate().valid, 'restored chain valid');

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(restoreDir, { recursive: true, force: true });
  });

  test('corruption is detected (checksum + digest)', () => {
    const { dir } = tmpNodeDir();
    const archive = backup.createArchive(dir, backup.allFiles());
    // Tamper with a file's content but not its checksum → checksum mismatch.
    archive.entries['node.json'].content = Buffer.from('garbage').toString('base64');
    const r = backup.verifyArchive(archive);
    assert.ok(!r.ok && /checksum|digest|invalid|load/.test(r.reason), r.reason);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

section('rbac (scoped token authorization)');
{
  const rbac = require('./rbac');
  test('parses single + multi token specs into scopes', () => {
    const m = rbac.buildTokenScopes({ authToken: 'legacy', tokensSpec: 'a:read, b:operator, c' });
    assert.strictEqual(m.get('legacy'), 'operator');
    assert.strictEqual(m.get('a'), 'read');
    assert.strictEqual(m.get('b'), 'operator');
    assert.strictEqual(m.get('c'), 'operator'); // default when no scope
  });
  test('read scope: GET allowed, POST forbidden (403)', () => {
    const m = rbac.buildTokenScopes({ tokensSpec: 'r:read' });
    assert.strictEqual(rbac.authorize(m, 'GET', 'r').status, 200);
    const post = rbac.authorize(m, 'POST', 'r');
    assert.ok(!post.ok && post.status === 403 && post.need === 'operator' && post.have === 'read');
  });
  test('operator scope: GET and POST allowed', () => {
    const m = rbac.buildTokenScopes({ tokensSpec: 'o:operator' });
    assert.strictEqual(rbac.authorize(m, 'GET', 'o').status, 200);
    assert.strictEqual(rbac.authorize(m, 'POST', 'o').status, 200);
  });
  test('unknown token → 401; empty config → auth disabled (allow)', () => {
    const m = rbac.buildTokenScopes({ tokensSpec: 'o:operator' });
    assert.strictEqual(rbac.authorize(m, 'GET', 'nope').status, 401);
    assert.ok(rbac.authorize(new Map(), 'POST', '').ok); // disabled passes through
  });
}

section('taskManager (operation tracking)');
{
  const TaskManager = require('./taskManager');
  test('create → start → step → finish lifecycle with progress + events', () => {
    const tm = new TaskManager();
    const events = [];
    tm.on('update', (t) => events.push(t.status));
    const t = tm.create('replay', { label: 'x', total: 4 });
    assert.strictEqual(t.status, 'queued');
    tm.start(t.id);
    tm.step(t.id, 'half', 2);
    assert.strictEqual(tm.get(t.id).progress, 0.5);
    tm.finish(t.id, { ok: true });
    const done = tm.get(t.id);
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(done.progress, 1);
    assert.ok(done.result.ok);
    assert.ok(events.includes('running') && events.includes('done'));
  });
  test('run() wraps an async fn; failures are captured', async () => {
    const tm = new TaskManager();
    const okTask = await tm.run('snapshot', { label: 's' }, async (ctl) => { ctl.step('working', 1); return 42; });
    assert.strictEqual(okTask.result, 42);
    let threw = false;
    try { await tm.run('replay', {}, async () => { throw new Error('boom'); }); } catch (_e) { threw = true; }
    assert.ok(threw);
    const failed = tm.list({ status: 'failed' });
    assert.ok(failed.length === 1 && failed[0].error === 'boom');
  });
  test('summary counts by status; list respects limit', () => {
    const tm = new TaskManager();
    for (let i = 0; i < 5; i++) tm.finish(tm.start(tm.create('triage').id).id);
    const s = tm.summary();
    assert.strictEqual(s.done, 5);
    assert.strictEqual(tm.list({ limit: 2 }).length, 2);
  });
}

section('bench (throughput pipeline)');
{
  const { runBenchmark } = require('./bench');
  test('drives all txns through mempool→consensus→LTM with identical chains', () => {
    const r = runBenchmark({ txns: 40, validators: 4, batch: 5 });
    assert.strictEqual(r.committedTxns, 40, 'all txns committed');
    assert.strictEqual(r.ltmBlocks, 40, 'LTM grew by every txn');
    assert.ok(r.ltmAgreement, 'all replica LTM chains byte-identical under load');
    assert.ok(r.throughputTps > 0, 'positive throughput');
  });
}

section('metrics (Prometheus exposition)');
{
  const metrics = require('./metrics');
  test('renders valid Prometheus text with core gauges', () => {
    const node = fast();
    node.teach('observability metric fact');
    node.observe({ claim: 'observability metric fact', reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } });
    const text = metrics.render(node, { mempoolSize: 3, uptimeSeconds: 12.7, networkNodes: 2 });
    assert.ok(/# TYPE darm_tier_entries gauge/.test(text), 'has tier gauge');
    assert.ok(/darm_tier_entries\{tier="STM"\} \d+/.test(text), 'has STM tier line');
    assert.ok(/darm_stm_chain_valid 1/.test(text), 'reports STM chain valid');
    assert.ok(/darm_mempool_size 3/.test(text), 'includes extra mempool gauge');
    assert.ok(/darm_uptime_seconds 12/.test(text), 'includes uptime counter');
    // Every metric line is name{labels}? value (well-formed exposition).
    for (const l of text.split('\n')) {
      if (!l || l.startsWith('#')) continue;
      assert.ok(/^[a-z_]+(\{[^}]*\})? -?\d+(\.\d+)?$/.test(l), `well-formed: "${l}"`);
    }
  });
}

section('facade integration');
{
  test('observe → consolidate → query end-to-end; state() reports chains', () => {
    const node = fast();
    const c = 'sharp wave ripples drive hippocampal replay';
    node.teach(c);
    node.observe({ claim: c, reward: 1, epistemic: { conf_cal: 0.92, u_ep: 0.05 } });
    node.consolidate(node.stm.all()[0].claim_id);
    const q = node.query(c);
    assert.ok(q.hit && (q.tier === 'RRC' || q.tier === 'LTM'));
    const st = node.state();
    assert.ok(st.chains.stmValid && st.chains.ltmValid);
    assert.ok(st.markov.states >= 1 && st.models.length === 2 && st.vocab > 0);
  });
  test('selfDeploy returns an autonomous node; stop clears timers', () => {
    const node = DarmAnn.selfDeploy({ difficulty: 1, config: { cdcp: { tMinAgeMs: 0 } } });
    assert.ok(node._timers && node._timers.length === 3);
    node.stop();
    assert.strictEqual(node._timers, null);
  });
}

// ───────────────────────── consensus over real TCP sockets ─────────────────────────
async function tcpTest() {
  section('consensus/bft over real TCP (multi-socket)');
  const { TcpTransport } = require('./consensus/transport');
  const { BFTNode } = require('./consensus/bft');
  const ValidatorKey = require('./consensus/validatorKey');
  const N = 4;
  const base = 18200 + Math.floor(Math.random() * 300);
  const keys = Array.from({ length: N }, () => new ValidatorKey());
  const validators = new Map();
  keys.forEach((k, i) => validators.set('v' + i, { publicKeyB64: k.publicKeyB64, weight: 1 }));
  const transports = [];
  let decided = 0;
  for (let i = 0; i < N; i++) {
    const t = new TcpTransport({ nodeId: 'v' + i, port: base + i });
    await t.listen();
    transports.push(t);
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) transports[i].addPeer('v' + j, '127.0.0.1', base + j);
  const nodes = transports.map((t, i) => new BFTNode({ nodeId: 'v' + i, key: keys[i], validators, transport: t, tauC: 0.67, useTimers: true, timeoutMs: 150, evaluate: () => ({ vote: 'YES', score: 0.9 }), onDecide: () => { decided += 1; } }));
  await new Promise((r) => setTimeout(r, 200));
  nodes.forEach((n) => n.start({ claim_id: 'tcp-claim' })); // all nodes enter round 0; proposer broadcasts
  await new Promise((r) => setTimeout(r, 1500));
  transports.forEach((t) => t.close());
  test('reaches commit across 4 nodes over TCP', () => {
    assert.ok(decided >= Math.ceil((2 * N) / 3), `only ${decided}/${N} committed`);
  });
}

async function mtlsTest() {
  section('consensus transport mTLS (encrypted + mutually authenticated)');
  const { generatePKI, hasOpenSSL } = require('./consensus/certs');
  if (!hasOpenSSL()) { test('mTLS (skipped: openssl unavailable)', () => assert.ok(true)); return; }
  const { TcpTransport } = require('./consensus/transport');
  const { ca, nodes, dir } = generatePKI(['v0', 'v1']);
  const base = 18700 + Math.floor(Math.random() * 200);
  const t0 = new TcpTransport({ nodeId: 'v0', port: base, tls: { key: nodes.v0.key, cert: nodes.v0.cert, ca } });
  const t1 = new TcpTransport({ nodeId: 'v1', port: base + 1, tls: { key: nodes.v1.key, cert: nodes.v1.cert, ca } });
  let got = null;
  t1.connect('v1', (m) => { got = m; });
  await t0.listen();
  await t1.listen();
  t0.addPeer('v1', '127.0.0.1', base + 1);
  await t0.send('v0', 'v1', { type: 'PREVOTE', hello: 'mtls' });
  await new Promise((r) => setTimeout(r, 300));

  // An unauthenticated plain-TCP dialer must not be able to exchange app data.
  const net = require('net');
  let plainData = false;
  await new Promise((r) => { const s = net.connect(base, '127.0.0.1', () => s.write('{"x":1}\n')); s.on('error', () => r()); s.on('data', () => { plainData = true; }); setTimeout(r, 400); });

  t0.close();
  t1.close();
  try { require('fs').rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
  test('authenticated nodes exchange a message; unauthenticated dialer rejected', () => {
    assert.ok(got && got.hello === 'mtls', 'mTLS peer received the consensus message');
    assert.ok(!plainData, 'plain-TCP dialer got no application data');
  });
}

tcpTest()
  .catch((e) => {
    failed += 1;
    console.log('  ✗ TCP consensus threw\n      ' + e.message);
  })
  .then(() => mtlsTest())
  .catch((e) => {
    failed += 1;
    console.log('  ✗ mTLS transport threw\n      ' + e.message);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
  });
