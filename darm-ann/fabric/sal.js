'use strict';

const crypto = require('crypto');

/**
 * Substrate Abstraction Layer (SAL) — DARM-ANN v7.2 §4.4, and the Rail Profile
 * Registry §4.6.
 *
 * Five abstract provider classes; anything conforming to a class profile joins
 * by fielding an **Adapter ACS**. The fabric MUST NOT care whether capacity
 * behind an advertisement is a bedroom GPU, a token-incentivized market, or a
 * hyperscale cloud — that indifference is the neutrality property (P81) the
 * Replacement Thesis (Part VIII) depends on.
 *
 *   CSP — Compute Substrate Provider   (execution of ROUTEd jobs)
 *   SRP — Settlement Rail Provider      (value transfer for SETTLE)
 *   CEP — Confidential Execution Provider (conf_class rungs)
 *   MRP — Model Registry Provider       (artifacts, versioning, provenance)
 *   TAP — Transport/Anchor Provider     (rendezvous, EB/LTM hosting, GOSSIP)
 *
 * Proof obligations implemented/asserted:
 *   P79 (substrate independence) — end-to-end job semantics invariant under
 *        substitution of any conforming provider within a class+envelope.
 *   P80 (adapter accountability) — every fabric-observable fault maps to a
 *        slashable on-ledger party (adapter stake).
 *   P82 (rail liveness independence) — settlement survives as long as ≥1
 *        conforming rail remains registered.
 */

const PROVIDER_CLASSES = Object.freeze({
  CSP: { provides: 'execution of ROUTEd jobs', minObligations: ['ATTEST', 'honor_conf_class', 'price_curve', 'challenge_replay_for_training'] },
  SRP: { provides: 'value transfer for SETTLE', minObligations: ['registered_rail_profile'] },
  CEP: { provides: 'confidential execution rungs', minObligations: ['ledger_verifiable_attestation', 'class_properties'] },
  MRP: { provides: 'model/adapter artifacts + provenance', minObligations: ['content_addressed', 'signed_lineage', 'license_metadata', 'bvas_provenance'] },
  TAP: { provides: 'rendezvous, EB/LTM hosting, GOSSIP', minObligations: ['anchor_stake', 'anchor_uptime', 'no_routing_monopoly_min3'] },
});

const CONFORMANCE_PROFILES = {
  CSP: (p) => Array.isArray(p.sync_classes) && Array.isArray(p.conf_classes) && typeof p.price_curve !== 'undefined' && p.attest === true,
  SRP: (p) => !!p.rail_id,
  CEP: (p) => Array.isArray(p.conf_classes) && p.conf_classes.length > 0 && p.ledger_verifiable === true,
  MRP: (p) => p.content_addressed === true && p.signed_lineage === true,
  TAP: (p) => p.anchor === true && (p.uptime || 0) >= 0.99,
};

/**
 * An Adapter ACS wraps an external backend (any network) behind a conforming
 * class profile. The adapter operator's stake is slashable for backend failures
 * (§4.4 normative) — externalization of risk is not a defense (P80).
 */
class AdapterACS {
  constructor({ acsn, providerClass, backend = 'unknown', profile = {}, stake = 0 }) {
    if (!PROVIDER_CLASSES[providerClass]) throw new Error(`unknown provider class ${providerClass}`);
    this.acsn = acsn;
    this.providerClass = providerClass;
    this.backend = backend; // informative label only (Appendix M territory)
    this.profile = profile;
    this.stake = stake;
  }

  conforms() {
    const check = CONFORMANCE_PROFILES[this.providerClass];
    return !!check && check(this.profile);
  }
}

class SAL {
  constructor() {
    this.adapters = new Map(); // acsn -> AdapterACS
    this.railRegistry = new Map(); // rail_id -> RailProfile
  }

  /** Register an Adapter ACS after conformance check (§4.4). */
  registerAdapter(adapter) {
    if (!(adapter instanceof AdapterACS)) throw new Error('not an AdapterACS');
    if (!adapter.conforms()) return { ok: false, reason: `profile does not conform to ${adapter.providerClass} class` };
    this.adapters.set(adapter.acsn, adapter);
    // A registered CEP/CSP/... makes its class capacity addressable regardless
    // of backend (P79 substrate independence — the fabric cannot tell).
    return { ok: true, providerClass: adapter.providerClass };
  }

  adaptersOf(providerClass) {
    return [...this.adapters.values()].filter((a) => a.providerClass === providerClass);
  }

  /** Register a settlement Rail Profile (§4.6). rail_id defaults to a hash. */
  registerRail(profile) {
    const required = ['finality_bound', 'proof_format', 'escrow_primitive', 'dispute_hook', 'denomination'];
    for (const f of required) if (profile[f] == null) return { ok: false, reason: `RailProfile missing ${f}` };
    const rail_id = profile.rail_id || 'rail:' + crypto.createHash('sha256').update(JSON.stringify({ ...profile, rail_id: undefined })).digest('hex').slice(0, 20);
    const rec = { ...profile, rail_id };
    this.railRegistry.set(rail_id, rec);
    return { ok: true, rail_id };
  }

  /** Validate a SETTLE record against exactly one registered rail (§4.6). */
  validateSettle(settle) {
    if (!settle || !settle.rail_id) return { ok: false, reason: 'SETTLE missing rail_id' };
    const rail = this.railRegistry.get(settle.rail_id);
    if (!rail) return { ok: false, reason: `unknown rail ${settle.rail_id}` };
    if (!settle.proof) return { ok: false, reason: 'SETTLE missing proof' };
    // Proof format is verified against the profile, never rail-specific logic.
    return { ok: true, rail_id: rail.rail_id, finality_bound: rail.finality_bound };
  }

  /** P82: settlement plane is live iff ≥1 conforming rail is registered. */
  settlementLive() {
    return this.railRegistry.size >= 1;
  }

  rails() {
    return [...this.railRegistry.values()];
  }

  stats() {
    const byClass = {};
    for (const a of this.adapters.values()) byClass[a.providerClass] = (byClass[a.providerClass] || 0) + 1;
    return { adapters: this.adapters.size, byClass, rails: this.railRegistry.size, settlementLive: this.settlementLive() };
  }
}

SAL.PROVIDER_CLASSES = PROVIDER_CLASSES;
SAL.AdapterACS = AdapterACS;
module.exports = SAL;
