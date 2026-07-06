'use strict';

const crypto = require('crypto');

/**
 * Compute Contribution & Incentive Layer (CCIL) — DARM-ANN v7.2 Part IV.
 *
 * Roles + elevation ladder (§4.2):
 *   LEAF → RELAY → ANCHOR → VALIDATOR
 * Elevation/demotion are ledger events; slashing on false ATTEST, CDCP
 * equivocation, or sustained SLA breach (§4.2).
 *
 * Proof-of-Useful-Inference (PoUI, §4.3), tiered by cost:
 *   1 redundant spot-execution — duplicate with prob q; divergence → BVAS arbitration.
 *   2 TinyLM verifier plane — semantic sanity / refusal-of-work (ESE applied to economics).
 *   3 deterministic replay for training jobs.
 *   4 attested / ZK execution (highest tier).
 *
 * Proof obligations implemented as testable code:
 *   P66/P67 — PoUI soundness: P(undetected fraud over k jobs) ≤ (1−q)^k.
 *   P68 — incentive compatibility: honest is dominant when stake S ≥ S_min(q,payoff),
 *         i.e. slashing loss strictly exceeds expected cheating payoff.
 */

const ROLES = Object.freeze({
  LEAF: { rank: 1, requires: {}, hosts: [] },
  RELAY: { rank: 2, requires: { uptime30d: 0.95 }, hosts: ['route'] },
  ANCHOR: { rank: 3, requires: { stake: 'S_a', uptime: 0.99, bvasMin: 'V_min' }, hosts: ['EB', 'LTM', 'checkpoints', 'GOSSIP'] },
  VALIDATOR: { rank: 4, requires: { anchor: true, sortition: true }, hosts: ['CDCP'] },
});

const ROLE_ORDER = ['LEAF', 'RELAY', 'ANCHOR', 'VALIDATOR'];

class CCIL {
  constructor({ stakeMin = 100, uptimeAnchor = 0.99, bvasMin = 0.6, q = 0.15 } = {}) {
    this.stakeMin = stakeMin;
    this.uptimeAnchor = uptimeAnchor;
    this.bvasMin = bvasMin;
    this.q = q; // redundant spot-execution probability
    this.members = new Map(); // acsn -> { role, stake, uptime, bvas, earnings, slashed }
    this.ledger = []; // elevation/demotion/slash events (append-only)
    this._rng = (() => { let s = 0xC0FFEE; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
  }

  attach(acsn, { stake = 0, uptime = 0, bvas = 0 } = {}) {
    if (!this.members.has(acsn)) this.members.set(acsn, { role: 'LEAF', stake, uptime, bvas, earnings: 0, slashed: 0 });
    else Object.assign(this.members.get(acsn), { stake, uptime, bvas });
    return this.members.get(acsn);
  }

  /** Which role an ACS currently QUALIFIES for, given its metrics (§4.2). */
  qualifiesFor(acsn) {
    const m = this.members.get(acsn);
    if (!m) return null;
    if (m.stake >= this.stakeMin && m.uptime >= this.uptimeAnchor && m.bvas >= this.bvasMin) return 'ANCHOR';
    if (m.uptime >= 0.95) return 'RELAY';
    return 'LEAF';
  }

  /** Elevate/demote to the qualified role; records a ledger event. */
  reconcile(acsn) {
    const m = this.members.get(acsn);
    if (!m) return null;
    const target = this.qualifiesFor(acsn);
    if (target !== m.role) {
      const event = { t: ROLES[target].rank > ROLES[m.role].rank ? 'ELEVATE' : 'DEMOTE', acsn, from: m.role, to: target, at: Date.now() };
      m.role = target;
      this.ledger.push(event);
      return event;
    }
    return null;
  }

  /** Validator election via stake-weighted sortition (§4.2, rotating). */
  electValidators(k, seed = null) {
    const anchors = [...this.members.entries()].filter(([, m]) => m.role === 'ANCHOR' || m.role === 'VALIDATOR');
    if (anchors.length === 0) return [];
    const totalStake = anchors.reduce((s, [, m]) => s + Math.max(1, m.stake), 0);
    const rng = seed != null ? _seededRng(seed) : this._rng;
    const chosen = [];
    const pool = anchors.slice();
    for (let i = 0; i < Math.min(k, pool.length); i++) {
      let r = rng() * pool.reduce((s, [, m]) => s + Math.max(1, m.stake), 0);
      let idx = 0;
      for (; idx < pool.length; idx++) { r -= Math.max(1, pool[idx][1].stake); if (r <= 0) break; }
      const [acsn] = pool.splice(Math.min(idx, pool.length - 1), 1)[0];
      chosen.push(acsn);
      this.members.get(acsn).role = 'VALIDATOR';
      this.ledger.push({ t: 'ELECT_VALIDATOR', acsn, at: Date.now() });
    }
    return chosen;
  }

  slash(acsn, reason, amount = null) {
    const m = this.members.get(acsn);
    if (!m) return null;
    const amt = amount != null ? amount : m.stake; // full slash by default
    m.stake = Math.max(0, m.stake - amt);
    m.slashed += amt;
    const event = { t: 'SLASH', acsn, reason, amount: amt, at: Date.now() };
    this.ledger.push(event);
    this.reconcile(acsn);
    return event;
  }

  credit(acsn, amount) {
    const m = this.members.get(acsn);
    if (m) m.earnings += amount;
    return m ? m.earnings : 0;
  }

  role(acsn) {
    const m = this.members.get(acsn);
    return m ? m.role : null;
  }

  stats() {
    const byRole = { LEAF: 0, RELAY: 0, ANCHOR: 0, VALIDATOR: 0 };
    for (const m of this.members.values()) byRole[m.role] = (byRole[m.role] || 0) + 1;
    return { members: this.members.size, byRole, ledgerEvents: this.ledger.length, q: this.q };
  }

  // ── PoUI (§4.3) ────────────────────────────────────────────────────────────

  /** Tier-1: should this job be silently duplicated for spot-check? (prob q) */
  shouldSpotCheck() {
    return this._rng() < this.q;
  }

  /** Tier-1 arbitration: compare two executor outputs within a tolerance. */
  static spotCheck(outputA, outputB, tolerance = 0) {
    const same = JSON.stringify(outputA) === JSON.stringify(outputB);
    return { agree: same, divergent: !same, needsBvasArbitration: !same && tolerance === 0 };
  }

  /** P67: probability that fraud goes undetected over k spot-checked jobs. */
  undetectedFraudProbability(k) {
    return Math.pow(1 - this.q, k);
  }

  /**
   * P68: minimum stake so honest execution dominates. Cheating expected payoff
   * = (1−q)·gain − q·slash < 0 requires slash > (1−q)/q · gain. Return S_min.
   */
  minStakeForIncentiveCompatibility(cheatGain) {
    return ((1 - this.q) / Math.max(this.q, 1e-9)) * cheatGain;
  }

  /** Is honest execution the dominant strategy for a member given a cheat gain? */
  isIncentiveCompatible(acsn, cheatGain) {
    const m = this.members.get(acsn);
    if (!m) return false;
    return m.stake > this.minStakeForIncentiveCompatibility(cheatGain);
  }
}

function _seededRng(seed) {
  let s = (typeof seed === 'number' ? seed : parseInt(crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 8), 16)) >>> 0;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

CCIL.ROLES = ROLES;
CCIL.ROLE_ORDER = ROLE_ORDER;
module.exports = CCIL;
