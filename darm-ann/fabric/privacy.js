'use strict';

const crypto = require('crypto');

/**
 * Privacy Plane — DARM-ANN v7.2 Part III (infrastructure-level onion routing)
 * and the Confidential-Execution Ladder.
 *
 * privacy_mode ∈ { direct, relay, onion } (§III):
 *   direct — plaintext-to-TLS; lowest latency; trusted intra-subnet.
 *   relay  — single-hop indirection; hides origin from destination.
 *   onion  — layered encryption across ≥3 relay ACSs (P65). Rung-0 `redact` is
 *            MANDATORY in onion mode.
 *
 * Confidential-execution ladder — each conf_class is defined by ADVERSARY MODEL
 * and verifiable PROPERTIES, never by vendor/product (§III normative):
 *   0 redact   — identifier stripping by an origin-local WM-tier model; MANDATORY in onion
 *   1 attested — isolated execution + per-job attestation of code identity + I/O sealing
 *   2 blind    — multi-party exec, no single executor holds plaintext; stake-disjoint sortition (P75)
 *   3 sealed   — execution over encrypted inputs; no plaintext outside origin
 *
 * The real onion layering below uses X25519 ECDH per hop (Node crypto). The
 * paper specifies X25519 wrapped in ML-KEM-768 (hybrid PQ). Node has no ML-KEM
 * primitive; this is the ONE cryptographic stand-in in the fabric layer — the
 * layering, per-hop key separation, padding, and unwrap semantics are real, and
 * the KEM slot is clearly marked for a hybrid upgrade.
 */

const CONF_CLASSES = Object.freeze({
  redact: { rung: 0, adversary: 'honest-but-curious executor learning identity', trustRoot: 'origin ACS only', cost: 'free' },
  attested: { rung: 1, adversary: 'executor operator', trustRoot: 'isolation vendor (defense-in-depth only)', cost: 'low' },
  blind: { rung: 2, adversary: 'any single executor; colluding minority below stake-overlap bound', trustRoot: 'non-collusion, economically enforced', cost: 'medium-high' },
  sealed: { rung: 3, adversary: 'all executors', trustRoot: 'cryptography only', cost: 'highest' },
});

const PRIVACY_MODES = new Set(['direct', 'relay', 'onion']);
const ONION_MIN_RELAYS = 3; // P65: ≥3 non-colluding relays
const PAD_CLASSES = [256, 512, 1024, 2048, 4096, 8192, 16384]; // power-of-two size classes (§III padding)

function isConfClass(c) {
  return Object.prototype.hasOwnProperty.call(CONF_CLASSES, c);
}

function rungOf(c) {
  return CONF_CLASSES[c] ? CONF_CLASSES[c].rung : -1;
}

/** Rung-0 redaction: strip identifiers before egress (mandatory in onion mode).
 *  A WM-tier stand-in: removes emails, IPs, and long digit runs. */
function redact(text) {
  return String(text)
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '<email>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
    .replace(/\b\d{6,}\b/g, '<num>');
}

/** Validate a (privacy_mode, conf_class, hops) combination against §III rules. */
function validate({ privacy_mode = 'direct', conf_class = 'redact', hops = 0 } = {}) {
  if (!PRIVACY_MODES.has(privacy_mode)) return { ok: false, reason: `unknown privacy_mode ${privacy_mode}` };
  if (!isConfClass(conf_class)) return { ok: false, reason: `unknown conf_class ${conf_class}` };
  if (privacy_mode === 'onion') {
    if (hops < ONION_MIN_RELAYS) return { ok: false, reason: `onion mode requires ≥${ONION_MIN_RELAYS} relays (P65), got ${hops}` };
    // Rung-0 redact is mandatory (composes with every rung).
  }
  return { ok: true };
}

/** Pad a payload to the smallest power-of-two size class ≥ its length (§III). */
function padToSizeClass(buf) {
  const cls = PAD_CLASSES.find((c) => c >= buf.length) || PAD_CLASSES[PAD_CLASSES.length - 1];
  if (buf.length >= cls) return buf;
  return Buffer.concat([buf, Buffer.alloc(cls - buf.length)]);
}

// ── Onion layering (real X25519 per-hop; KEM slot marked for ML-KEM upgrade) ──

/** A relay identity: an X25519 keypair. Its public key is what the sender wraps to. */
function newRelayIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    privateKey,
    publicKeyRaw: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

function _deriveKey(myPriv, theirPubB64) {
  const theirPub = crypto.createPublicKey({ key: Buffer.from(theirPubB64, 'base64'), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey: myPriv, publicKey: theirPub });
  return crypto.createHash('sha256').update(shared).digest(); // 32-byte AES key
}

function _seal(keyBuf, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

function _open(keyBuf, blob) {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Build an onion: wrap `payload` in one layer per relay (outermost = first relay).
 * `relays` = [{ acsn, publicKeyRaw }] ordered origin→...→exit. Rung-0 redaction
 * is applied to the innermost payload (mandatory in onion mode).
 * Returns { onion, ephemerals } — ephemerals[i] is the sender pubkey for relay i.
 */
function buildOnion(payloadText, relays) {
  if (relays.length < ONION_MIN_RELAYS) throw new Error(`onion needs ≥${ONION_MIN_RELAYS} relays`);
  // innermost = redacted payload + exit marker, padded to a size class.
  let layer = padToSizeClass(Buffer.from(JSON.stringify({ exit: true, payload: redact(payloadText) })));
  const ephemerals = [];
  // Wrap from the LAST relay (exit) inward to the FIRST (entry).
  for (let i = relays.length - 1; i >= 0; i--) {
    const eph = crypto.generateKeyPairSync('x25519');
    const key = _deriveKey(eph.privateKey, relays[i].publicKeyRaw);
    const next = i + 1 < relays.length ? relays[i + 1].acsn : null;
    const framed = padToSizeClass(Buffer.from(JSON.stringify({ next, blob: _seal(key, layer).toString('base64') })));
    layer = framed;
    ephemerals[i] = eph.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  }
  return { onion: layer.toString('base64'), ephemerals };
}

/** A relay peels one layer: returns { next, inner } where inner is the next
 *  layer's bytes (base64) or, at the exit, the delivered payload. */
function peelOnion(relayPrivateKey, senderEphemeralB64, onionB64) {
  const key = _deriveKey(relayPrivateKey, senderEphemeralB64);
  const framed = JSON.parse(Buffer.from(onionB64, 'base64').toString('utf8').replace(/\0+$/, ''));
  const inner = _open(key, Buffer.from(framed.blob, 'base64'));
  // Is the inner an exit payload or another framed layer?
  let parsed;
  try { parsed = JSON.parse(inner.toString('utf8').replace(/\0+$/, '')); } catch (_e) { parsed = null; }
  if (parsed && parsed.exit) return { next: null, delivered: parsed.payload };
  return { next: framed.next, inner: inner.toString('base64') };
}

module.exports = {
  CONF_CLASSES, PRIVACY_MODES, ONION_MIN_RELAYS,
  isConfClass, rungOf, redact, validate, padToSizeClass,
  newRelayIdentity, buildOnion, peelOnion,
};
