'use strict';

const crypto = require('crypto');

/**
 * A real hash-linked blockchain primitive used by BOTH the short-term and
 * long-term memory tiers. Each block commits to its predecessor by hash, so
 * any tampering is detectable. Includes genuine self-correcting functionality:
 * validate() locates the first broken link, and repair() rebuilds the hash
 * chain from a trusted prefix.
 *
 *   block = { index, timestamp, payload, previousHash, nonce, hash }
 *
 * Optional proof-of-work difficulty (leading hex zeros) is supported per chain;
 * difficulty 0 means a plain hash chain (used for the high-throughput STM).
 */
class Chain {
  constructor({ name = 'chain', difficulty = 0, genesisPayload = null } = {}) {
    this.name = name;
    this.difficulty = difficulty;
    this.blocks = [];
    this._appendGenesis(genesisPayload);
  }

  static hashBlock(index, timestamp, payload, previousHash, nonce) {
    return crypto
      .createHash('sha256')
      .update(`${index}|${timestamp}|${previousHash}|${nonce}|${JSON.stringify(payload)}`)
      .digest('hex');
  }

  _appendGenesis(payload) {
    const block = { index: 0, timestamp: 0, payload: payload || { genesis: true }, previousHash: '0'.repeat(64), nonce: 0 };
    block.hash = Chain.hashBlock(block.index, block.timestamp, block.payload, block.previousHash, block.nonce);
    this.blocks.push(block);
  }

  get head() {
    return this.blocks[this.blocks.length - 1];
  }

  get height() {
    return this.blocks.length;
  }

  /** Mine (if difficulty > 0) and append a new block committing `payload`. */
  append(payload, { timestamp = Date.now() } = {}) {
    const prev = this.head;
    const index = prev.index + 1;
    const prefix = '0'.repeat(this.difficulty);
    let nonce = 0;
    let hash = Chain.hashBlock(index, timestamp, payload, prev.hash, nonce);
    while (this.difficulty > 0 && !hash.startsWith(prefix)) {
      nonce += 1;
      hash = Chain.hashBlock(index, timestamp, payload, prev.hash, nonce);
    }
    const block = { index, timestamp, payload, previousHash: prev.hash, nonce, hash };
    this.blocks.push(block);
    return block;
  }

  /** Validate every link + PoW. Returns { valid, brokenAt } (self-diagnosis). */
  validate() {
    const prefix = '0'.repeat(this.difficulty);
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      const expected = Chain.hashBlock(b.index, b.timestamp, b.payload, b.previousHash, b.nonce);
      if (b.hash !== expected) return { valid: false, brokenAt: i, reason: 'hash mismatch' };
      if (i > 0 && this.difficulty > 0 && !b.hash.startsWith(prefix)) return { valid: false, brokenAt: i, reason: 'pow' };
      if (i > 0 && b.previousHash !== this.blocks[i - 1].hash) return { valid: false, brokenAt: i, reason: 'broken link' };
    }
    return { valid: true, brokenAt: -1 };
  }

  /**
   * Self-correction: rebuild the chain from the last valid block. Re-links and
   * re-hashes (and re-mines under PoW) every block from `brokenAt` onward,
   * preserving payloads. Returns the number of blocks repaired.
   */
  repair() {
    const status = this.validate();
    if (status.valid) return 0;
    let repaired = 0;
    const prefix = '0'.repeat(this.difficulty);
    for (let i = Math.max(1, status.brokenAt); i < this.blocks.length; i++) {
      const b = this.blocks[i];
      b.previousHash = this.blocks[i - 1].hash;
      b.nonce = 0;
      b.hash = Chain.hashBlock(b.index, b.timestamp, b.payload, b.previousHash, b.nonce);
      while (this.difficulty > 0 && !b.hash.startsWith(prefix)) {
        b.nonce += 1;
        b.hash = Chain.hashBlock(b.index, b.timestamp, b.payload, b.previousHash, b.nonce);
      }
      repaired += 1;
    }
    return repaired;
  }

  /** Remove blocks whose payload matches `pred` and re-link (TTL pruning). */
  prune(pred) {
    const kept = this.blocks.filter((b, i) => i === 0 || !pred(b.payload, b));
    if (kept.length === this.blocks.length) return 0;
    const removed = this.blocks.length - kept.length;
    this.blocks = kept;
    // Re-link/re-hash to keep the pruned chain internally consistent.
    for (let i = 1; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      b.index = i;
      b.previousHash = this.blocks[i - 1].hash;
      b.nonce = 0;
      b.hash = Chain.hashBlock(b.index, b.timestamp, b.payload, b.previousHash, b.nonce);
    }
    return removed;
  }
}

module.exports = Chain;
