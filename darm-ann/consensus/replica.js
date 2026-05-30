'use strict';

const { BFTNode, runConsensusRound } = require('./bft');

/**
 * Replica — a multi-height replicated state machine over the BFT engine.
 *
 * Each height commits exactly one value through a real BFT round. Values can be
 * application transactions (e.g. a consolidated memory) OR **membership-change
 * transactions**:
 *
 *   { type: 'add-validator',    nodeId, publicKeyB64, weight }
 *   { type: 'remove-validator', nodeId }
 *   { type: 'memory',           claim, ... }
 *
 * A committed membership change mutates the validator set used for the *next*
 * height (epoch boundary), so a running cluster can grow/shrink **live** with
 * every node agreeing via consensus. The ordered decision log + validator set
 * are written to the WAL so a crashed replica recovers its exact state.
 */
class Replica {
  constructor({ nodeId, key, validators, tauC = 0.67, wal = null, apply = null }) {
    this.nodeId = nodeId;
    this.key = key;
    this.set = new Map(validators); // id -> { publicKeyB64, weight }
    this.tauC = tauC;
    this.wal = wal;
    this.apply = apply; // optional side-effect hook (value, height)
    this.height = 0;
    this.log = [];
  }

  size() {
    return this.set.size;
  }

  validatorIds() {
    return [...this.set.keys()].sort();
  }

  /** Independent validity check of a proposed value (per-node, no shared state). */
  evaluate(value) {
    if (!value || typeof value !== 'object' || !value.type) return { vote: 'NO', score: 0 };
    if (value.type === 'add-validator') return { vote: value.nodeId && value.publicKeyB64 ? 'YES' : 'NO', score: 0.9 };
    if (value.type === 'remove-validator') return { vote: value.nodeId && value.nodeId !== this.nodeId ? 'YES' : 'NO', score: 0.9 };
    if (value.type === 'memory') return { vote: value.claim ? 'YES' : 'NO', score: 0.9 };
    return { vote: 'NO', score: 0 };
  }

  /** Apply a committed value to the replicated state (deterministic on all nodes). */
  commitValue(value) {
    if (this.wal) this.wal.append({ t: 'COMMIT', height: this.height, value, node: this.nodeId });
    this.log.push({ height: this.height, value });
    if (this.apply) {
      try { this.apply(value, this.height); } catch (_e) { /* side-effect best-effort */ }
    }
    // Membership changes take effect for the NEXT height.
    if (value.type === 'add-validator') this.set.set(value.nodeId, { publicKeyB64: value.publicKeyB64, weight: value.weight || 1 });
    if (value.type === 'remove-validator') this.set.delete(value.nodeId);
    this.height += 1;
    if (this.wal) this.wal.newHeight(this.height);
  }

  /**
   * Rebuild consensus state from the WAL. Replays only COMMITs at or beyond the
   * current height, so it is safe to call after loadState() restored a
   * snapshot (and after the WAL was compacted to that snapshot's height).
   */
  recover() {
    if (!this.wal) return { recovered: false };
    let applied = 0;
    for (const e of this.wal.replay()) {
      if (e.t !== 'COMMIT' || e.node !== this.nodeId) continue;
      if (e.height < this.height) continue; // already captured by the snapshot
      const value = e.value;
      this.log.push({ height: e.height, value });
      if (value.type === 'add-validator') this.set.set(value.nodeId, { publicKeyB64: value.publicKeyB64, weight: value.weight || 1 });
      if (value.type === 'remove-validator') this.set.delete(value.nodeId);
      this.height = e.height + 1;
      applied += 1;
    }
    return { recovered: applied > 0, height: this.height, validators: this.set.size };
  }

  /** Durable snapshot of the replicated state (pairs with WAL compaction). */
  snapshotState() {
    return { height: this.height, log: this.log, set: [...this.set.entries()] };
  }

  loadState(s) {
    this.height = s.height;
    this.log = s.log || [];
    this.set = new Map(s.set || []);
    return this;
  }

  /** Compact the WAL up to the current height (safe once state is snapshotted). */
  compactWAL() {
    if (this.wal) this.wal.compact(this.height);
  }
}

/**
 * Run one consensus height across a set of replicas (sharing a transport) for a
 * given value. On commit, every replica applies it deterministically. Returns
 * { committed, round, height }.
 */
function runHeight(replicas, bus, value) {
  let decision = null;
  const nodes = replicas.map((r) =>
    new BFTNode({
      nodeId: r.nodeId,
      key: r.key,
      validators: r.set,
      transport: bus,
      tauC: r.tauC,
      height: r.height,
      wal: r.wal,
      evaluate: (prop) => r.evaluate(prop),
      onDecide: (res) => { if (!decision) decision = res; },
    })
  );
  runConsensusRound(nodes, bus, value);
  if (decision && decision.committed) {
    const committedHeight = replicas[0].height;
    for (const r of replicas) r.commitValue(value);
    return { committed: true, round: decision.round, height: committedHeight };
  }
  return { committed: false };
}

module.exports = { Replica, runHeight };
