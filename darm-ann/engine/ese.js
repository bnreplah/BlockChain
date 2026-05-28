'use strict';

const { embed } = require('../util/embedding');

/**
 * Epistemic Skepticism Engine (ESE) — inherited from DARM-ANN v5.0 (§5).
 *
 * The full ESE provides calibrated confidence, second-order (epistemic)
 * uncertainty, and adversarial debate. v6.0 uses it (a) as the EB→STM
 * confidence gate and (b) as the per-node epistemic-uncertainty term in the
 * CDCP vote score (Algorithm 13, the `(1 − local_ue)` component).
 *
 * Stand-in behaviour: epistemic uncertainty rises when a claim is poorly
 * grounded in the node's G_K and when it brushes up against a contradiction.
 *
 * SWAP POINT: replace estimateEpistemicUncertainty with the real v5.0 ESE
 * (calibration head + debate) — the [0,1] contract is unchanged.
 */

class EpistemicSkepticismEngine {
  constructor({ dim = 64, gte = null } = {}) {
    this.dim = dim;
    this.gte = gte;
  }

  /** u_ep ∈ [0,1]: higher = more epistemically uncertain. */
  estimateEpistemicUncertainty(embedding, gte = this.gte) {
    if (!gte) return 0.5; // maximally agnostic without a knowledge graph
    const bfs = gte.bfsValidate('', embedding, 2);
    const u = 1 - bfs.score + bfs.conflict_score;
    return Math.min(1, Math.max(0, u));
  }

  embed(text) {
    return embed(text, this.dim);
  }
}

module.exports = EpistemicSkepticismEngine;
