'use strict';

const crypto = require('crypto');

/**
 * Chain adapters — poly-chain morphism & substrate-agnosticism.
 *
 * The LTM tier doesn't care *what* kind of chain backs it, only that the
 * substrate can take a consolidated memory payload + the previous hash and
 * return a canonical, tamper-evident hash. That single contract makes
 * DARM-ANN multipurpose and chain-agnostic, and lets a node morph between
 * substrates at runtime (LongTermMemory.morph).
 *
 *   Adapter contract:
 *     {
 *       name: string,
 *       commit(payload, previousHash) -> { hash, meta? },
 *       describe() -> object
 *     }
 *
 * Built-in adapters:
 *   • standalone   — pure in-process hash-chained ledger (zero deps)
 *   • powProofOfWork — self-contained PoW (difficulty-tunable), no repo dep
 *   • repoChain    — bridges the repository's structures/Blockchain.js
 */

function sha256(...parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

/** Pure hash-chain — the lightest possible self-contained substrate. */
function standaloneAdapter() {
  let height = 0;
  return {
    name: 'standalone',
    commit(payload, previousHash) {
      const hash = sha256(previousHash, payload.claim_text, String(payload.confidence), String(height++));
      return { hash, meta: { height } };
    },
    describe() {
      return { name: 'standalone', height };
    },
  };
}

/**
 * Self-contained Proof-of-Work substrate — builds its own chain from scratch,
 * no Redis / no external node. Difficulty = number of leading zero nibbles.
 */
function powAdapter({ difficulty = 3 } = {}) {
  const prefix = '0'.repeat(difficulty);
  let height = 0;
  return {
    name: `pow-d${difficulty}`,
    commit(payload, previousHash) {
      let nonce = 0;
      let hash;
      const base = previousHash + '|' + payload.claim_text + '|' + payload.confidence + '|' + height;
      do {
        hash = sha256(base, String(nonce++));
      } while (!hash.startsWith(prefix));
      height += 1;
      return { hash, meta: { nonce: nonce - 1, difficulty, height } };
    },
    describe() {
      return { name: `pow-d${difficulty}`, difficulty, height };
    },
  };
}

/**
 * Bridge to the repository's PoW Blockchain (structures/Blockchain.js).
 * Mines each memory as a real block on the existing chain, so the repo chain
 * *is* the long-term memory tier.
 */
function repoChainAdapter(chain) {
  return {
    name: 'repo-chain',
    commit(payload, previousHash) {
      const lastBlock = chain.getLastBlock();
      const prev = lastBlock && lastBlock.hash ? lastBlock.hash : previousHash || '00000';
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
      const [nonce] = chain.PoW(prev, currentBlockData);
      const hash = chain.hashBlock(prev, currentBlockData, nonce);
      chain.createNewBlock(nonce, prev, hash);
      return { hash, meta: { nonce } };
    },
    describe() {
      return { name: 'repo-chain', height: chain.chain ? chain.chain.length : 0 };
    },
  };
}

module.exports = { standaloneAdapter, powAdapter, repoChainAdapter, sha256 };
