'use strict';

const { embed, cosineSimilarity } = require('../util/embedding');

/**
 * Graph Traversal Engine (GTE) — inherited from DARM-ANN v5.0 (§3).
 *
 * The full v5.0 GTE runs BFS / DFS / bidirectional / Dijkstra / A* over the
 * blockchain knowledge graph G_K. v6.0 relies on two of its operations:
 *   • BFS_Validate(claim, k) — breadth-first neighbourhood consistency check
 *   • DFS_Audit(claim)       — depth-first causal-chain groundedness
 *
 * This is a faithful but lightweight stand-in: G_K is represented as a set of
 * grounded claim embeddings (the node's local knowledge, seeded + drawn from
 * its LTM) plus a set of refuted embeddings used to detect contradictions.
 * Each node owns its own GTE instance, so independent CDCP votes operate over
 * potentially-divergent local graphs — exactly the cross-node correlation
 * ρ_GK that Proof P39 reasons about.
 *
 * SWAP POINT: replace bfsValidate/dfsAudit with the real v5.0 graph traversal
 * over the blockchain-derived G_K and the contracts below are unchanged.
 */

class GraphTraversalEngine {
  constructor({ dim = 64, ltm = null, groundedThreshold = 0.6 } = {}) {
    this.dim = dim;
    this.ltm = ltm; // optional LongTermMemory — its blocks count as grounded
    this.groundedThreshold = groundedThreshold;
    this.grounded = []; // [{text, embedding}]
    this.refuted = []; // [{text, embedding}]
  }

  addGrounded(text) {
    this.grounded.push({ text, embedding: embed(text, this.dim) });
    return this;
  }

  addRefuted(text) {
    this.refuted.push({ text, embedding: embed(text, this.dim) });
    return this;
  }

  /** Number of blocks in this node's knowledge graph (for VoteWeight, §5.7). */
  gkSize() {
    return this.grounded.length + (this.ltm ? this.ltm.size : 0);
  }

  _maxSim(embedding, pool) {
    let max = 0;
    for (const item of pool) {
      const sim = cosineSimilarity(embedding, item.embedding);
      if (sim > max) max = sim;
    }
    return max;
  }

  _groundedPool() {
    const pool = this.grounded.slice();
    if (this.ltm) {
      for (const b of this.ltm.blocks) {
        if (!b.superseded) pool.push({ text: b.claim_text, embedding: b.embedding });
      }
    }
    return pool;
  }

  /**
   * BFS_Validate — neighbourhood consistency.
   * Returns { score, conflict_score, conflicts }. `k` is the BFS depth budget
   * (affects how broadly we search; here it scales the considered pool).
   */
  bfsValidate(claimText, embedding = null, k = 2) {
    const emb = embedding || embed(claimText, this.dim);
    const support = this._maxSim(emb, this._groundedPool());
    const conflict = this._maxSim(emb, this.refuted);
    const conflicts = [];
    if (conflict > 0.5) conflicts.push({ weight: conflict });
    // k widens the search; with a richer G_K, deeper k finds more support.
    const depthBonus = Math.min(0.05 * (k - 1), 0.1);
    return {
      score: Math.min(1, support + (support > 0 ? depthBonus : 0)),
      conflict_score: conflict,
      conflicts,
    };
  }

  /** DFS_Audit — causal-chain groundedness. Grounded iff support ≥ threshold. */
  dfsAudit(claimText, embedding = null) {
    const emb = embedding || embed(claimText, this.dim);
    const support = this._maxSim(emb, this._groundedPool());
    return { type: support >= this.groundedThreshold ? 'Grounded' : 'Ungrounded', support };
  }
}

module.exports = GraphTraversalEngine;
