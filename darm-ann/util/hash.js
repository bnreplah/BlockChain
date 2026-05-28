'use strict';

const crypto = require('crypto');

/** SHA-256 hex digest of the joined parts (paper uses SHA-256 for claim_id). */
function sha256(...parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

/**
 * claim_id = SHA-256(claim_text + timestamp + node_id)  (STM schema, §3.4).
 */
function claimId(claimText, timestamp, nodeId) {
  return sha256(claimText, String(timestamp), String(nodeId));
}

module.exports = { sha256, claimId };
