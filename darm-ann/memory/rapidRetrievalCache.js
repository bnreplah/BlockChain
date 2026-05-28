'use strict';

const { LSHIndex } = require('../util/lsh');
const { cosineSimilarity } = require('../util/embedding');

/**
 * Tier 4 — Rapid Retrieval Cache (RRC), paper §7.
 *
 * A pre-computed, LSH-indexed lookup table mapping query patterns to
 * pre-validated reasoning results. Converts "what did we reason about this?"
 * from a computational problem (re-run the chain) into a lookup problem
 * (O(1) average, P43). Entries are back-populated from CDCP promotions and
 * query-driven warm-up, and invalidated when their source LTM block is
 * superseded (§7.3).
 *
 * Capacity = top-K LTM entries by access_count × decay_score (default K=10k).
 */

class RapidRetrievalCache {
  constructor({ dim = 64, capacity = 10000, tables = 3, bits = 16, simThreshold = 0.85 } = {}) {
    this.dim = dim;
    this.capacity = capacity;
    this.simThreshold = simThreshold;
    this.index = new LSHIndex({ dim, tables, bits, seed: 0x44cc });
    this.bySource = new Map(); // ltm_block_hash -> entry
    this.stats = { hits: 0, misses: 0 };
  }

  get size() {
    return this.index.size;
  }

  /** Build/refresh an RRC entry from a committed LTM block (§5.4 / §6.2). */
  index_(ltmBlock) {
    return this.indexBlock(ltmBlock);
  }

  indexBlock(ltmBlock) {
    if (this.bySource.has(ltmBlock.hash)) return this.bySource.get(ltmBlock.hash);
    const entry = {
      query_fingerprint: ltmBlock.hash,
      ltm_block_hash: ltmBlock.hash,
      embedding: ltmBlock.embedding,
      cached_result: ltmBlock.claim_text,
      reasoning_steps: (ltmBlock.validation && ltmBlock.validation.steps) || [],
      confidence: ltmBlock.confidence,
      access_count: 0,
      last_accessed: Date.now(),
      decay_score: 1.0,
    };
    this.index.insert(ltmBlock.hash, ltmBlock.embedding, entry);
    this.bySource.set(ltmBlock.hash, entry);
    this._enforceCapacity();
    return entry;
  }

  /** Algorithm 16 — RRC Query. Returns an RRC_HIT result or null (RRC_MISS). */
  query(embedding) {
    const ids = this.index.candidates(embedding);
    if (ids.size === 0) {
      this.stats.misses += 1;
      return null;
    }
    let best = null;
    let bestSim = -Infinity;
    for (const id of ids) {
      const stored = this.index.entries.get(id);
      if (!stored) continue;
      const sim = cosineSimilarity(embedding, stored.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        best = stored.payload;
      }
    }
    if (!best || bestSim < this.simThreshold) {
      this.stats.misses += 1;
      return null;
    }
    best.access_count += 1;
    best.last_accessed = Date.now();
    this.stats.hits += 1;
    return {
      result: best.cached_result,
      steps: best.reasoning_steps,
      confidence: best.confidence,
      source: best.ltm_block_hash,
      similarity: bestSim,
    };
  }

  /** §7.3 — invalidate the entry for a superseded LTM block. */
  invalidate(ltmBlockHash) {
    const entry = this.bySource.get(ltmBlockHash);
    if (!entry) return false;
    this.index.remove(ltmBlockHash);
    this.bySource.delete(ltmBlockHash);
    return true;
  }

  /** §6.2 phase 4 — evict entries whose decay score has fallen below floor. */
  evictStale(threshold = 0.05) {
    const now = Date.now();
    let evicted = 0;
    for (const [hash, entry] of [...this.bySource]) {
      // Simple freshness decay: relevance fades with idle time, revived by hits.
      const idleHours = (now - entry.last_accessed) / (60 * 60 * 1000);
      entry.decay_score = Math.exp(-0.05 * idleHours) * (1 + Math.log10(1 + entry.access_count));
      if (entry.decay_score < threshold) {
        this.invalidate(hash);
        evicted += 1;
      }
    }
    return evicted;
  }

  _enforceCapacity() {
    if (this.size <= this.capacity) return;
    // Evict by access_count × decay_score ascending (least valuable first).
    const sorted = [...this.bySource.values()].sort(
      (a, b) => a.access_count * a.decay_score - b.access_count * b.decay_score
    );
    const overflow = this.size - this.capacity;
    for (let i = 0; i < overflow; i++) this.invalidate(sorted[i].ltm_block_hash);
  }

  hitRate() {
    const total = this.stats.hits + this.stats.misses;
    return total === 0 ? 0 : this.stats.hits / total;
  }
}

module.exports = RapidRetrievalCache;
