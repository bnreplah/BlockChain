'use strict';

const { DEFAULT_CONFIG } = require('./config');
const { cosineSimilarity } = require('./util/embedding');

const Embedder = require('./nn/embedder');
const EpisodicBuffer = require('./memory/episodicBuffer');
const ShortTermMemory = require('./memory/shortTermMemory');
const LongTermMemory = require('./memory/longTermMemory');
const RapidRetrievalCache = require('./memory/rapidRetrievalCache');

const GraphTraversalEngine = require('./engine/gte');
const EpistemicSkepticismEngine = require('./engine/ese');
const BVAS = require('./engine/bvas');
const ReplayConsolidationEngine = require('./engine/rce');

const CDCP = require('./consensus/cdcp');
const ValidatorKey = require('./consensus/validatorKey');
const { memoryEncode, stmPersist } = require('./pipeline/memoryFormation');
const { memoryTriage } = require('./pipeline/triage');

const MarkovGraph = require('./markov/markovGraph');
const GraphNavigator = require('./markov/navigator');
const TinyLM = require('./nn/tinyLM');
const NgramLM = require('./nn/ngramLM');
const ModelRegistry = require('./nn/modelRegistry');

const crypto = require('crypto');

/** Deep-merge user config over defaults (one level of nesting is enough here). */
function mergeConfig(base, override) {
  if (!override) return base;
  const out = { ...base };
  for (const key of Object.keys(override)) {
    out[key] =
      override[key] && typeof override[key] === 'object' && !Array.isArray(override[key])
        ? { ...base[key], ...override[key] }
        : override[key];
  }
  return out;
}

const stateId = (text) => 'st:' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * DARM-ANN v6.0 — node facade.
 *
 * Production-ready, fully self-contained, zero external services. Every
 * component is a real implementation built in this repo:
 *   • Embedder        — skip-gram neural embeddings (nn/embedder.js)
 *   • STM / LTM       — hash-linked blockchains (memory/chain.js)
 *   • GTE             — real graph traversal over a knowledge graph
 *   • ESE             — deep-ensemble classifiers + temperature scaling
 *   • BVAS            — real 5-stage validity pipeline w/ Ed25519 verification
 *   • CDCP            — signed BFT consensus rounds (consensus/bft.js)
 *   • Markov graph    — weighted transition graph + link-chain overlay
 *   • TinyLM / SLM    — neural transition scorer + n-gram LM, model registry
 *   • Navigator       — model-directed traversal of the chain graph
 */
class DarmAnn {
  constructor(opts = {}) {
    this.nodeId = opts.nodeId || 'node-0';
    this.cfg = mergeConfig(DEFAULT_CONFIG, opts.config);
    const dim = this.cfg.embeddingDim;

    // ── Shared learned embedder (the ANN producing representations) ─────────
    this.embedder = opts.embedder || new Embedder({ dim, seed: opts.seed || 12345 });

    // ── Memory tiers (STM + LTM are blockchains) ───────────────────────────
    this.ltm = new LongTermMemory({ dim, chain: opts.chain || null, adapter: opts.adapter || null, nodeId: this.nodeId });
    this.stm = new ShortTermMemory({ capacity: this.cfg.stm.capacity, dim });
    this.rrc = new RapidRetrievalCache({ dim, capacity: this.cfg.rrc.capacity, tables: this.cfg.rrc.lshTables, bits: this.cfg.rrc.lshBits, simThreshold: this.cfg.rrc.simThreshold });
    this.episodicBuffers = new Map();

    // ── Validity engines (self node) ───────────────────────────────────────
    this.gte = new GraphTraversalEngine({});
    this.ese = new EpistemicSkepticismEngine({ embedder: this.embedder, dim, seed: 1 });
    this.bvas = new BVAS({ ltm: this.ltm, thetaConf: this.cfg.ese.thetaConf });

    // ── CDCP voters: self + peers, each with a real keypair (signed BFT) ────
    this.self = new CDCP.Validator({ nodeId: this.nodeId, gte: this.gte, ese: this.ese, key: new ValidatorKey() });
    this.peers = this._buildPeers(opts.peers, dim);
    this.cdcp = new CDCP({ self: this.self, peers: this.peers, ltm: this.ltm, rrc: this.rrc, stm: this.stm, bvas: this.bvas, cfg: this.cfg, embedder: this.embedder });

    // ── Replay engine ───────────────────────────────────────────────────────
    this.rce = new ReplayConsolidationEngine({ stm: this.stm, ltm: this.ltm, rrc: this.rrc, gte: this.gte, cdcp: this.cdcp, cfg: this.cfg });

    // ── Markov chain-graph + the SLM/TinyLMs that navigate it ──────────────
    this.markov = new MarkovGraph();
    this.tinyLM = new TinyLM({ embedder: this.embedder, dim, seed: 5 });
    this.ngram = new NgramLM({ n: 2 });
    this.registry = new ModelRegistry();
    this.registry.register('tinyLM-transition', this.tinyLM, { kind: 'tinyLM', tags: ['navigation', 'transition'] });
    this.registry.register('ngram-slm', this.ngram, { kind: 'slm', tags: ['sequence', 'likelihood'] });
    this._stateText = new Map(); // stateId -> text label
    this.navigator = new GraphNavigator({ graph: this.markov, tinyLM: this.tinyLM, labelOf: (id) => this._stateText.get(id) || id });
    this._lastStateId = null;

    this._maxReward = 1;
  }

  _buildPeers(peers, dim) {
    let count = 6;
    let seeds = [];
    if (typeof peers === 'number') count = peers;
    else if (Array.isArray(peers)) {
      count = peers.length;
      seeds = peers;
    }
    const out = [];
    for (let i = 0; i < count; i++) {
      const gte = new GraphTraversalEngine({});
      const ese = new EpistemicSkepticismEngine({ embedder: this.embedder, dim, seed: 100 + i });
      const seed = seeds[i];
      if (seed && Array.isArray(seed.grounded)) seed.grounded.forEach((t) => { gte.addGrounded(t); ese.addExample(t, 1); });
      if (seed && Array.isArray(seed.refuted)) seed.refuted.forEach((t) => { gte.addRefuted(t); ese.addExample(t, 0); });
      out.push(new CDCP.Validator({ nodeId: `${this.nodeId}-peer-${i}`, gte, ese, key: new ValidatorKey() }));
    }
    return out;
  }

  embedText(text) {
    return this.embedder.embed(text);
  }

  // ── Knowledge seeding across the whole cluster (G_K + ESE corpus) ─────────
  teach(text) {
    this.embedder.observe(text);
    for (const v of this.cdcp.voters) {
      v.gte.addGrounded(text);
      v.ese.addExample(text, 1);
    }
    this.ngram.train(text);
    return this;
  }

  refute(text) {
    this.embedder.observe(text);
    for (const v of this.cdcp.voters) {
      v.gte.addRefuted(text);
      v.ese.addExample(text, 0);
    }
    return this;
  }

  _eb(agentId) {
    if (!this.episodicBuffers.has(agentId)) {
      this.episodicBuffers.set(agentId, new EpisodicBuffer({ capacity: this.cfg.eb.ringCapacity }));
    }
    return this.episodicBuffers.get(agentId);
  }

  _accessFreq(embedding) {
    const similar = this.stm.retrieveSimilar(embedding, 5).filter((s) => s.similarity > 0.5);
    return Math.min(1, similar.length / 5);
  }

  /** Record a claim into the Markov chain-graph + train the navigating models. */
  _updateChainGraph(text) {
    const id = stateId(text);
    this._stateText.set(id, text);
    this.markov.visit(id, text);
    this.ngram.train(text);
    if (this._lastStateId && this._lastStateId !== id) {
      this.tinyLM.observeTransition(this._stateText.get(this._lastStateId), text);
    }
    this._lastStateId = id;
    return id;
  }

  /** observe — ingest a completed inference (WM → EB → STM). */
  observe(obs = {}) {
    const agentId = obs.agentId || 'agent-0';
    const eb = this._eb(agentId);
    const reward = obs.reward != null ? obs.reward : 0.5;
    this._maxReward = Math.max(this._maxReward, reward);
    const text = obs.output || obs.claim || (Array.isArray(obs.claims) ? obs.claims[0] : '');
    if (text) this.embedder.observe(text);
    const epistemic = obs.epistemic || (this.ese.examples.length ? this.ese.assess(text) : { conf_cal: 0.8, u_ep: 0.1 });
    const cot = obs.cot || { trace_id: `t-${Date.now()}`, claims: obs.claims, claim: obs.claim };

    const enc = memoryEncode(
      { cot, output: obs.output || obs.claim, reward, epistemic },
      { eb, stm: this.stm, cfg: this.cfg, embedder: this.embedder, maxReward: this._maxReward, accessFreq: (e) => this._accessFreq(e) }
    );

    const persisted = [];
    for (const ebEntry of enc.created) {
      const res = stmPersist(ebEntry, { stm: this.stm, gte: this.gte, cfg: this.cfg, nodeId: this.nodeId });
      persisted.push(res);
    }
    if (text) this._updateChainGraph(text);
    return { encoded: enc.encoded, persisted };
  }

  /** query — retrieve via the memory hierarchy (RRC → STM → LTM → MISS). */
  query(text) {
    const embedding = this.embedder.embed(text);
    const rrc = this.rrc.query(embedding);
    if (rrc) return { tier: 'RRC', hit: true, ...rrc };

    const stmHit = this.stm.nearestNeighbor(embedding);
    if (stmHit && stmHit.similarity >= this.cfg.rrc.simThreshold) {
      return { tier: 'STM', hit: true, result: stmHit.entry.claim_text, confidence: stmHit.entry.confidence, similarity: stmHit.similarity };
    }

    const ltmHit = this.ltm.query(embedding, this.cfg.rrc.simThreshold);
    if (ltmHit) {
      if (ltmHit.block.confidence >= this.cfg.ese.thetaConf) this.rrc.indexBlock(ltmHit.block);
      return { tier: 'LTM', hit: true, result: ltmHit.block.claim_text, confidence: ltmHit.block.confidence, similarity: ltmHit.similarity, source: ltmHit.block.hash };
    }
    return { tier: 'MISS', hit: false };
  }

  /** Navigate the chain graph from a starting claim, model-directed. */
  navigate(startText, steps = 8) {
    const start = stateId(startText);
    if (!this._stateText.has(start)) this._stateText.set(start, startText);
    const { path, trace } = this.navigator.navigate(start, steps);
    return { path: path.map((id) => this._stateText.get(id) || id), trace };
  }

  replay(opts) {
    return this.rce.cycle(opts);
  }

  triage(opts = {}) {
    return memoryTriage({ stm: this.stm, cdcp: this.cdcp, cfg: this.cfg, now: opts.now });
  }

  consolidate(claimId) {
    const entry = this.stm.get(claimId);
    if (!entry) return { status: 'NOT_FOUND' };
    return this.cdcp.runConsensus(entry);
  }

  morph(adapter) {
    this.ltm.morph(adapter);
    return this;
  }

  /**
   * Self-correcting maintenance pass. Detects and repairs inconsistencies:
   *   • repairs the STM and LTM blockchains if any hash link is broken
   *   • prunes expired STM entries (TTL)
   *   • supersedes LTM entries now contradicted by the knowledge graph
   *   • retrains ESE on the current corpus (recalibration)
   */
  selfCorrect({ now = Date.now() } = {}) {
    const report = { stmRepaired: 0, ltmRepaired: 0, stmPruned: 0, superseded: 0, eseRetrained: false };

    const stmStatus = this.stm.validateChain();
    if (!stmStatus.valid) report.stmRepaired = this.stm.repairChain();

    const ltmStatus = this.ltm.validate();
    if (!ltmStatus.valid) report.ltmRepaired = this.ltm.repairLinks();

    report.stmPruned = this.stm.pruneExpired(now);

    // Contradiction-driven self-correction: if a committed claim is now refuted
    // by the self node's knowledge graph, supersede it (retrograde protection).
    for (const block of this.ltm.blocks) {
      if (block.superseded) continue;
      const bfs = this.gte.bfsValidate(block.claim_text, block.embedding, this.cfg.gte.bfsK2);
      // Supersede when contradiction outweighs support (a single refuter scores
      // ~0.39 by the BFS depth discount, so gate on relative magnitude).
      if (bfs.conflict_score > 0.2 && bfs.conflict_score > bfs.score) {
        this.ltm.markSuperseded(block.hash, null);
        this.rrc.invalidate(block.hash);
        report.superseded += 1;
      }
    }

    if (this.ese.dirty) {
      this.ese.trainIfDirty();
      report.eseRetrained = true;
    }
    return report;
  }

  autorun({ replayMs = 5 * 60 * 1000, triageMs = 30 * 60 * 1000, correctMs = 15 * 60 * 1000 } = {}) {
    this.stop();
    this._timers = [];
    this._timers.push(setInterval(() => this.replay(), replayMs));
    this._timers.push(setInterval(() => this.triage(), triageMs));
    this._timers.push(setInterval(() => this.selfCorrect(), correctMs));
    for (const t of this._timers) if (t.unref) t.unref();
    return this;
  }

  stop() {
    if (this._timers) for (const t of this._timers) clearInterval(t);
    this._timers = null;
    return this;
  }

  state() {
    return {
      nodeId: this.nodeId,
      ltmMode: this.ltm.mode,
      tiers: {
        EB: [...this.episodicBuffers.values()].reduce((s, b) => s + b.size, 0),
        STM: this.stm.size,
        LTM: this.ltm.size,
        RRC: this.rrc.size,
      },
      chains: { stmHeight: this.stm.chain.height, stmValid: this.stm.validateChain().valid, ltmValid: this.ltm.validate().valid },
      associativeGraph: this.ltm.graphStats(),
      markov: this.markov.stats(),
      models: this.registry.list(),
      cluster: { voters: this.cdcp.voters.length, tauC: this.cfg.cdcp.tauC },
      rrcHitRate: this.rrc.hitRate(),
      vocab: this.embedder.vocabSize(),
    };
  }

  static selfDeploy(opts = {}) {
    const { powAdapter } = require('./network/chainAdapter');
    const node = new DarmAnn({
      nodeId: opts.nodeId || 'autonomous-node',
      config: opts.config,
      adapter: opts.adapter || powAdapter({ difficulty: opts.difficulty != null ? opts.difficulty : 3 }),
    });
    if (opts.autorun !== false) node.autorun(opts.schedule || {});
    return node;
  }
}

DarmAnn.cosineSimilarity = cosineSimilarity;
DarmAnn.CDCP = CDCP;
DarmAnn.Embedder = Embedder;
DarmAnn.MarkovGraph = MarkovGraph;
DarmAnn.TinyLM = TinyLM;
DarmAnn.NgramLM = NgramLM;
DarmAnn.DEFAULT_CONFIG = DEFAULT_CONFIG;
module.exports = DarmAnn;

// Network layer attached after export to avoid a require cycle with swarm.js.
DarmAnn.Swarm = require('./network/swarm');
DarmAnn.adapters = require('./network/chainAdapter');
