'use strict';

/**
 * Consensus-Driven Consolidation Protocol (CDCP) — paper §5.
 *
 * The architectural heart of v6.0: an STM entry is promoted to LTM only when a
 * τ_c-quorum of independent nodes each validate it with their OWN local GTE +
 * ESE — no shared intermediate state (so Byzantine nodes cannot collude on
 * partial results, P40). This is what guarantees every LTM entry is collective
 * network truth, and bounds hallucination pass-through (P39).
 *
 *   Algorithm 12 — CDCP_Nominate
 *   Algorithm 13 — CDCP_Vote (per node, independent)
 *   Algorithm 14 — CDCP_Evaluate + LTM promotion
 *   §5.7         — new-node VoteWeight scaling
 *   §8.3         — retrograde protection / temporal-conflict resolution
 */

const STATES = Object.freeze({
  PENDING: 'PENDING',
  VOTING: 'VOTING',
  CONSENSUS: 'CONSENSUS',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
});

/**
 * A CDCP voter node. Owns its own GTE (local G_K) and ESE so its vote is
 * independent. §5.7 VoteWeight scales with G_K maturity.
 */
class Validator {
  constructor({ nodeId, gte, ese, stm = null }) {
    this.nodeId = nodeId;
    this.gte = gte;
    this.ese = ese;
    this.stm = stm;
  }

  voteWeight(gkThreshold) {
    return Math.min(1, this.gte.gkSize() / gkThreshold);
  }

  /** Algorithm 13 — independent evaluation against this node's own knowledge. */
  vote(nomination, cfg) {
    const w = cfg.cdcp.voteWeights;
    const localBfs = this.gte.bfsValidate(nomination.claim_text, nomination.embedding, cfg.gte.bfsK2);
    const localDfs = this.gte.dfsAudit(nomination.claim_text, nomination.embedding);
    const localUe = this.ese.estimateEpistemicUncertainty(nomination.embedding, this.gte);

    const localConsistency =
      localBfs.conflicts.length === 0
        ? 1
        : 1 - Math.max(...localBfs.conflicts.map((c) => c.weight));
    const localGrounded = localDfs.type === 'Grounded' ? 1 : 0;

    const voteScore =
      w.bfs * localBfs.score +
      w.grounded * localGrounded +
      w.consistency * localConsistency +
      w.certainty * (1 - localUe);

    return {
      claim_id: nomination.claim_id,
      node_id: this.nodeId,
      vote: voteScore >= cfg.cdcp.thetaVote ? 'YES' : 'NO',
      vote_score: voteScore,
      weight: this.voteWeight(cfg.cdcp.gkThreshold),
      evidence: { localBfs, localDfs, localUe },
    };
  }
}

class CDCP {
  constructor({ self, peers = [], ltm, rrc, stm, bvas, cfg }) {
    this.self = self; // local Validator (proposer also votes)
    this.peers = peers; // other Validators
    this.ltm = ltm;
    this.rrc = rrc;
    this.stm = stm;
    this.bvas = bvas;
    this.cfg = cfg;
    this.temporalConflicts = []; // §8.3 records
  }

  get voters() {
    return [this.self, ...this.peers];
  }

  /** Algorithm 12 — CDCP_Nominate. */
  nominate(stmEntry) {
    const cfg = this.cfg;
    if (stmEntry.salience < cfg.cdcp.thetaNominate) return { status: 'NOT_ELIGIBLE' };
    if (Date.now() - stmEntry.created_at < cfg.cdcp.tMinAgeMs) return { status: 'TOO_YOUNG' };
    if (this.ltm.contains(stmEntry.embedding, 0.97)) return { status: 'ALREADY_LTM' };

    const nomination = {
      claim_id: stmEntry.claim_id,
      claim_text: stmEntry.claim_text,
      embedding: stmEntry.embedding,
      proposer: this.self.nodeId,
      validation: stmEntry.validation,
      epistemic: stmEntry.epistemic_tuple,
      salience: stmEntry.salience,
      timestamp: Date.now(),
    };
    stmEntry.state = STATES.VOTING;
    return { status: 'NOMINATED', nomination };
  }

  /** Collect independent votes from all voters (Algorithm 13 × N). */
  collectVotes(nomination) {
    return this.voters.map((v) => v.vote(nomination, this.cfg));
  }

  /** Algorithm 14 — quorum evaluation + LTM promotion. */
  evaluate(nomination, votes) {
    const cfg = this.cfg;
    const yes = votes.filter((v) => v.vote === 'YES');
    const no = votes.filter((v) => v.vote === 'NO');
    const totalWeight = votes.reduce((s, v) => s + v.weight, 0) || 1;
    const yesWeight = yes.reduce((s, v) => s + v.weight, 0);
    const noWeight = no.reduce((s, v) => s + v.weight, 0);

    const quorumMet = yesWeight / totalWeight >= cfg.cdcp.tauC;
    if (!quorumMet) {
      if (noWeight / totalWeight >= 0.5) {
        return { status: 'REJECTED_CONTRADICTED', yesWeight, noWeight, totalWeight, votes };
      }
      return { status: 'INSUFFICIENT_VOTES', yesWeight, noWeight, totalWeight, votes };
    }

    // Inverse-uncertainty-weighted consolidated confidence over yes-voters.
    const consolidatedConf =
      yes.reduce((s, v) => s + v.vote_score * v.weight, 0) /
      (yes.reduce((s, v) => s + v.weight, 0) || 1);

    const candidate = {
      claim_text: nomination.claim_text,
      embedding: nomination.embedding,
      confidence: consolidatedConf,
      salience: nomination.salience,
      consensus_votes: yes,
      proposer: nomination.proposer,
      validation: { ...nomination.validation, voteCount: yes.length },
    };

    // BVAS gate (Stages 4–5) before final commit (§5.4 / §9.2).
    const vBvas = this.bvas.validate(candidate);
    if (vBvas < cfg.cdcp.bvasGate) {
      return { status: 'BVAS_REJECTED', vBvas, candidate, votes };
    }

    const block = this.ltm.commit(candidate); // → blockchain write
    this.rrc.indexBlock(block); // pre-compute O(1) retrieval entry
    this.stm.markPromoted(nomination.claim_id); // flag STM entry as consolidated
    return { status: 'PROMOTED', block, vBvas, consolidatedConf, yesWeight, totalWeight, votes };
  }

  /** Convenience: full nominate → vote → evaluate path for one STM entry. */
  runConsensus(stmEntry) {
    const nom = this.nominate(stmEntry);
    if (nom.status !== 'NOMINATED') return nom;
    const votes = this.collectVotes(nom.nomination);
    const result = this.evaluate(nom.nomination, votes);
    if (result.status !== 'PROMOTED') {
      // re-attempt accounting / rejection bookkeeping
      if (result.status === 'REJECTED_CONTRADICTED') {
        stmEntry.state = STATES.REJECTED;
      }
      stmEntry.retry_count = (stmEntry.retry_count || 0) + 1;
    }
    return result;
  }

  /**
   * §8.3 — Retrograde protection. A challenger must exceed the incumbent's
   * accumulated CDCP evidence by the incumbency factor κ to displace it
   * (Proof P44). Resolution only fires once enough votes have accrued.
   */
  resolveTemporalConflict(incumbentBlock, challengerVotes, totalVotesCast) {
    const cfg = this.cfg;
    if (totalVotesCast < cfg.retrograde.thetaResolutionVotes) {
      return { status: 'PENDING_RESOLUTION', votesNeeded: cfg.retrograde.thetaResolutionVotes };
    }
    const incumbentScore =
      incumbentBlock.consensus_votes.reduce((s, v) => s + v.vote_score * v.weight, 0) *
      cfg.retrograde.kappa;
    const challengerScore = challengerVotes
      .filter((v) => v.vote === 'YES')
      .reduce((s, v) => s + v.vote_score * v.weight, 0);

    if (challengerScore > incumbentScore) {
      return { status: 'CHALLENGER_WINS', incumbentScore, challengerScore };
    }
    return { status: 'INCUMBENT_WINS', incumbentScore, challengerScore };
  }
}

CDCP.STATES = STATES;
CDCP.Validator = Validator;
module.exports = CDCP;
