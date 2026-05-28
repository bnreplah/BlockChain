'use strict';

/**
 * Tier 1 — Episodic Buffer (EB), paper §3.3.
 *
 * A per-agent circular ring buffer holding the last R complete reasoning
 * traces (CoT + output + RLRF reward + epistemic tuple + salience). Lossless,
 * recency-ordered, session-duration. It is the hippocampal rapid-encoding
 * store and the primary source material for STM persistence.
 *
 * Access (paper §3.3): O(1) FIFO push/pop, O(log R) salience-sorted retrieval.
 */

class EpisodicBuffer {
  constructor({ capacity = 64 } = {}) {
    this.capacity = capacity;
    this.entries = []; // ordered oldest → newest
    this._seq = 0;
  }

  /** O(1) push; evicts the oldest trace when full (ring-buffer semantics). */
  push(trace) {
    const entry = {
      traceId: `eb-${this.agentTag || ''}${this._seq++}`,
      claim: trace.claim,
      embed: trace.embed,
      salience: trace.salience,
      source: trace.source,
      reward: trace.reward,
      epistemic: trace.epistemic,
      timestamp: trace.timestamp || Date.now(),
    };
    this.entries.push(entry);
    let evicted = null;
    if (this.entries.length > this.capacity) {
      evicted = this.entries.shift();
    }
    return { entry, evicted };
  }

  /** Embeddings of currently-buffered traces (used for novelty scoring). */
  embeddings() {
    return this.entries.map((e) => e.embed).filter(Boolean);
  }

  /** Top-n traces by salience (the O(log R) salience-sorted retrieval). */
  topBySalience(n = 10) {
    return [...this.entries]
      .sort((a, b) => b.salience - a.salience)
      .slice(0, n);
  }

  get size() {
    return this.entries.length;
  }

  clear() {
    this.entries = [];
  }
}

module.exports = EpisodicBuffer;
