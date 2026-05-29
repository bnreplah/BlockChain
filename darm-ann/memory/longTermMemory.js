'use strict';

const { LSHIndex } = require('../util/lsh');
const { cosineSimilarity } = require('../util/embedding');
const { sha256 } = require('../util/hash');

/**
 * Tier 3 — Long-Term Blockchain Memory (LTM), paper §3.5.
 *
 * "It is not a log of all agent activity — it is the network's permanent,
 * collectively-validated knowledge store." Only claims that pass CDCP
 * promotion (§5) are written here. Every entry carries full provenance: the
 * epistemic tuple plus the consensus vote record, hash-chained into the block
 * so vote forgery is detectable.
 *
 * Substrate modes:
 *   • bridged   — wraps the repo's PoW Blockchain (structures/Blockchain.js).
 *                 Each consolidated memory is mined as a real block, so the
 *                 existing chain literally *is* the long-term memory tier
 *                 ("LTM is the existing M_global blockchain" — §3.5).
 *   • standalone — a self-contained hash-chained ledger (default), so the
 *                 module runs and is testable with zero external wiring.
 *
 * Retrieval is via LSH in O(1) average (§3.5, §9.1), backed by util/lsh.
 */

class LongTermMemory {
  constructor({ dim = 64, chain = null, adapter = null, nodeId = 'node-0', assocThreshold = 0.35 } = {}) {
    this.dim = dim;
    this.nodeId = nodeId;
    this.assocThreshold = assocThreshold; // min cosine to wire two memories
    this.chain = chain; // optional repo Blockchain instance (bridged mode)
    this.adapter = adapter; // optional pluggable substrate (poly-chain morphism)
    this.blocks = []; // memory blocks (canonical order)
    this.byHash = new Map();
    this.index = new LSHIndex({ dim, tables: 3, bits: 16, seed: 0x17a3 });
    // Associative weighted graph — grows as memories consolidate (Hebbian:
    // "fire together, wire together"). This is what makes LTM behave as a
    // *growing neural network* rather than a flat ledger.
    this.associations = new Map(); // hash -> [{ hash, weight }]
  }

  get size() {
    return this.blocks.length;
  }

  get mode() {
    if (this.adapter) return `poly:${this.adapter.name || 'adapter'}`;
    return this.chain ? 'bridged' : 'standalone';
  }

  /**
   * Poly-chain morphism (§ user extension): hot-swap the underlying chain
   * substrate at runtime. Subsequent commits use the new adapter; existing
   * blocks and the associative graph are preserved. This lets one logical
   * memory morph across heterogeneous chains (standalone ↔ PoW ↔ external).
   */
  morph(adapter) {
    this.adapter = adapter;
    this.chain = null;
    return this;
  }

  /** Resolve the canonical hash for a new memory across whatever substrate. */
  _resolveHash(memory, previousHash) {
    if (this.adapter) return this.adapter.commit(memory, previousHash).hash;
    if (this.chain) return this._mineOnChain(memory);
    return sha256(
      previousHash,
      memory.claim_text,
      String(memory.confidence),
      String(this.blocks.length)
    );
  }

  /**
   * Grow the associative graph by linking a new block to existing blocks it is
   * semantically close to (Hebbian wiring). We scan the committed set directly
   * rather than the LSH buckets: consolidation is infrequent and the set is
   * bounded, and moderate-similarity neighbours often miss LSH collisions, so a
   * direct scan is what makes the network actually grow connections.
   */
  _grow(block) {
    for (const other of this.blocks) {
      if (other.hash === block.hash || other.superseded) continue;
      const w = cosineSimilarity(block.embedding, other.embedding);
      if (w < this.assocThreshold) continue;
      if (!this.associations.has(block.hash)) this.associations.set(block.hash, []);
      if (!this.associations.has(other.hash)) this.associations.set(other.hash, []);
      this.associations.get(block.hash).push({ hash: other.hash, weight: w });
      this.associations.get(other.hash).push({ hash: block.hash, weight: w });
    }
  }

  /** Associative neighbours of a block (spreading-activation retrieval). */
  neighbors(hash) {
    return (this.associations.get(hash) || []).slice().sort((a, b) => b.weight - a.weight);
  }

  /** Growth metrics for the associative network. */
  graphStats() {
    let edges = 0;
    for (const list of this.associations.values()) edges += list.length;
    return { nodes: this.blocks.length, edges: edges / 2, density: this.blocks.length ? edges / 2 / this.blocks.length : 0 };
  }

  _previousHash() {
    return this.blocks.length ? this.blocks[this.blocks.length - 1].hash : '00000';
  }

  /**
   * Mine the consolidated memory onto the bridged PoW chain (if present) and
   * return the resulting block hash. Mirrors the repo's mine flow exactly.
   */
  _mineOnChain(payload) {
    const chain = this.chain;
    const lastBlock = chain.getLastBlock();
    const previousBlockHash = lastBlock && lastBlock.hash ? lastBlock.hash : '00000';
    // Record the memory as a transaction so it lands inside the mined block.
    chain.addTransactionToPendingTransactions({
      type: 'darm-ltm',
      data: payload.claim_text,
      sender: payload.proposer,
      recpient: 'M_global',
      confidence: payload.confidence,
    });
    const currentBlockData = {
      transactions: chain.pendingTransactions,
      index: (lastBlock && lastBlock.index ? lastBlock.index : 0) + 1,
    };
    const [nonce] = chain.PoW(previousBlockHash, currentBlockData);
    const hash = chain.hashBlock(previousBlockHash, currentBlockData, nonce);
    chain.createNewBlock(nonce, previousBlockHash, hash);
    return hash;
  }

  /** Commit a consolidated memory to LTM (called by CDCP after quorum, §5.4). */
  commit(memory) {
    const previousHash = this._previousHash();
    const hash = this._resolveHash(memory, previousHash);
    const block = {
      hash,
      previousHash,
      index: this.blocks.length + 1,
      claim_text: memory.claim_text,
      embedding: memory.embedding,
      confidence: memory.confidence,
      salience: memory.salience,
      consensus_votes: memory.consensus_votes || [],
      proposer: memory.proposer,
      validation: memory.validation || {},
      promoted_at: Date.now(),
      access_count: 0,
      superseded: false,
      supersededBy: null,
    };
    this._grow(block); // associative growth uses neighbours present *before* insert
    this.blocks.push(block);
    this.byHash.set(hash, block);
    this.index.insert(hash, block.embedding, null);
    return block;
  }

  /** O(1)-average LTM retrieval by embedding (LTM LSH hit, §9.1). */
  query(embedding, threshold = 0.85) {
    let best = null;
    let bestSim = -Infinity;
    for (const hash of this.index.candidates(embedding)) {
      const b = this.byHash.get(hash);
      if (!b || b.superseded) continue;
      const sim = cosineSimilarity(embedding, b.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        best = b;
      }
    }
    if (best && bestSim >= threshold) {
      best.access_count += 1;
      return { block: best, similarity: bestSim };
    }
    return null;
  }

  getByHash(hash) {
    return this.byHash.get(hash) || null;
  }

  /** Does LTM already hold a near-identical claim? (CDCP eligibility, §5.2) */
  contains(embedding, threshold = 0.97) {
    const hit = this.query(embedding, threshold);
    return !!hit;
  }

  /** Blocks committed since a timestamp (RRC refresh, §6.2 phase 3). */
  getSince(timestamp) {
    return this.blocks.filter((b) => b.promoted_at > timestamp && !b.superseded);
  }

  /** Age-biased sample for interleaved replay (§6.2 phase 2). */
  sampleByAge(n = 20, preference = 'old') {
    const sorted = [...this.blocks]
      .filter((b) => !b.superseded)
      .sort((a, b) =>
        preference === 'old' ? a.promoted_at - b.promoted_at : b.promoted_at - a.promoted_at
      );
    return sorted.slice(0, n);
  }

  /** Mark a block superseded by a winning challenger (retrograde res., §8.3). */
  markSuperseded(hash, supersededByHash) {
    const b = this.byHash.get(hash);
    if (b) {
      b.superseded = true;
      b.supersededBy = supersededByHash;
      this.index.remove(hash); // no longer served to agents
    }
  }

  getSuperseding(hash) {
    const b = this.byHash.get(hash);
    if (b && b.supersededBy) return this.byHash.get(b.supersededBy) || null;
    return null;
  }

  /** Validate the long-term blockchain's hash-link continuity. */
  validate() {
    for (let i = 1; i < this.blocks.length; i++) {
      if (this.blocks[i].previousHash !== this.blocks[i - 1].hash) {
        return { valid: false, brokenAt: i, reason: 'broken link' };
      }
    }
    return { valid: true, brokenAt: -1 };
  }

  /** Self-correct hash-link pointers (best-effort: re-links previousHash). */
  repairLinks() {
    let repaired = 0;
    for (let i = 1; i < this.blocks.length; i++) {
      if (this.blocks[i].previousHash !== this.blocks[i - 1].hash) {
        this.blocks[i].previousHash = this.blocks[i - 1].hash;
        repaired += 1;
      }
    }
    return repaired;
  }

  /** Top-K blocks by historical access (RRC replay warm-up, §7.4). */
  topByAccess(k = 10000) {
    return [...this.blocks]
      .filter((b) => !b.superseded)
      .sort((a, b) => b.access_count - a.access_count)
      .slice(0, k);
  }
}

module.exports = LongTermMemory;
