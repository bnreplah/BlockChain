'use strict';

const { LSHIndex } = require('../util/lsh');
const { cosineSimilarity } = require('../util/embedding');
const Chain = require('./chain');

/**
 * Tier 2 — Short-Term Memory (STM), paper §3.4.
 *
 * Node-local store of salient, ESE-validated claims that have NOT yet achieved
 * multi-node consensus. TTL-managed, decay-scored, deduplication-aware. This is
 * the staging area that solves the "Commitment Problem" (§1): claims live here
 * and accumulate evidence before CDCP promotes them to the blockchain (LTM).
 *
 * SWAP POINT: the paper specifies Redis (sub-ms KV, native TTL, sorted sets,
 * pub/sub). We use an in-process Map + LSH index, which provides the same
 * O(1)-by-id, O(1)-avg-by-embedding access and explicit TTL via expires_at.
 * Replace this class with a Redis-backed adapter for multi-process deployment.
 *
 * CDCP entry states (§5.1): PENDING | VOTING | CONSENSUS | REJECTED | EXPIRED.
 */

const STATE = Object.freeze({
  PENDING: 'PENDING',
  VOTING: 'VOTING',
  CONSENSUS: 'CONSENSUS',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
});

class ShortTermMemory {
  constructor({ capacity = 10000, dim = 64 } = {}) {
    this.capacity = capacity;
    this.byId = new Map(); // claim_id -> entry
    this.index = new LSHIndex({ dim, tables: 3, bits: 16, seed: 0x57a2 });
    // Short-term memory blockchain: an append-only, hash-linked, tamper-evident
    // log of every STM commitment (the "short-term memory blockchain").
    this.chain = new Chain({ name: 'stm', difficulty: 0 });
  }

  get size() {
    return this.byId.size;
  }

  has(claimId) {
    return this.byId.has(claimId);
  }

  get(claimId) {
    return this.byId.get(claimId);
  }

  insert(entry) {
    this.byId.set(entry.claim_id, entry);
    this.index.insert(entry.claim_id, entry.embedding, null);
    // Commit to the short-term blockchain (tamper-evident ordered record).
    this.chain.append({ claim_id: entry.claim_id, claim_text: entry.claim_text, created_at: entry.created_at, expires_at: entry.expires_at });
    return entry;
  }

  /** Validate the short-term blockchain (self-diagnosis). */
  validateChain() {
    return this.chain.validate();
  }

  /** Self-correct the short-term blockchain by rebuilding broken links. */
  repairChain() {
    return this.chain.repair();
  }

  /** TTL self-maintenance: drop expired entries from the active store + chain. */
  pruneExpired(now = Date.now()) {
    let removed = 0;
    for (const e of this.all()) {
      if (e.expires_at && e.expires_at <= now && !e.promoted) {
        this.expire(e.claim_id);
        removed += 1;
      }
    }
    this.chain.prune((p) => p.expires_at && p.expires_at <= now);
    return removed;
  }

  /** Nearest neighbour by cosine similarity over the LSH candidate set. */
  nearestNeighbor(embedding) {
    let best = null;
    let bestSim = -Infinity;
    for (const id of this.index.candidates(embedding)) {
      const e = this.byId.get(id);
      if (!e) continue;
      const sim = cosineSimilarity(embedding, e.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        best = e;
      }
    }
    return best ? { entry: best, similarity: bestSim } : null;
  }

  /** Top-k similar entries (used by CDCP voters, §5.3). */
  retrieveSimilar(embedding, k = 5) {
    const scored = [];
    for (const id of this.index.candidates(embedding)) {
      const e = this.byId.get(id);
      if (!e) continue;
      scored.push({ entry: e, similarity: cosineSimilarity(embedding, e.embedding) });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, k);
  }

  /** §4.3 — reinforce an existing entry instead of duplicating it. */
  mergeReinforce(existing, ebEntry) {
    existing.salience = Math.min(1, Math.max(existing.salience, ebEntry.salience) + 0.02);
    existing.confidence = Math.max(existing.confidence, ebEntry.epistemic.conf_cal);
    if (ebEntry.source) existing.source_traces.push(ebEntry.source);
    existing.reinforced = (existing.reinforced || 0) + 1;
    return existing;
  }

  markPromoted(claimId) {
    const e = this.byId.get(claimId);
    if (e) {
      e.promoted = true;
      e.state = STATE.CONSENSUS;
    }
  }

  expire(entryOrId) {
    const id = typeof entryOrId === 'string' ? entryOrId : entryOrId.claim_id;
    const e = this.byId.get(id);
    if (e) e.state = STATE.EXPIRED;
    this.index.remove(id);
    return this.byId.delete(id);
  }

  archive(entry) {
    // Promoted entries are removed from the hot STM store (kept in LTM).
    this.expire(entry.claim_id);
  }

  all() {
    return [...this.byId.values()];
  }

  /** Salience-biased sample for RCE replay (§6.2 phase 1). */
  sampleBySalience(n = 50, bias = 'high_salience') {
    const sorted = this.all().sort((a, b) =>
      bias === 'high_salience' ? b.salience - a.salience : a.salience - b.salience
    );
    return sorted.slice(0, n);
  }

  /** Decay-ordered eviction to enforce hard capacity (§8.2 / Algorithm 17). */
  evictOverflow(scoreFn) {
    if (this.size <= this.capacity) return [];
    const overflow = this.size - this.capacity;
    const sorted = this.all().sort((a, b) => scoreFn(a) - scoreFn(b)); // ascending
    const toEvict = sorted.slice(0, overflow);
    for (const e of toEvict) this.expire(e.claim_id);
    return toEvict;
  }
}

ShortTermMemory.STATE = STATE;
module.exports = ShortTermMemory;
