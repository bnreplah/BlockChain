'use strict';

const { tokenize } = require('../util/embedding');

/**
 * NgramLM — a real statistical small language model (SLM): an n-gram model
 * with add-k (Laplace) smoothing. Genuinely estimates P(token | history) from
 * observed text and yields sequence log-likelihood / perplexity. Used alongside
 * the neural TinyLM as a second "held-within" model the registry can route to
 * (e.g., for scoring how linguistically plausible a candidate path's text is).
 */
class NgramLM {
  constructor({ n = 2, k = 0.5 } = {}) {
    this.n = n;
    this.k = k;
    this.counts = new Map(); // context -> Map(token -> count)
    this.ctxTotals = new Map(); // context -> Σ
    this.vocab = new Set();
  }

  _ctxKey(tokens) {
    return tokens.slice(-(this.n - 1)).join(' ');
  }

  train(text) {
    const toks = ['<s>', ...tokenize(text), '</s>'];
    for (const t of toks) this.vocab.add(t);
    for (let i = this.n - 1; i < toks.length; i++) {
      const ctx = this._ctxKey(toks.slice(0, i));
      const tok = toks[i];
      if (!this.counts.has(ctx)) this.counts.set(ctx, new Map());
      const m = this.counts.get(ctx);
      m.set(tok, (m.get(tok) || 0) + 1);
      this.ctxTotals.set(ctx, (this.ctxTotals.get(ctx) || 0) + 1);
    }
    return this;
  }

  /** Smoothed P(token | context tokens). */
  prob(contextTokens, token) {
    const ctx = this._ctxKey(contextTokens);
    const m = this.counts.get(ctx);
    const V = Math.max(1, this.vocab.size);
    const count = m ? m.get(token) || 0 : 0;
    const total = this.ctxTotals.get(ctx) || 0;
    return (count + this.k) / (total + this.k * V);
  }

  /** Mean log-probability of a sequence (higher = more plausible). */
  logLikelihood(text) {
    const toks = ['<s>', ...tokenize(text), '</s>'];
    let ll = 0;
    let n = 0;
    for (let i = this.n - 1; i < toks.length; i++) {
      ll += Math.log(this.prob(toks.slice(0, i), toks[i]));
      n += 1;
    }
    return n === 0 ? -Infinity : ll / n;
  }

  perplexity(text) {
    return Math.exp(-this.logLikelihood(text));
  }
}

module.exports = NgramLM;
