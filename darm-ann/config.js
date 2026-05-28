'use strict';

/**
 * DARM-ANN v6.0 — Default configuration.
 *
 * Every constant here is sourced directly from the DARM-ANN v6.0 working
 * white paper (Cybopsec Research, April 2026). Section references in comments
 * point back to the paper so the implementation stays auditable against spec.
 *
 * All values are overridable: `new DarmAnn({ config: { ... } })` deep-merges
 * over these defaults, so the module can be tuned per deployment without
 * editing source (see Open Problems OP-22/OP-23 in §14).
 */

const HOUR_MS = 60 * 60 * 1000;

const DEFAULT_CONFIG = {
  // ── Embeddings (TinyLM stand-in, §3.2) ──────────────────────────────────
  // Paper uses d = 384 for TinyLM. We default lower to stay light; the
  // embedding is a deterministic hashing-trick stand-in (util/embedding.js).
  embeddingDim: 64,

  // ── Episodic Buffer (EB, §3.3) ──────────────────────────────────────────
  eb: {
    ringCapacity: 64, // R — traces per agent
  },

  // ── Short-Term Memory (STM, §3.4) ───────────────────────────────────────
  stm: {
    capacity: 10000, // entries per node
    ttlMs: 24 * HOUR_MS, // TTL_STM (24h default)
    thetaDedup: 0.92, // cosine threshold for merge_reinforce (§4.3 Gate 3)
  },

  // ── Salience scoring (§4.2) ─────────────────────────────────────────────
  salience: {
    wNov: 0.30, // w_nov — novelty
    wRew: 0.35, // w_rew — RLRF reward utility
    wFreq: 0.25, // w_freq — access frequency / recurrence
    wConf: 0.10, // w_conf — calibrated confidence
    thetaSalience: 0.35, // encoding threshold (EB → STM)
    highSalience: 0.70, // priority-queue threshold for early nomination
  },

  // ── ESE confidence gate (inherited from v5.0; used at EB→STM, §4.3) ──────
  ese: {
    thetaConf: 0.60, // θ_conf — minimum calibrated confidence
    thetaU: 0.30, // θ_u — maximum tolerated epistemic uncertainty
  },

  // ── GTE quick check (§4.3 Gate 2) ───────────────────────────────────────
  gte: {
    thetaConflict: 0.50, // BFS conflict_score above which a claim is contradicted
    bfsK1: 1, // k for the lightweight STM-persist check
    bfsK2: 2, // k for full CDCP-vote validation
  },

  // ── CDCP — Consensus-Driven Consolidation Protocol (§5) ─────────────────
  cdcp: {
    tauC: 0.67, // τ_c — quorum threshold (P46: 2/3 minimum for BFT)
    thetaVote: 0.60, // θ_vote — per-node YES threshold
    thetaNominate: 0.55, // θ_nominate — salience floor for nomination
    tMinAgeMs: 60 * 1000, // t_min_age — minimum STM entry age (60s)
    gkThreshold: 1000, // G_K_threshold — blocks for full VoteWeight (§5.7)
    bvasGate: 0.60, // V_BVAS minimum to commit (§5.4)
    maxRetries: 3, // re-nomination attempts before abandonment
    // Per-node vote-score component weights (Algorithm 13)
    voteWeights: { bfs: 0.40, grounded: 0.35, consistency: 0.15, certainty: 0.10 },
  },

  // ── Retrograde protection (§8.3) ────────────────────────────────────────
  retrograde: {
    kappa: 1.2, // incumbency factor
    thetaResolutionVotes: 10, // votes required to trigger resolution
  },

  // ── Decay / lifecycle (§8.1) ────────────────────────────────────────────
  decay: {
    lambdaPerHour: 0.10, // λ_decay default (half-life ≈ 6.93h)
    lambdaHighPerHour: 0.01, // λ_decay for high-salience (half-life ≈ 69.3h)
    thetaExpire: 0.05, // θ_expire — STM expiry floor
    thetaDecay: 0.05, // θ_decay — RCE replay expiry floor
    triageIntervalMs: 30 * 60 * 1000, // 30 min
  },

  // ── Rapid Retrieval Cache (RRC, §7) ─────────────────────────────────────
  rrc: {
    capacity: 10000, // K — top-K hot LTM entries
    lshTables: 3, // L — independent hash tables (P43 recall = 99.9%)
    lshBits: 16, // hyperplanes per table → bucket key width
    simThreshold: 0.85, // minimum cosine similarity for an RRC_HIT (§7.2)
    thetaRrcDecay: 0.05, // staleness floor for eviction (§6.2 phase 4)
  },

  // ── Replay and Consolidation Engine (RCE, §6) ───────────────────────────
  rce: {
    cycleBudgetMs: 500, // wall-clock budget per cycle
    sampleStm: 50, // n new STM candidates per cycle
    sampleLtm: 20, // n old LTM samples interleaved (ratio 50:20, r=0.4)
    reinforceFactor: 1.10, // salience *= 1.10 on successful re-validation
    decayFactor: 0.85, // salience *= 0.85 on failed re-validation
    minIntervalMs: 5 * 60 * 1000, // ≤ 1 cycle / 5 min / node
    bfsReinforceScore: 0.70, // BFS score above which an entry is reinforced
  },

  // ── RLRF v6 memory-efficiency reward component (§9.3) ───────────────────
  rlrf: {
    wMemory: 0.10, // w_m
    rrcHitBonus: 0.30,
    consolidationBonus: 0.50,
    reprocessingPenalty: -0.20,
    stmPollutionPenalty: -0.10,
  },
};

module.exports = { DEFAULT_CONFIG, HOUR_MS };
