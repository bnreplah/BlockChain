'use strict';

const crypto = require('crypto');
const { rng, gaussian } = require('./network');
const { tokenize } = require('../util/embedding');

/**
 * A real word-embedding model: skip-gram with negative sampling (SGNS,
 * Mikolov et al., 2013) trained with genuine gradient descent. This replaces
 * the previous hashing-trick stand-in with an actual learned representation —
 * the embeddings improve as the network observes more text (a growing network).
 *
 * Sentence embedding = L2-normalised mean of the input-side token vectors.
 *
 * Determinism: each token's vector is initialised from a seed derived from the
 * token text, so an *untrained* model maps identical text to identical vectors
 * across nodes/runs (needed for cross-node consistency and stable cold-start
 * retrieval). Training then refines them; call reindex on dependent stores
 * after training so committed vectors track the model.
 */

function tokenSeed(token, salt) {
  const h = crypto.createHash('sha256').update(salt + ':' + token).digest();
  return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
}

class Embedder {
  constructor({ dim = 64, window = 2, negatives = 5, lr = 0.05, seed = 12345 } = {}) {
    this.dim = dim;
    this.window = window;
    this.negatives = negatives;
    this.lr = lr;
    this.seed = seed;
    this.vocab = new Map(); // token -> { in: Float64Array, out: Float64Array, count }
    this.tokensList = []; // index → token (for negative sampling)
    this.corpus = []; // observed token sequences (training material)
    this._neg = rng(seed ^ 0x9e3779b9);
    this.trainedSteps = 0;
  }

  _ensure(token) {
    let v = this.vocab.get(token);
    if (!v) {
      const rand = rng(tokenSeed(token, 'in'));
      const inv = new Float64Array(this.dim);
      for (let i = 0; i < this.dim; i++) inv[i] = gaussian(rand) * (1 / Math.sqrt(this.dim));
      v = { in: inv, out: new Float64Array(this.dim), count: 0 };
      this.vocab.set(token, v);
      this.tokensList.push(token);
    }
    return v;
  }

  /** Register text (adds tokens to vocab and to the training corpus). */
  observe(text) {
    const toks = tokenize(text);
    for (const t of toks) this._ensure(t).count += 1;
    if (toks.length) this.corpus.push(toks);
    return toks;
  }

  /** L2-normalised mean of input-side token vectors. */
  embed(text) {
    const toks = tokenize(text);
    const v = new Float64Array(this.dim);
    if (toks.length === 0) {
      v[0] = 1;
      return v;
    }
    let used = 0;
    for (const t of toks) {
      const e = this._ensure(t).in;
      for (let i = 0; i < this.dim; i++) v[i] += e[i];
      used += 1;
    }
    for (let i = 0; i < this.dim; i++) v[i] /= used;
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < this.dim; i++) v[i] /= norm;
    return v;
  }

  _dot(a, b) {
    let s = 0;
    for (let i = 0; i < this.dim; i++) s += a[i] * b[i];
    return s;
  }

  /** One SGNS update for a (center, context) pair plus k negative samples. */
  _sgnsStep(centerTok, contextTok) {
    const center = this._ensure(centerTok).in;
    const samples = [{ tok: contextTok, label: 1 }];
    for (let n = 0; n < this.negatives; n++) {
      const negTok = this.tokensList[Math.floor(this._neg() * this.tokensList.length)];
      if (negTok && negTok !== contextTok) samples.push({ tok: negTok, label: 0 });
    }
    const gradCenter = new Float64Array(this.dim);
    for (const s of samples) {
      const out = this._ensure(s.tok).out;
      const score = 1 / (1 + Math.exp(-this._dot(center, out)));
      const g = score - s.label; // dL/d(score) for logistic
      for (let i = 0; i < this.dim; i++) {
        gradCenter[i] += g * out[i];
        out[i] -= this.lr * g * center[i];
      }
    }
    for (let i = 0; i < this.dim; i++) center[i] -= this.lr * gradCenter[i];
    this.trainedSteps += 1;
  }

  /** Train skip-gram over the observed corpus for a number of epochs. */
  train({ epochs = 5 } = {}) {
    for (let e = 0; e < epochs; e++) {
      for (const toks of this.corpus) {
        for (let i = 0; i < toks.length; i++) {
          for (let j = Math.max(0, i - this.window); j <= Math.min(toks.length - 1, i + this.window); j++) {
            if (i === j) continue;
            this._sgnsStep(toks[i], toks[j]);
          }
        }
      }
    }
    return { steps: this.trainedSteps, vocab: this.vocab.size };
  }

  vocabSize() {
    return this.vocab.size;
  }
}

module.exports = Embedder;
