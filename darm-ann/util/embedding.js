'use strict';

const crypto = require('crypto');

/**
 * Deterministic embedding stand-in for the TinyLM embedder (paper §3.2/§3.4).
 *
 * The white paper assumes a sub-500M-param "TinyLM" produces d-dimensional
 * semantic embeddings. We have no model here, so we use the classic
 * **hashing trick**: tokens are hashed into the d buckets of a vector with
 * signed contributions, then L2-normalised. This is deterministic, fast, and
 * dependency-free, and it gives the rest of the system a real cosine geometry
 * to operate on (LSH, dedup, salience novelty all work unchanged).
 *
 * SWAP POINT: replace `embed()` with a call to a real sentence-embedding model
 * (e.g. all-MiniLM-L6-v2 → d=384) and the entire hierarchy works as specified.
 */

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Stable 32-bit hash of a token → [bucketIndex, sign].
function hashToken(token, dim) {
  const h = crypto.createHash('sha256').update(token).digest();
  const bucket = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  const sign = h[4] & 1 ? 1 : -1;
  return [bucket % dim, sign];
}

/** embed(text) -> Float64Array(dim), L2-normalised. */
function embed(text, dim = 64) {
  const vec = new Float64Array(dim);
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    vec[0] = 1; // avoid the zero vector
    return vec;
  }
  for (const tok of tokens) {
    const [idx, sign] = hashToken(tok, dim);
    vec[idx] += sign;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

/** Cosine similarity of two equal-length normalised (or unnormalised) vectors. */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

module.exports = { embed, cosineSimilarity, tokenize };
