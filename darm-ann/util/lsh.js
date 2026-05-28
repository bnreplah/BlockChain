'use strict';

/**
 * Random-hyperplane Locality-Sensitive Hashing (paper §7.1, Proof P43).
 *
 * Implements an (r, cr, p₁, p₂)-sensitive hash family over normalised
 * embeddings using L independent tables, each defined by `bits` random
 * hyperplanes. A query is hashed into one bucket per table; candidates are the
 * union of the matching buckets across all L tables. With L tables and
 * per-table collision probability p₁ ≈ 0.9, recall ≈ 1 − (1 − p₁)^L (P43:
 * 99.9% at L = 3).
 *
 * Hyperplanes are generated from a fixed seed so indexing is fully
 * deterministic and reproducible across nodes (required so independent nodes
 * agree on bucket keys — see RRC sharding, §3.6).
 */

// Mulberry32 — small deterministic PRNG so the index is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class LSHIndex {
  constructor({ dim = 64, tables = 3, bits = 16, seed = 0x5eed } = {}) {
    this.dim = dim;
    this.tables = tables;
    this.bits = bits;
    // hyperplanes[t][b] = Float64Array(dim)
    this.hyperplanes = [];
    for (let t = 0; t < tables; t++) {
      const rand = mulberry32(seed + t * 0x9e3779b9);
      const planes = [];
      for (let b = 0; b < bits; b++) {
        const plane = new Float64Array(dim);
        for (let i = 0; i < dim; i++) plane[i] = rand() * 2 - 1; // U(-1,1)
        planes.push(plane);
      }
      this.hyperplanes.push(planes);
    }
    // buckets[t] : Map<bucketKey, Set<id>>
    this.buckets = Array.from({ length: tables }, () => new Map());
    // id -> { embedding, payload }
    this.entries = new Map();
  }

  _bucketKey(t, embedding) {
    const planes = this.hyperplanes[t];
    let key = '';
    for (let b = 0; b < this.bits; b++) {
      const plane = planes[b];
      let dot = 0;
      for (let i = 0; i < this.dim; i++) dot += plane[i] * embedding[i];
      key += dot >= 0 ? '1' : '0';
    }
    return key;
  }

  insert(id, embedding, payload) {
    this.entries.set(id, { embedding, payload });
    for (let t = 0; t < this.tables; t++) {
      const key = this._bucketKey(t, embedding);
      let set = this.buckets[t].get(key);
      if (!set) {
        set = new Set();
        this.buckets[t].set(key, set);
      }
      set.add(id);
    }
  }

  remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    for (let t = 0; t < this.tables; t++) {
      const key = this._bucketKey(t, entry.embedding);
      const set = this.buckets[t].get(key);
      if (set) {
        set.delete(id);
        if (set.size === 0) this.buckets[t].delete(key);
      }
    }
    this.entries.delete(id);
    return true;
  }

  has(id) {
    return this.entries.has(id);
  }

  get size() {
    return this.entries.size;
  }

  /** Union of candidate ids across all L tables for the query embedding. */
  candidates(embedding) {
    const ids = new Set();
    for (let t = 0; t < this.tables; t++) {
      const key = this._bucketKey(t, embedding);
      const set = this.buckets[t].get(key);
      if (set) for (const id of set) ids.add(id);
    }
    return ids;
  }

  /** Iterate stored entries (for capacity management / eviction scans). */
  *all() {
    for (const [id, entry] of this.entries) yield { id, ...entry };
  }
}

module.exports = { LSHIndex, mulberry32 };
