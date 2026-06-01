'use strict';

const crypto = require('crypto');

/**
 * Gossip-based transaction mempool.
 *
 * Any node (not just an orchestrator) can submit a transaction; it is signed,
 * added to the local pool, and gossiped to peers. Peers verify, deduplicate,
 * and re-gossip (epidemic broadcast with a bounded fan-out + TTL), so a txn
 * submitted anywhere reaches every node. Validators pull from the pool to
 * propose the next consensus height; committed txns are removed.
 *
 * Transport contract (same as consensus/transport.js):
 *   connect(nodeId, onMessage) · send(from,to,msg) · broadcast(from,msg)
 * The mempool multiplexes on a transport via handle(msg) for type 'TX_GOSSIP'.
 */

function txId(tx) {
  return crypto.createHash('sha256').update(JSON.stringify({ type: tx.type, payload: tx.payload, nonce: tx.nonce })).digest('hex').slice(0, 32);
}

class Mempool {
  constructor({ nodeId, key = null, transport = null, fanout = 4, ttl = 4, max = 10000, onTx = null, rng = Math.random } = {}) {
    this.nodeId = nodeId;
    this.key = key; // optional ValidatorKey to sign submissions
    this.transport = transport;
    this.fanout = fanout;
    this.ttl = ttl;
    this.max = max;
    this.onTx = onTx; // optional callback(tx) when a new tx is admitted
    this.rng = rng; // injectable PRNG for deterministic gossip sampling
    this.pool = new Map(); // id -> tx
    this.seen = new Set(); // ids ever seen (dedup, incl. committed)
    this.peers = []; // peer node ids for gossip targeting
  }

  setPeers(ids) {
    this.peers = ids.filter((id) => id !== this.nodeId);
    return this;
  }

  size() {
    return this.pool.size;
  }

  /** Build, sign, locally admit, and gossip a new transaction. */
  submit(type, payload) {
    const tx = { type, payload, nonce: crypto.randomBytes(6).toString('hex'), origin: this.nodeId, ts: Date.now() };
    tx.id = txId(tx);
    if (this.key) {
      tx.publicKey = this.key.publicKeyB64;
      tx.signature = this.key.sign(Buffer.from(tx.id));
    }
    this._admit(tx);
    this._gossip(tx, this.ttl);
    return tx;
  }

  /** Local admission with dedup + capacity bound. Returns true if newly added. */
  _admit(tx) {
    if (this.seen.has(tx.id)) return false;
    this.seen.add(tx.id);
    if (this.pool.size >= this.max) {
      // Evict the oldest (FIFO) to stay bounded.
      const oldest = this.pool.keys().next().value;
      if (oldest) this.pool.delete(oldest);
    }
    this.pool.set(tx.id, tx);
    if (this.onTx) this.onTx(tx);
    return true;
  }

  _verify(tx) {
    if (!tx || !tx.id || tx.id !== txId(tx)) return false; // integrity
    if (tx.signature && tx.publicKey) {
      const ValidatorKey = require('./validatorKey');
      return ValidatorKey.verify(Buffer.from(tx.id), tx.signature, tx.publicKey);
    }
    return true; // unsigned txns allowed when no key policy is enforced
  }

  /** Gossip a tx to a random subset of peers with a decremented TTL. */
  _gossip(tx, ttl) {
    if (!this.transport || ttl <= 0 || this.peers.length === 0) return;
    const targets = this._sample(this.peers, this.fanout);
    for (const to of targets) this.transport.send(this.nodeId, to, { type: 'TX_GOSSIP', ttl: ttl - 1, tx });
  }

  _sample(arr, k) {
    if (arr.length <= k) return arr.slice();
    const pool = arr.slice();
    const out = [];
    for (let i = 0; i < k && pool.length; i++) out.push(pool.splice(Math.floor(this.rng() * pool.length), 1)[0]);
    return out;
  }

  /** Inbound gossip handler (wire into the transport dispatcher). */
  handle(msg) {
    if (!msg || msg.type !== 'TX_GOSSIP') return;
    const tx = msg.tx;
    if (!this._verify(tx)) return; // drop forged/corrupt
    const isNew = this._admit(tx);
    if (isNew) this._gossip(tx, msg.ttl); // re-broadcast only the first time we see it
  }

  /** Take up to n pending txns (FIFO) for proposing a consensus height. */
  take(n = 1) {
    return [...this.pool.values()].slice(0, n);
  }

  /** Remove committed txns from the pool (they stay in `seen` for dedup). */
  remove(ids) {
    for (const id of ids) this.pool.delete(id);
  }
}

Mempool.txId = txId;
module.exports = Mempool;
