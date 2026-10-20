'use strict';

const crypto = require('crypto');
const ValidatorKey = require('../consensus/validatorKey');

/**
 * Autonomous Cognitive System (ACS) — DARM-ANN v7.2 Part II §2.2.
 *
 * Each DARM-ANN deployment registers as an ACS: an Ed25519 keypair whose public
 * key IS the identity (ACSN — no registry authority; sybil resistance is
 * economic, Part IV). Instead of IP prefixes, an ACS advertises signed
 * *capability records* (§2.2) and carries an explicit peering policy (§2.3).
 *
 * Reuses consensus/validatorKey.js for the Ed25519 identity so ACS identity,
 * validator identity, and confidential-execution sortition all share one
 * cryptographic backbone.
 */

/** Upper bound on an advertisement's lifetime (TTL-scoped, §2.4). */
const MAX_TTL_MS = 60 * 60 * 1000;
/** Tolerated clock skew for `issuedAt` in the future. */
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
/** Largest serialized record accepted (bounds RIB memory per peer). */
const MAX_RECORD_BYTES = 16 * 1024;

class ACS {
  /**
   * @param {object} opts
   *   key         — a ValidatorKey (reused); generated if absent
   *   name        — human label
   *   peering     — { mode: 'open'|'selective', allow:Set, deny:Set } (§2.3)
   */
  constructor({ key = null, name = null, peering = {} } = {}) {
    this.key = key || new ValidatorKey();
    // ACSN: the public key is the identity (§2.2). Short form = key address.
    this.acsn = this.key.address;
    this.publicKeyB64 = this.key.publicKeyB64;
    this.name = name || `acs-${this.acsn.slice(0, 8)}`;
    this.peering = { mode: peering.mode || 'open', allow: new Set(peering.allow || []), deny: new Set(peering.deny || []) };
    this.advertisements = new Map(); // capabilityId -> signed advertisement record
    this.seq = 0;
  }

  /** Deterministic ACS from a seed (for reproducible multi-process demos). */
  static fromSeed(seed32, opts = {}) {
    return new ACS({ ...opts, key: ValidatorKey.fromSeed(seed32) });
  }

  /**
   * Sign a capability advertisement (§2.2). The signed body binds the ACSN so a
   * relay/peer can verify authenticity (RPKI-equivalent, but behavioral —
   * Part VI route-hijack defense).
   *   capability = { model_classes[], memory_domains[], gpu_tiers[],
   *                  latency_class, trust_score, price_curve, sync_classes[],
   *                  conf_classes[] }
   *   ttlMs      — advertisement lifetime; expired ads are ignored (§2.4 TTL-scoped)
   */
  advertise(capability, { ttlMs = 5 * 60 * 1000 } = {}) {
    if (!(ttlMs > 0 && ttlMs <= MAX_TTL_MS)) throw new Error(`ttlMs must be in (0, ${MAX_TTL_MS}]`);
    const now = Date.now();
    const body = {
      type: 'ADVERTISE',
      acsn: this.acsn,
      seq: this.seq++,
      capability,
      issuedAt: now,
      expiresAt: now + ttlMs,
    };
    const signature = this.key.sign(ACS.canonicalBytes(body));
    const record = { ...body, publicKey: this.publicKeyB64, signature, id: ACS.capabilityId(this.acsn, capability) };
    this.advertisements.set(record.id, record);
    return record;
  }

  /** WITHDRAW — revoke a previously-advertised capability (§2.4). */
  withdraw(capabilityId) {
    const ad = this.advertisements.get(capabilityId);
    this.advertisements.delete(capabilityId);
    if (!ad) return null;
    const body = { type: 'WITHDRAW', acsn: this.acsn, seq: this.seq++, capabilityId, issuedAt: Date.now() };
    return { ...body, publicKey: this.publicKeyB64, signature: this.key.sign(ACS.canonicalBytes(body)) };
  }

  /** Peering decision for a candidate ACSN (§2.3 allow/deny/transit). */
  peersWith(acsn) {
    if (this.peering.deny.has(acsn)) return false;
    if (this.peering.mode === 'open') return true;
    return this.peering.allow.has(acsn);
  }

  activeAdvertisements(now = Date.now()) {
    return [...this.advertisements.values()].filter((a) => a.expiresAt > now);
  }

  // ── static helpers ────────────────────────────────────────────────────────

  static canonicalBytes(body) {
    // Stable field order for signing/verification (excludes signature/publicKey).
    return Buffer.from(JSON.stringify(body));
  }

  static capabilityId(acsn, capability) {
    return 'cap:' + crypto.createHash('sha256').update(acsn + '|' + JSON.stringify(capability)).digest('hex').slice(0, 24);
  }

  /** The ACSN a public key owns: the identity IS the key (§2.2). */
  static acsnOf(publicKeyB64) {
    return crypto.createHash('sha256').update(publicKeyB64).digest('hex').slice(0, 32);
  }

  /**
   * Verify an ADVERTISE/WITHDRAW record: signature, that the claimed `acsn`
   * belongs to the signing key (otherwise anyone could advertise — or
   * WITHDRAW — capabilities as someone else: a route hijack), bounded
   * size, and for ADVERTISE a mandatory, bounded, not-yet-expired lifetime
   * that did not start in the future, and an id matching its content.
   * Pass `now = null` to skip the freshness checks (WITHDRAW).
   */
  static verifyAdvertisement(record, now = Date.now()) {
    if (!record || typeof record !== 'object') return false;
    if (typeof record.publicKey !== 'string' || typeof record.signature !== 'string') return false;
    if (record.type !== 'ADVERTISE' && record.type !== 'WITHDRAW') return false;
    let size;
    try {
      size = Buffer.byteLength(JSON.stringify(record));
    } catch (_e) {
      return false;
    }
    if (size > MAX_RECORD_BYTES) return false;
    if (record.acsn !== ACS.acsnOf(record.publicKey)) return false;
    if (!Number.isSafeInteger(record.seq) || record.seq < 0) return false;
    if (record.type === 'ADVERTISE') {
      const { issuedAt, expiresAt } = record;
      if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return false;
      if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TTL_MS) return false;
      if (record.id !== ACS.capabilityId(record.acsn, record.capability)) return false;
      if (now != null && (expiresAt <= now || issuedAt > now + MAX_CLOCK_SKEW_MS)) return false;
    }
    const { publicKey, signature, id, ...body } = record;
    return ValidatorKey.verify(ACS.canonicalBytes(body), signature, publicKey);
  }
}

ACS.MAX_TTL_MS = MAX_TTL_MS;
ACS.MAX_CLOCK_SKEW_MS = MAX_CLOCK_SKEW_MS;
ACS.MAX_RECORD_BYTES = MAX_RECORD_BYTES;

module.exports = ACS;
