'use strict';

const ACS = require('./acs');

/**
 * Routing Information Base (RIB) — the ledger-anchored capability directory
 * (DARM-ANN v7.2 §2.3: "no directory authority"). Holds verified, unexpired
 * ADVERTISE records keyed by ACSN, plus the peering topology used to build the
 * routing graph. There is no central directory: every node keeps its own RIB
 * fed by GOSSIP.
 *
 * The graph vertices are ACSNs; an edge (a→b) exists iff `a` peers with `b` and
 * `b` currently advertises at least one capability. Edge attributes carry the
 * neighbour's advertised latency_class, price_curve, and trust_score — the
 * inputs to the DIRP-1 path-selection objective (§2.4).
 */
class RIB {
  constructor() {
    this.ads = new Map(); // acsn -> Map(capabilityId -> record)
    this.peers = new Map(); // acsn -> Set(neighbourAcsn)   (directed peering)
    this.acsInfo = new Map(); // acsn -> { name, publicKey }
  }

  /** Ingest a signed ADVERTISE (from GOSSIP or a direct peer). */
  ingestAdvertise(record, now = Date.now()) {
    if (!ACS.verifyAdvertisement(record, now)) return { ok: false, reason: 'invalid or expired advertisement' };
    if (!this.ads.has(record.acsn)) this.ads.set(record.acsn, new Map());
    // Reject stale seq for the same capability id (replay/rollback protection).
    const existing = this.ads.get(record.acsn).get(record.id);
    if (existing && existing.seq > record.seq) return { ok: false, reason: 'stale seq' };
    this.ads.get(record.acsn).set(record.id, record);
    this.acsInfo.set(record.acsn, { publicKey: record.publicKey });
    return { ok: true, id: record.id };
  }

  /** Ingest a signed WITHDRAW. */
  ingestWithdraw(record) {
    if (!ACS.verifyAdvertisement(record, 0)) return { ok: false, reason: 'invalid withdraw' };
    const m = this.ads.get(record.acsn);
    if (m) m.delete(record.capabilityId);
    return { ok: true };
  }

  /** Record a directed peering edge a→b (from ACS peering policy exchange). */
  addPeering(a, b) {
    if (!this.peers.has(a)) this.peers.set(a, new Set());
    this.peers.get(a).add(b);
  }

  removePeering(a, b) {
    if (this.peers.has(a)) this.peers.get(a).delete(b);
  }

  /** All currently-valid advertisements for an ACSN. */
  adsFor(acsn, now = Date.now()) {
    const m = this.ads.get(acsn);
    if (!m) return [];
    return [...m.values()].filter((r) => r.expiresAt > now);
  }

  /** ACSNs advertising a capability matching `predicate(capability)`. */
  advertisersOf(predicate, now = Date.now()) {
    const out = [];
    for (const [acsn, m] of this.ads) {
      for (const r of m.values()) {
        if (r.expiresAt > now && predicate(r.capability)) { out.push({ acsn, record: r }); break; }
      }
    }
    return out;
  }

  /** Best (highest trust_score) capability an ACSN advertises matching predicate. */
  bestCapability(acsn, predicate, now = Date.now()) {
    let best = null;
    for (const r of this.adsFor(acsn, now)) {
      if (predicate(r.capability) && (!best || (r.capability.trust_score || 0) > (best.capability.trust_score || 0))) best = r;
    }
    return best;
  }

  neighbours(acsn) {
    return this.peers.has(acsn) ? [...this.peers.get(acsn)] : [];
  }

  stats() {
    let ads = 0;
    for (const m of this.ads.values()) ads += m.size;
    let edges = 0;
    for (const s of this.peers.values()) edges += s.size;
    return { acsCount: this.ads.size, advertisements: ads, peeringEdges: edges };
  }
}

module.exports = RIB;
