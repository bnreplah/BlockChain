'use strict';

/**
 * Blockchain Validity Algorithm Suite (BVAS) — inherited from v5.0 (§4).
 *
 * The full BVAS is a five-stage validity pipeline. At CDCP promotion time only
 * Stages 4–5 are re-evaluated (§9.2), because Stages 1–3 were already cleared
 * during STM_Persist:
 *   Stage 4 — temporal consistency against current LTM state
 *   Stage 5 — ESE consolidated confidence from all voting nodes
 *
 * Returns an aggregate validity score V_BVAS ∈ [0,1]; CDCP commits iff
 * V_BVAS ≥ cfg.cdcp.bvasGate (default 0.60, §5.4).
 *
 * SWAP POINT: replace with the real five-stage BVAS; the score contract holds.
 */

class BVAS {
  constructor({ ltm = null } = {}) {
    this.ltm = ltm;
  }

  /** Stages 4–5 re-validation of a candidate LTM block. */
  validate(candidate) {
    // Stage 4 — temporal consistency: penalise if a non-superseded near-duplicate
    // already exists in LTM with materially lower confidence (would regress truth).
    let temporal = 1.0;
    if (this.ltm) {
      const hit = this.ltm.query(candidate.embedding, 0.97);
      if (hit && hit.block.confidence > candidate.confidence + 0.1) {
        temporal = 0.4; // committing would weaken an established stronger fact
      }
    }
    // Stage 5 — consolidated confidence from the voting quorum.
    const consolidated = candidate.confidence;
    const score = 0.5 * temporal + 0.5 * consolidated;
    return Math.min(1, Math.max(0, score));
  }
}

module.exports = BVAS;
