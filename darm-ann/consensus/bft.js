'use strict';

const crypto = require('crypto');
const BVAS = require('../engine/bvas');

/**
 * Byzantine-fault-tolerant agreement for a single decision (PBFT/Tendermint-
 * style propose → prevote → precommit → commit), with real Ed25519-signed
 * messages verified at every hop and weighted ≥ τ_c quorums.
 *
 * Safety: any two τ_c (>2/3) quorums intersect in ≥1 honest node, so two
 * conflicting values cannot both commit (paper P40/P46). Each node runs an
 * independent state machine and communicates only via the transport — there
 * is no shared in-memory consensus state.
 */
class BFTNode {
  constructor({ nodeId, key, validators, transport, tauC = 0.67, evaluate, onDecide }) {
    this.nodeId = nodeId;
    this.key = key; // ValidatorKey (this node)
    this.validators = validators; // Map nodeId -> { publicKeyB64, weight }
    this.transport = transport;
    this.tauC = tauC;
    this.evaluate = evaluate; // (proposal) -> { vote:'YES'|'NO', score }
    this.onDecide = onDecide; // (result) -> void
    this.totalWeight = [...validators.values()].reduce((s, v) => s + v.weight, 0) || 1;
    this.transport.connect(nodeId, (msg) => this.handle(msg));
    this._reset();
  }

  _reset() {
    this.round = { proposal: null, prevotes: new Map(), precommits: new Map(), sentPrevote: false, sentPrecommit: false, decided: false };
  }

  newHeight() {
    this._reset();
  }

  _weight(id) {
    const v = this.validators.get(id);
    return v ? v.weight : 0;
  }

  _precommitBytes(claimId) {
    return Buffer.from(JSON.stringify({ type: 'PRECOMMIT', claim_id: claimId, from: this.nodeId, decision: 'COMMIT' }));
  }

  /** Proposer entry point: broadcast the signed proposal (and self-deliver). */
  propose(proposal) {
    const msg = { type: 'PROPOSE', claim_id: proposal.claim_id, proposer: this.nodeId, proposal, sig: this.key.sign(Buffer.from(JSON.stringify({ type: 'PROPOSE', claim_id: proposal.claim_id, proposer: this.nodeId }))) };
    this.handle(msg); // proposer participates too
    this.transport.broadcast(this.nodeId, msg);
  }

  handle(msg) {
    if (msg.type === 'PROPOSE') return this._onPropose(msg);
    if (msg.type === 'PREVOTE') return this._onPrevote(msg);
    if (msg.type === 'PRECOMMIT') return this._onPrecommit(msg);
  }

  _onPropose(msg) {
    if (this.round.sentPrevote) return;
    const proposerKey = this.validators.get(msg.proposer);
    if (!proposerKey) return;
    const ok = require('./validatorKey').verify(
      Buffer.from(JSON.stringify({ type: 'PROPOSE', claim_id: msg.claim_id, proposer: msg.proposer })),
      msg.sig,
      proposerKey.publicKeyB64
    );
    if (!ok) return; // reject unsigned/forged proposal
    this.round.proposal = msg.proposal;

    // Independent evaluation → signed vote (canonical bytes match BVAS).
    const verdict = this.evaluate(msg.proposal);
    const vote = {
      claim_id: msg.claim_id,
      node_id: this.nodeId,
      vote: verdict.vote,
      vote_score: verdict.score,
      publicKey: this.key.publicKeyB64,
    };
    vote.signature = this.key.sign(BVAS.canonicalVoteBytes(vote));
    this.round.sentPrevote = true;
    const prevote = { type: 'PREVOTE', claim_id: msg.claim_id, from: this.nodeId, vote };
    this.handle(prevote);
    this.transport.broadcast(this.nodeId, prevote);
  }

  _onPrevote(msg) {
    const v = msg.vote;
    if (!v || v.node_id !== msg.from) return;
    const known = this.validators.get(msg.from);
    if (!known || v.publicKey !== known.publicKeyB64) return; // unknown validator
    if (!BVAS.verifyVote(v)) return; // forged vote
    this.round.prevotes.set(msg.from, v);

    let yesW = 0;
    for (const [id, pv] of this.round.prevotes) if (pv.vote === 'YES') yesW += this._weight(id);
    if (!this.round.sentPrecommit && yesW / this.totalWeight >= this.tauC) {
      this.round.sentPrecommit = true;
      const pc = { type: 'PRECOMMIT', claim_id: msg.claim_id, from: this.nodeId, sig: this.key.sign(this._precommitBytes(msg.claim_id)) };
      this.handle(pc);
      this.transport.broadcast(this.nodeId, pc);
    }
  }

  _onPrecommit(msg) {
    const known = this.validators.get(msg.from);
    if (!known) return;
    const ok = require('./validatorKey').verify(this._precommitBytesFor(msg.claim_id, msg.from), msg.sig, known.publicKeyB64);
    if (!ok) return;
    this.round.precommits.set(msg.from, true);

    let w = 0;
    for (const id of this.round.precommits.keys()) w += this._weight(id);
    if (!this.round.decided && w / this.totalWeight >= this.tauC) {
      this.round.decided = true;
      const yes = [...this.round.prevotes.values()].filter((p) => p.vote === 'YES');
      if (this.onDecide) this.onDecide({ committed: true, prevotes: [...this.round.prevotes.values()], yes, claim_id: msg.claim_id });
    }
  }

  _precommitBytesFor(claimId, from) {
    return Buffer.from(JSON.stringify({ type: 'PRECOMMIT', claim_id: claimId, from, decision: 'COMMIT' }));
  }
}

module.exports = { BFTNode };
