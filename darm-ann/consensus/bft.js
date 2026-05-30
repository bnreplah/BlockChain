'use strict';

const BVAS = require('../engine/bvas');
const ValidatorKey = require('./validatorKey');

/**
 * Multi-round Byzantine-fault-tolerant consensus with leader rotation
 * (Tendermint-style), with real Ed25519-signed messages verified at every hop.
 *
 *   round r proposer = sortedValidators[r mod n]   (round-robin rotation)
 *   per round:  PROPOSE → PREVOTE(value|nil) → PRECOMMIT(value|nil)
 *   commit when ≥ τ_c weighted PRECOMMIT(value); else advance to round r+1
 *
 * Liveness under a faulty/silent leader: if the round-r proposer does not
 * propose, honest nodes time out, prevote/precommit nil, and rotate to the
 * round-(r+1) leader. Safety (no two conflicting commits) holds by τ_c>2/3
 * quorum intersection; nodes lock on a value they precommit and keep prevoting
 * it in later rounds.
 *
 * Two execution modes share one state machine:
 *   • synchronous (InProcessBus): driven by runConsensusRound() — pump then
 *     fire timeouts, deterministically, until commit or maxRounds.
 *   • asynchronous (TCP): real setTimeout timers (enable with useTimers:true).
 */
class BFTNode {
  constructor({ nodeId, key, validators, transport, tauC = 0.67, evaluate, onDecide, faulty = false, useTimers = false, timeoutMs = 300, maxRounds = null, wal = null, height = 0 }) {
    this.nodeId = nodeId;
    this.key = key;
    this.validators = validators;
    this.transport = transport;
    this.tauC = tauC;
    this.evaluate = evaluate;
    this.onDecide = onDecide;
    this.faulty = faulty; // simulate a silent/crashed leader (for rotation tests)
    this.useTimers = useTimers;
    this.timeoutMs = timeoutMs;
    this.wal = wal; // optional write-ahead log for crash recovery
    this.height = height;
    this.validatorIds = [...validators.keys()].sort();
    this.maxRounds = maxRounds || this.validatorIds.length + 2;
    this.totalWeight = [...validators.values()].reduce((s, v) => s + v.weight, 0) || 1;
    this.transport.connect(nodeId, (msg) => this.handle(msg));
    this._resetHeight();
  }

  _log(entry) {
    if (this.wal) this.wal.append({ ...entry, height: this.height, node: this.nodeId });
  }

  /**
   * Recover consensus state from the WAL after a crash/restart. Restores the
   * locked value, current round, and which rounds were already prevoted/
   * precommitted so the node never equivocates post-recovery.
   */
  recoverFromWAL() {
    if (!this.wal) return { recovered: false };
    let maxRound = -1;
    for (const e of this.wal.replay()) {
      if (e.node !== this.nodeId || (e.height != null && e.height !== this.height)) continue;
      if (e.t === 'ENTER') maxRound = Math.max(maxRound, e.round);
      if (e.t === 'PREVOTE') this._r(e.round).prevoted = true;
      if (e.t === 'PRECOMMIT') {
        this._r(e.round).precommitted = true;
        if (e.choice === 'value') this.locked = { round: e.round };
      }
      if (e.t === 'DECIDE') this.decided = true;
    }
    if (maxRound >= 0) {
      this.round = maxRound;
      this.step = 'precommit';
    }
    return { recovered: maxRound >= 0 || this.decided, round: this.round, locked: !!this.locked, decided: this.decided };
  }

  _resetHeight() {
    this.value = null;
    this.round = -1;
    this.step = 'idle';
    this.decided = false;
    this.locked = null; // { round } — we only ever lock the single value
    this.rounds = new Map(); // round -> { proposal, prevotes:Map, precommits:Map, prevoted, precommitted }
    this._timer = null;
  }

  _r(round) {
    if (!this.rounds.has(round)) this.rounds.set(round, { proposal: null, prevotes: new Map(), precommits: new Map(), prevoted: false, precommitted: false });
    return this.rounds.get(round);
  }

  _weight(id) {
    const v = this.validators.get(id);
    return v ? v.weight : 0;
  }

  proposerFor(round) {
    // Rotate the leader by both height and round so successive heights and
    // failed rounds pick different proposers.
    return this.validatorIds[(this.height + round) % this.validatorIds.length];
  }

  /** Begin consensus on `value` at round 0. */
  start(value) {
    this.value = value;
    this.enterRound(0);
  }

  enterRound(round) {
    if (this.decided || round > this.maxRounds) return;
    this.round = round;
    this.step = 'propose';
    this._log({ t: 'ENTER', round });
    const rs = this._r(round);
    if (this.proposerFor(round) === this.nodeId && !this.faulty) {
      const value = this.value;
      const msg = {
        type: 'PROPOSE',
        round,
        claim_id: value.claim_id,
        proposer: this.nodeId,
        value,
        sig: this.key.sign(Buffer.from(JSON.stringify({ type: 'PROPOSE', round, claim_id: value.claim_id, proposer: this.nodeId }))),
      };
      rs.proposal = value;
      this._send(msg);
      this._doPrevote(round); // proposer prevotes its own proposal
    }
    this._arm('propose');
  }

  _send(msg) {
    // self-deliver + broadcast (so the sender also tallies its own message)
    this.handle(JSON.parse(JSON.stringify(msg)));
    this.transport.broadcast(this.nodeId, msg);
  }

  _arm(step) {
    if (!this.useTimers) return;
    if (this._timer) clearTimeout(this._timer);
    const at = this.round;
    this._timer = setTimeout(() => {
      if (!this.decided && this.round === at && this.step === step) this.onTimeout();
    }, this.timeoutMs);
    if (this._timer.unref) this._timer.unref();
  }

  handle(msg) {
    if (this.decided) return;
    if (msg.round < this.round) return; // stale round
    if (msg.type === 'PROPOSE') return this._onPropose(msg);
    if (msg.type === 'PREVOTE') return this._onPrevote(msg);
    if (msg.type === 'PRECOMMIT') return this._onPrecommit(msg);
  }

  _onPropose(msg) {
    if (msg.round !== this.round) return;
    const pk = this.validators.get(msg.proposer);
    if (!pk || msg.proposer !== this.proposerFor(msg.round)) return; // wrong leader
    const ok = ValidatorKey.verify(Buffer.from(JSON.stringify({ type: 'PROPOSE', round: msg.round, claim_id: msg.claim_id, proposer: msg.proposer })), msg.sig, pk.publicKeyB64);
    if (!ok) return;
    const rs = this._r(msg.round);
    rs.proposal = msg.value;
    if (!this.value) this.value = msg.value;
    this._doPrevote(msg.round);
  }

  _doPrevote(round) {
    const rs = this._r(round);
    if (rs.prevoted) return;
    rs.prevoted = true;
    this.step = 'prevote';
    // Choice is logged after it is computed (just below) — see _log call.

    // Locked nodes keep prevoting the value (safety); otherwise evaluate.
    let choice = 'nil';
    let voteObj = null;
    if (this.locked || (rs.proposal && this.evaluate(rs.proposal).vote === 'YES')) {
      choice = 'value';
      const verdict = this.evaluate(rs.proposal || this.value);
      voteObj = { claim_id: this.value.claim_id, node_id: this.nodeId, vote: 'YES', vote_score: verdict.score, publicKey: this.key.publicKeyB64 };
      voteObj.signature = this.key.sign(BVAS.canonicalVoteBytes(voteObj));
    }
    this._log({ t: 'PREVOTE', round, choice });
    this._send({ type: 'PREVOTE', round, claim_id: this.value.claim_id, from: this.nodeId, choice, vote: voteObj });
    this._arm('prevote');
  }

  _onPrevote(msg) {
    if (msg.round !== this.round) return;
    const known = this.validators.get(msg.from);
    if (!known) return;
    if (msg.choice === 'value') {
      const v = msg.vote;
      if (!v || v.node_id !== msg.from || v.publicKey !== known.publicKeyB64 || !BVAS.verifyVote(v)) return;
    }
    const rs = this._r(msg.round);
    rs.prevotes.set(msg.from, msg.choice === 'value' ? msg.vote : 'nil');

    let valueW = 0;
    for (const [id, pv] of rs.prevotes) if (pv !== 'nil') valueW += this._weight(id);
    if (!rs.precommitted && valueW / this.totalWeight >= this.tauC) this._doPrecommit(msg.round, 'value');
  }

  _doPrecommit(round, choice) {
    const rs = this._r(round);
    if (rs.precommitted) return;
    rs.precommitted = true;
    this.step = 'precommit';
    if (choice === 'value') this.locked = { round }; // lock on the value
    this._log({ t: 'PRECOMMIT', round, choice }); // durable before broadcasting
    this._send({ type: 'PRECOMMIT', round, claim_id: this.value.claim_id, from: this.nodeId, choice, sig: this.key.sign(this._precommitBytes(round, choice)) });
    this._arm('precommit');
  }

  _precommitBytes(round, choice) {
    return Buffer.from(JSON.stringify({ type: 'PRECOMMIT', round, claim_id: this.value.claim_id, from: this.nodeId, choice }));
  }

  _onPrecommit(msg) {
    if (msg.round !== this.round) return;
    const known = this.validators.get(msg.from);
    if (!known) return;
    const bytes = Buffer.from(JSON.stringify({ type: 'PRECOMMIT', round: msg.round, claim_id: msg.claim_id, from: msg.from, choice: msg.choice }));
    if (!ValidatorKey.verify(bytes, msg.sig, known.publicKeyB64)) return;
    const rs = this._r(msg.round);
    rs.precommits.set(msg.from, msg.choice);

    let valueW = 0;
    for (const [id, ch] of rs.precommits) if (ch === 'value') valueW += this._weight(id);
    if (valueW / this.totalWeight >= this.tauC) {
      this.decided = true;
      if (this._timer) clearTimeout(this._timer);
      this._log({ t: 'DECIDE', round: msg.round, claim_id: msg.claim_id });
      const yes = [...rs.prevotes.values()].filter((p) => p !== 'nil');
      if (this.onDecide) this.onDecide({ committed: true, yes, claim_id: msg.claim_id, round: msg.round });
    }
  }

  /** Timeout-driven progress: nil-vote or rotate to the next round. */
  onTimeout() {
    if (this.decided) return false;
    const rs = this._r(this.round);
    if (this.step === 'propose' && !rs.prevoted) {
      this._doPrevote(this.round); // no proposal seen → prevote nil (or value if locked)
      return true;
    }
    if (this.step === 'prevote' && !rs.precommitted) {
      this._doPrecommit(this.round, 'nil'); // no value quorum → precommit nil
      return true;
    }
    if (this.step === 'precommit') {
      if (this.round + 1 <= this.maxRounds) {
        this.enterRound(this.round + 1); // rotate leader
        return true;
      }
    }
    return false;
  }
}

/**
 * Synchronous driver for the InProcessBus: alternate message delivery (pump)
 * with timeout firing until a node commits or rounds are exhausted.
 */
function runConsensusRound(nodes, bus, value, { maxIterations = 200 } = {}) {
  nodes.forEach((n) => n.start(value));
  for (let i = 0; i < maxIterations; i++) {
    bus.pump();
    if (nodes.some((n) => n.decided)) break;
    let progressed = false;
    for (const n of nodes) progressed = n.onTimeout() || progressed;
    bus.pump();
    if (nodes.some((n) => n.decided)) break;
    if (!progressed) break;
  }
  return nodes.find((n) => n.decided) ? true : false;
}

module.exports = { BFTNode, runConsensusRound };
