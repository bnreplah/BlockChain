'use strict';

const crypto = require('crypto');

/**
 * Memory Federation — DARM-ANN v7.2 §2.1 and the DIRP-1 QUERY verb (§2.4).
 *
 * "The ideal situation is the blockchains operate as the memory fabric across
 * each of the distributed nodes." This module makes each ACS's Long-Term Memory
 * BLOCKCHAIN a shard of one federated memory. A QUERY is routed across peers;
 * every ACS answers from its own LTM chain, and the best consensus-committed
 * answer wins — RRC-tier recall over the fabric, not a single node's memory.
 *
 *   Intra-net tier  →  Inter-net analogue          →  Substrate (§2.1)
 *   RRC (recall)    →  cross-subnet memory query    →  DIRP-1 QUERY verbs
 *   LTM             →  global chain checkpoints      →  global ledger
 *
 * A federated answer is only as trusted as its source: each shard's answer
 * carries the source ACS trust_score and the block's consensus confidence, so
 * the aggregator can rank by (similarity · trust · confidence) — memory
 * admission control (BVAS/ESE) is preserved end-to-end (Part VI poisoning
 * firewall).
 *
 * `ltmProvider` is a function () -> LongTermMemory (the node's real LTM chain).
 * `embed(text) -> Float64Array` is the node's real embedder. Both injected so
 * this layer stays dependency-free and reuses the existing memory blockchain.
 */

class MemoryFederation {
  constructor({ acsn, ltmProvider, embed, trustScore = 0.9 }) {
    this.acsn = acsn;
    this.ltmProvider = ltmProvider; // () -> LTM (a hash-linked blockchain)
    this.embed = embed;
    this.trustScore = trustScore;
    this.checkpoints = []; // global-chain checkpoints of our LTM head (§2.1)
  }

  /**
   * Answer a QUERY from THIS node's LTM blockchain. Returns the best local hit
   * (or a miss), scored for federated ranking. This is the "shard responds"
   * half of DIRP-1 QUERY.
   */
  answerLocal(queryText, { threshold = 0.6 } = {}) {
    const ltm = this.ltmProvider();
    if (!ltm) return { acsn: this.acsn, hit: false };
    const emb = this.embed(queryText);
    const hit = ltm.query(emb, threshold);
    if (!hit) return { acsn: this.acsn, hit: false, ltmHead: ltmHead(ltm) };
    const confidence = hit.block.confidence != null ? hit.block.confidence : 0.8;
    return {
      acsn: this.acsn,
      hit: true,
      claim: hit.block.claim_text,
      blockHash: hit.block.hash,
      similarity: hit.similarity,
      confidence,
      trust: this.trustScore,
      // federated rank = how relevant × how trusted × how consensus-confident
      score: hit.similarity * this.trustScore * confidence,
      ltmHead: ltmHead(ltm),
    };
  }

  /**
   * Aggregate shard answers (from self + gossiped peers) into ONE federated
   * result — the highest-scoring consensus-committed memory across the fabric.
   * `answers` = array of answerLocal-shaped records (self first is conventional).
   */
  static aggregate(queryText, answers) {
    const hits = (answers || []).filter((a) => a && a.hit);
    if (hits.length === 0) return { query: queryText, hit: false, sources: (answers || []).length };
    hits.sort((a, b) => (b.score || 0) - (a.score || 0));
    const best = hits[0];
    return {
      query: queryText,
      hit: true,
      claim: best.claim,
      fromAcs: best.acsn,
      blockHash: best.blockHash,
      similarity: best.similarity,
      confidence: best.confidence,
      trust: best.trust,
      score: best.score,
      sources: (answers || []).length,
      agreements: hits.filter((h) => h.blockHash === best.blockHash || h.claim === best.claim).length,
    };
  }

  /**
   * Take a global-chain checkpoint of our LTM head (§2.1 LTM→global checkpoints).
   * Anchors periodically checkpoint so the federation has verifiable, ordered
   * roots of each shard without shipping whole chains.
   */
  checkpoint() {
    const ltm = this.ltmProvider();
    if (!ltm) return null;
    const head = ltmHead(ltm);
    const cp = {
      acsn: this.acsn,
      height: ltm.size,
      head,
      root: crypto.createHash('sha256').update(this.acsn + '|' + head + '|' + ltm.size).digest('hex').slice(0, 32),
      at: Date.now(),
      valid: ltm.validate ? ltm.validate().valid : true,
    };
    this.checkpoints.push(cp);
    if (this.checkpoints.length > 1000) this.checkpoints.shift();
    return cp;
  }

  /** Verify a peer's checkpoint is internally consistent (root binds head+height). */
  static verifyCheckpoint(cp) {
    if (!cp || !cp.acsn || !cp.head) return false;
    const root = crypto.createHash('sha256').update(cp.acsn + '|' + cp.head + '|' + cp.height).digest('hex').slice(0, 32);
    return root === cp.root;
  }

  latestCheckpoint() {
    return this.checkpoints.length ? this.checkpoints[this.checkpoints.length - 1] : null;
  }

  stats() {
    const ltm = this.ltmProvider();
    return {
      acsn: this.acsn,
      ltmHeight: ltm ? ltm.size : 0,
      ltmHead: ltm ? ltmHead(ltm) : 'genesis',
      ltmValid: ltm && ltm.validate ? ltm.validate().valid : true,
      checkpoints: this.checkpoints.length,
    };
  }
}

function ltmHead(ltm) {
  return ltm.blocks && ltm.blocks.length ? ltm.blocks[ltm.blocks.length - 1].hash : 'genesis';
}

module.exports = MemoryFederation;
