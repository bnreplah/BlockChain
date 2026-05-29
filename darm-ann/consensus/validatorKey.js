'use strict';

const crypto = require('crypto');

/**
 * Ed25519 validator identity. Real asymmetric cryptography (Node's built-in
 * crypto, no deps): votes are signed and verified so consensus messages are
 * unforgeable — the cryptographic backbone of BFT, replacing any trust
 * assumption between voters.
 */
class ValidatorKey {
  constructor(keyPair) {
    if (keyPair) {
      this.publicKey = keyPair.publicKey;
      this.privateKey = keyPair.privateKey;
    } else {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      this.publicKey = publicKey;
      this.privateKey = privateKey;
    }
    this.publicKeyB64 = this.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    // Node address = hash of the public key (like a chain address).
    this.address = crypto.createHash('sha256').update(this.publicKeyB64).digest('hex').slice(0, 32);
  }

  sign(messageBuffer) {
    return crypto.sign(null, messageBuffer, this.privateKey).toString('base64');
  }

  static verify(messageBuffer, signatureB64, publicKeyB64) {
    try {
      const pub = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
      return crypto.verify(null, messageBuffer, pub, Buffer.from(signatureB64, 'base64'));
    } catch (_e) {
      return false;
    }
  }
}

module.exports = ValidatorKey;
