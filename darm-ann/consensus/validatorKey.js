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

  /**
   * Derive a deterministic Ed25519 key from a 32-byte seed. Lets separate
   * processes in a cluster independently reconstruct the *same* validator set
   * (everyone's public keys) from a shared master seed + index.
   */
  static fromSeed(seed32) {
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed32).subarray(0, 32)]);
    const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    const publicKey = crypto.createPublicKey(privateKey);
    return new ValidatorKey({ publicKey, privateKey });
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
