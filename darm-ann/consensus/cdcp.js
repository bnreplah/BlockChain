'use strict';

const ValidatorKey = require('./validatorKey');
const { InProcessBus } = require('./transport');
const { BFTNode } = require('./bft');

/**
 * Consensus-Driven Consolidation Protocol (CDCP) — paper §5.
 *
 * An STM entry is promoted to LTM only when a τ_c-quorum of independent
 * validators agree, exchanging real Ed25519-signed messages through a genuine
 * BFT round (consensus/bft.js) over a transport (in-process bus by default,
 * TCP for multi-host). Each validator evaluates with its own GTE + ESE
 * (Algorithm 13) — no shared intermediate state.
 */

const STATES = Object.freeze({ PENDING: 'PENDING', VOTING: 'VOTING', CONSENSUS: 'CONSENSUS', REJECTED: 'REJECTED', EXPIRED: 'EXPIRED' });

/** A CDCP validator: its own keypair, knowledge graph (GTE) and ESE. */
class Validator {
  constructor({ nodeId, gte, ese, key }) {
    this.nodeId = nodeId;
    this.gte = gte;
    this.ese = ese;
    this.key = key || new ValidatorKey();
  }

  voteWeight(gkThreshold) {
    return Math.min(1, this.gte.gkSize() / gkThreshold);
  }

  /** Algorithm 13 — independent verdict against this node's own knowledge. */
  evaluate(nomination, cfg) {
    const w = cfg.cdcp.voteWeights;
    const bfs = this.gte.bfsValidate(nomination.claim_text, nomination.embedding, cfg.gte.bfsK2);
    const dfs = this.gte.dfsAudit(nomination.claim_text, nomination.embedding);
    const ue = this.ese.estimateEpistemicUncertainty(nomination.claim_text);
    const consistency = bfs.conflicts.length === 0 ? 1 : 1 - Math.max(...bfs.conflicts.map((c) => c.weight));
    const grounded = dfs.type === 'Grounded' ? 1 : 0;
    const score = w.bfs * bfs.score + w.grounded * grounded + w.consistency * consistency + w.certainty * (1 - ue);
    return { vote: score >= cfg.cdcp.thetaVote ? 'YES' : 'NO', score };
  }
}

class CDCP {
  constructor({ self, peers = [], ltm, rrc, stm, bvas, cfg, embedder }) {
    this.self = self;
    this.peers = peers;
    this.ltm = ltm;
    this.rrc = rrc;
    this.stm = stm;
    this.bvas = bvas;
    this.cfg = cfg;
    this.embedder = embedder;
    this.temporalConflicts = [];
  }

  get voters() {
    return [this.self, ...this.peers];
  }

  /** Current validator set with up-to-date (G_K-scaled) voting weights. */
  _validatorSet() {
    const set = new Map();
    for (const v of this.voters) {
      set.set(v.nodeId, { publicKeyB64: v.key.publicKeyB64, weight: v.voteWeight(this.cfg.cdcp.gkThreshold) });
    }
    return set;
  }

  /** Algorithm 12 — nomination eligibility. */
  nominate(stmEntry) {
    const cfg = this.cfg;
    if (stmEntry.salience < cfg.cdcp.thetaNominate) return { status: 'NOT_ELIGIBLE' };
    if (Date.now() - stmEntry.created_at < cfg.cdcp.tMinAgeMs) return { status: 'TOO_YOUNG' };
    if (this.ltm.contains(stmEntry.embedding, 0.97)) return { status: 'ALREADY_LTM' };
    stmEntry.state = STATES.VOTING;
    return {
      status: 'NOMINATED',
      nomination: {
        claim_id: stmEntry.claim_id,
        claim_text: stmEntry.claim_text,
        embedding: stmEntry.embedding,
        proposer: this.self.nodeId,
        validation: stmEntry.validation,
        epistemic: stmEntry.epistemic_tuple,
        salience: stmEntry.salience,
      },
    };
  }

  /** Run one BFT consensus round for a nomination over a fresh in-process bus. */
  _runRound(nomination) {
    const bus = new InProcessBus();
    const validators = this._validatorSet();
    let decision = null;
    const nodes = this.voters.map(
      (v) =>
        new BFTNode({
          nodeId: v.nodeId,
          key: v.key,
          validators,
          transport: bus,
          tauC: this.cfg.cdcp.tauC,
          evaluate: (prop) => v.evaluate(prop, this.cfg),
          onDecide: (res) => {
            if (!decision) decision = res;
          },
        })
    );
    const proposer = nodes.find((n) => n.nodeId === this.self.nodeId);
    proposer.propose(nomination);
    bus.pump();
    return { decision, validators };
  }

  runConsensus(stmEntry) {
    const nom = this.nominate(stmEntry);
    if (nom.status !== 'NOMINATED') return nom;

    const { decision, validators } = this._runRound(nom.nomination);
    if (!decision || !decision.committed) {
      stmEntry.state = STATES.REJECTED;
      stmEntry.retry_count = (stmEntry.retry_count || 0) + 1;
      return { status: decision ? 'REJECTED_CONTRADICTED' : 'INSUFFICIENT_VOTES' };
    }

    // Consolidated confidence: weight-averaged YES vote scores.
    const yes = decision.yes;
    const denom = yes.reduce((s, v) => s + (validators.get(v.node_id)?.weight || 0), 0) || 1;
    const consolidatedConf = yes.reduce((s, v) => s + v.vote_score * (validators.get(v.node_id)?.weight || 0), 0) / denom;

    const candidate = {
      claim_text: nom.nomination.claim_text,
      embedding: nom.nomination.embedding,
      confidence: consolidatedConf,
      salience: nom.nomination.salience,
      consensus_votes: yes,
      proposer: nom.nomination.proposer,
      validation: { ...nom.nomination.validation, voteCount: yes.length },
    };

    // BVAS gate (real 5-stage, verifies the signed votes).
    const vBvas = this.bvas.validate(candidate, { gte: this.self.gte, votes: yes });
    if (vBvas.score < this.cfg.cdcp.bvasGate) {
      return { status: 'BVAS_REJECTED', vBvas };
    }

    const block = this.ltm.commit(candidate);
    this.rrc.indexBlock(block);
    this.stm.markPromoted(nom.nomination.claim_id);
    // Committed claim becomes collective grounded truth — G_K grows (paper §3.5).
    for (const v of this.voters) {
      v.gte.addGrounded(candidate.claim_text);
      v.ese.addExample(candidate.claim_text, 1);
    }
    return { status: 'PROMOTED', block, vBvas: vBvas.score, consolidatedConf, votes: yes };
  }

  /** §8.3 — retrograde protection / temporal-conflict resolution (Proof P44). */
  resolveTemporalConflict(incumbentBlock, challengerVotes, totalVotesCast) {
    const cfg = this.cfg;
    if (totalVotesCast < cfg.retrograde.thetaResolutionVotes) {
      return { status: 'PENDING_RESOLUTION', votesNeeded: cfg.retrograde.thetaResolutionVotes };
    }
    const incumbentScore = incumbentBlock.consensus_votes.reduce((s, v) => s + v.vote_score, 0) * cfg.retrograde.kappa;
    const challengerScore = challengerVotes.filter((v) => v.vote === 'YES').reduce((s, v) => s + v.vote_score, 0);
    return challengerScore > incumbentScore
      ? { status: 'CHALLENGER_WINS', incumbentScore, challengerScore }
      : { status: 'INCUMBENT_WINS', incumbentScore, challengerScore };
  }
}

CDCP.STATES = STATES;
CDCP.Validator = Validator;
module.exports = CDCP;
