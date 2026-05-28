'use strict';

const { DEFAULT_CONFIG } = require('./config');
const { embed, cosineSimilarity } = require('./util/embedding');

const WorkingMemory = require('./memory/workingMemory');
const EpisodicBuffer = require('./memory/episodicBuffer');
const ShortTermMemory = require('./memory/shortTermMemory');
const LongTermMemory = require('./memory/longTermMemory');
const RapidRetrievalCache = require('./memory/rapidRetrievalCache');

const GraphTraversalEngine = require('./engine/gte');
const EpistemicSkepticismEngine = require('./engine/ese');
const BVAS = require('./engine/bvas');
const ReplayConsolidationEngine = require('./engine/rce');

const CDCP = require('./consensus/cdcp');
const { memoryEncode, stmPersist } = require('./pipeline/memoryFormation');
const { memoryTriage } = require('./pipeline/triage');

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

/**
 * DARM-ANN v6.0 — node facade.
 *
 * Wires the five-tier memory hierarchy (WM → EB → STM → LTM → RRC) together
 * with the GTE, ESE, BVAS, CDCP, and RCE, and exposes the end-to-end memory
 * flow of §9.4 / §11:
 *
 *   observe(...)  →  encode to EB  →  persist to STM
 *   query(...)    →  RRC → STM → LTM → MISS   (short-circuits at first hit)
 *   replay()      →  RCE cycle (nominates survivors to CDCP → LTM commit)
 *   triage()      →  STM lifecycle management
 *
 * Fully self-contained: no Redis, no external LLM, no external consensus
 * service. An optional repo Blockchain instance can be bridged in as the LTM
 * substrate so the existing PoW chain literally *is* the long-term memory.
 */
class DarmAnn {
  constructor(opts = {}) {
    this.nodeId = opts.nodeId || 'node-0';
    this.cfg = mergeConfig(DEFAULT_CONFIG, opts.config);
    const dim = this.cfg.embeddingDim;

    // ── Memory tiers ──────────────────────────────────────────────────────
    this.ltm = new LongTermMemory({
      dim,
      chain: opts.chain || null,
      adapter: opts.adapter || null, // poly-chain morphism substrate
      nodeId: this.nodeId,
    });
    this.stm = new ShortTermMemory({ capacity: this.cfg.stm.capacity, dim });
    this.rrc = new RapidRetrievalCache({
      dim,
      capacity: this.cfg.rrc.capacity,
      tables: this.cfg.rrc.lshTables,
      bits: this.cfg.rrc.lshBits,
      simThreshold: this.cfg.rrc.simThreshold,
    });
    this.episodicBuffers = new Map(); // agentId -> EpisodicBuffer

    // ── Reasoning / validity engines (self node) ──────────────────────────
    this.gte = new GraphTraversalEngine({ dim, ltm: this.ltm });
    this.ese = new EpistemicSkepticismEngine({ dim, gte: this.gte });
    this.bvas = new BVAS({ ltm: this.ltm });

    // ── CDCP voters: self + synthetic peers (self-contained quorum) ───────
    this.self = new CDCP.Validator({ nodeId: this.nodeId, gte: this.gte, ese: this.ese, stm: this.stm });
    this.peers = this._buildPeers(opts.peers, dim);
    this.cdcp = new CDCP({
      self: this.self,
      peers: this.peers,
      ltm: this.ltm,
      rrc: this.rrc,
      stm: this.stm,
      bvas: this.bvas,
      cfg: this.cfg,
    });

    // ── Replay engine ─────────────────────────────────────────────────────
    this.rce = new ReplayConsolidationEngine({
      stm: this.stm,
      ltm: this.ltm,
      rrc: this.rrc,
      gte: this.gte,
      cdcp: this.cdcp,
      cfg: this.cfg,
    });

    this._maxReward = 1;
  }

  /**
   * Build synthetic peer validators so a single process forms a real τ_c
   * quorum. Each peer owns its own GTE over the shared LTM plus an optional
   * private seed set, which lets deployments tune cross-node correlation ρ_GK
   * (Proof P39): more private knowledge → lower ρ_GK → tighter hallucination
   * bound.
   */
  _buildPeers(peers, dim) {
    let count = 6; // default → 7-node cluster (self + 6), matches paper examples
    let seeds = [];
    if (typeof peers === 'number') count = peers;
    else if (Array.isArray(peers)) {
      count = peers.length;
      seeds = peers;
    }
    const out = [];
    for (let i = 0; i < count; i++) {
      const gte = new GraphTraversalEngine({ dim, ltm: this.ltm });
      const seed = seeds[i];
      if (seed && Array.isArray(seed.grounded)) seed.grounded.forEach((t) => gte.addGrounded(t));
      if (seed && Array.isArray(seed.refuted)) seed.refuted.forEach((t) => gte.addRefuted(t));
      const ese = new EpistemicSkepticismEngine({ dim, gte });
      out.push(new CDCP.Validator({ nodeId: `${this.nodeId}-peer-${i}`, gte, ese }));
    }
    return out;
  }

  // ── Knowledge seeding (every validator's G_K) ─────────────────────────────

  /** Teach a grounded fact to the whole cluster (raises support during votes). */
  teach(text) {
    this.gte.addGrounded(text);
    for (const p of this.peers) p.gte.addGrounded(text);
    return this;
  }

  /** Mark a claim as refuted across the cluster (raises conflict during votes). */
  refute(text) {
    this.gte.addRefuted(text);
    for (const p of this.peers) p.gte.addRefuted(text);
    return this;
  }

  _eb(agentId) {
    if (!this.episodicBuffers.has(agentId)) {
      this.episodicBuffers.set(agentId, new EpisodicBuffer({ capacity: this.cfg.eb.ringCapacity }));
    }
    return this.episodicBuffers.get(agentId);
  }

  /** access_frequency proxy (§4.2): how recurrent is this claim in STM? */
  _accessFreq(embedding) {
    const similar = this.stm.retrieveSimilar(embedding, 5).filter((s) => s.similarity > 0.5);
    return Math.min(1, similar.length / 5);
  }

  /**
   * observe — ingest a completed inference (WM → EB → STM).
   * @param {{claim?, claims?, output?, reward?, epistemic?, agentId?, cot?}} obs
   */
  observe(obs = {}) {
    const agentId = obs.agentId || 'agent-0';
    const eb = this._eb(agentId);
    const reward = obs.reward != null ? obs.reward : 0.5;
    this._maxReward = Math.max(this._maxReward, reward);
    const epistemic = obs.epistemic || { conf_cal: 0.8, u_ep: 0.1 };
    const cot = obs.cot || { trace_id: `t-${Date.now()}`, claims: obs.claims, claim: obs.claim };

    const enc = memoryEncode(
      { cot, output: obs.output || obs.claim, reward, epistemic },
      { eb, stm: this.stm, cfg: this.cfg, maxReward: this._maxReward, accessFreq: (e) => this._accessFreq(e) }
    );

    const persisted = [];
    for (const ebEntry of enc.created) {
      const res = stmPersist(ebEntry, {
        stm: this.stm,
        gte: this.gte,
        cfg: this.cfg,
        nodeId: this.nodeId,
      });
      persisted.push(res);
    }
    return { encoded: enc.encoded, persisted };
  }

  /**
   * query — retrieve via the memory hierarchy in priority order (§9.4).
   * Returns { tier, hit, ... }. Short-circuits at the first successful hit.
   */
  query(text) {
    const embedding = embed(text, this.cfg.embeddingDim);

    // 1. RRC (~2ms, pre-computed)
    const rrc = this.rrc.query(embedding);
    if (rrc) return { tier: 'RRC', hit: true, ...rrc };

    // 2. STM (~2ms, node-local)
    const stmHit = this.stm.nearestNeighbor(embedding);
    if (stmHit && stmHit.similarity >= this.cfg.rrc.simThreshold) {
      return {
        tier: 'STM',
        hit: true,
        result: stmHit.entry.claim_text,
        confidence: stmHit.entry.confidence,
        similarity: stmHit.similarity,
      };
    }

    // 3. LTM (~5ms, blockchain LSH)
    const ltmHit = this.ltm.query(embedding, this.cfg.rrc.simThreshold);
    if (ltmHit) {
      // back-populate RRC if confidently consolidated (§7.4 query-driven warm-up)
      if (ltmHit.block.confidence >= this.cfg.ese.thetaConf) this.rrc.indexBlock(ltmHit.block);
      return {
        tier: 'LTM',
        hit: true,
        result: ltmHit.block.claim_text,
        confidence: ltmHit.block.confidence,
        similarity: ltmHit.similarity,
        source: ltmHit.block.hash,
      };
    }

    // 4. MISS — caller would fall through to full inference + GTE
    return { tier: 'MISS', hit: false };
  }

  /** Run one RCE replay/consolidation cycle (§6). */
  replay(opts) {
    return this.rce.cycle(opts);
  }

  /** Run STM triage (§8.2). */
  triage(opts = {}) {
    return memoryTriage({ stm: this.stm, cdcp: this.cdcp, cfg: this.cfg, now: opts.now });
  }

  /** Force a consolidation attempt for a specific STM entry (testing / API). */
  consolidate(claimId) {
    const entry = this.stm.get(claimId);
    if (!entry) return { status: 'NOT_FOUND' };
    return this.cdcp.runConsensus(entry);
  }

  /** Morph the LTM substrate at runtime (poly-chain morphism). */
  morph(adapter) {
    this.ltm.morph(adapter);
    return this;
  }

  /**
   * Self-deploying autonomous operation: run RCE replay and STM triage on
   * background timers so the node keeps consolidating and pruning on its own,
   * with zero external schedulers. Fully self-contained. Returns this.
   */
  autorun({ replayMs = 5 * 60 * 1000, triageMs = 30 * 60 * 1000 } = {}) {
    this.stop();
    this._timers = [];
    this._timers.push(setInterval(() => this.replay(), replayMs));
    this._timers.push(setInterval(() => this.triage(), triageMs));
    for (const t of this._timers) if (t.unref) t.unref(); // don't hold the event loop
    return this;
  }

  /** Stop background autorun timers. */
  stop() {
    if (this._timers) for (const t of this._timers) clearInterval(t);
    this._timers = null;
    return this;
  }

  /** Σ(t) snapshot — tier occupancies and key counters (§2 state tuple). */
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
      associativeGraph: this.ltm.graphStats(),
      cluster: { voters: this.cdcp.voters.length, tauC: this.cfg.cdcp.tauC },
      rrcHitRate: this.rrc.hitRate(),
    };
  }

  /**
   * Self-deploy a fully self-contained, autonomously-running node from
   * scratch. No Redis / no external LLM / no external consensus service: an
   * in-process PoW substrate is created by default, background consolidation
   * is started, and the node is returned ready to observe/query.
   */
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

DarmAnn.embed = embed;
DarmAnn.cosineSimilarity = cosineSimilarity;
DarmAnn.CDCP = CDCP;
DarmAnn.DEFAULT_CONFIG = DEFAULT_CONFIG;
module.exports = DarmAnn;

// Network layer attached after export to avoid a require cycle with swarm.js.
DarmAnn.Swarm = require('./network/swarm');
DarmAnn.adapters = require('./network/chainAdapter');
