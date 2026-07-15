'use strict';

const { MLP } = require('../nn/network');

/**
 * Epistemic Skepticism Engine (ESE) — real implementation (paper §5, v5.0).
 *
 * Genuine learned epistemic reasoning, built on the from-scratch neural net:
 *
 *   • Deep ensemble (Lakshminarayanan et al., 2017): N independently-initialised
 *     MLP validity classifiers, each trained on a bootstrap resample of the
 *     teach/refute corpus. Predictive disagreement across the ensemble is a
 *     genuine measure of *epistemic* (model) uncertainty u_ep.
 *
 *   • Temperature scaling (Guo et al., 2017): a single scalar T learned by
 *     minimising NLL gives calibrated confidence conf_cal.
 *
 * Trains lazily: examples accumulate via addExample (teach → label 1, refute →
 * label 0) and the ensemble is (re)trained on first use after the corpus
 * changes. Each node owns its own ESE, so votes stay independent.
 */
class EpistemicSkepticismEngine {
  constructor({ embedder, dim = 64, ensemble = 3, hidden = 16, seed = 1 } = {}) {
    this.embedder = embedder;
    this.dim = dim;
    this.members = [];
    for (let i = 0; i < ensemble; i++) {
      this.members.push(new MLP({ sizes: [dim, hidden, 1], activations: ['relu', 'sigmoid'], lr: 0.05, seed: seed + i * 101 }));
    }
    this.examples = []; // { x: Float64Array, y: 0|1 }
    this.T = 1; // temperature
    this.dirty = false;
    this._rng = (() => {
      let a = (seed ^ 0x1234) >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();
  }

  addExample(text, label) {
    this.examples.push({ x: this.embedder.embed(text), y: [label] });
    this.dirty = true;
    return this;
  }

  _logit(p) {
    const c = Math.min(1 - 1e-6, Math.max(1e-6, p));
    return Math.log(c / (1 - c));
  }

  _bootstrap() {
    const n = this.examples.length;
    const sample = [];
    for (let i = 0; i < n; i++) sample.push(this.examples[Math.floor(this._rng() * n)]);
    return sample;
  }

  trainIfDirty({ epochs = 60 } = {}) {
    if (!this.dirty || this.examples.length === 0) return;
    for (const m of this.members) {
      const sample = this._bootstrap();
      const X = sample.map((e) => e.x);
      const Y = sample.map((e) => e.y);
      m.fit(X, Y, { epochs, loss: 'bce', seed: 17 });
    }
    this._fitTemperature();
    this.dirty = false;
  }

  /** Learn the temperature T by gradient descent on NLL (needs both classes). */
  _fitTemperature() {
    const hasPos = this.examples.some((e) => e.y[0] === 1);
    const hasNeg = this.examples.some((e) => e.y[0] === 0);
    if (!hasPos || !hasNeg || this.examples.length < 4) {
      this.T = 1;
      return;
    }
    const logits = this.examples.map((e) => {
      let s = 0;
      for (const m of this.members) s += this._logit(m.predict(e.x)[0]);
      return s / this.members.length;
    });
    let T = 1;
    for (let iter = 0; iter < 200; iter++) {
      let grad = 0;
      for (let i = 0; i < logits.length; i++) {
        const z = logits[i] / T;
        const p = 1 / (1 + Math.exp(-z));
        // dNLL/dT  =  (p - y) * (-logit / T^2)
        grad += (p - this.examples[i].y[0]) * (-logits[i] / (T * T));
      }
      grad /= logits.length;
      T -= 0.5 * grad;
      if (T < 0.05) T = 0.05;
      if (T > 20) T = 20;
    }
    this.T = T;
  }

  /** Calibrated confidence + epistemic uncertainty for a claim. */
  assess(text) {
    this.trainIfDirty();
    const x = this.embedder.embed(text);
    const probs = this.members.map((m) => m.predict(x)[0]);
    const meanLogit = probs.reduce((s, p) => s + this._logit(p), 0) / probs.length;
    const conf_cal = 1 / (1 + Math.exp(-meanLogit / this.T));
    const mean = probs.reduce((s, p) => s + p, 0) / probs.length;
    const variance = probs.reduce((s, p) => s + (p - mean) * (p - mean), 0) / probs.length;
    const std = Math.sqrt(variance);
    const u_ep = Math.min(1, 2 * std); // ensemble disagreement → epistemic uncertainty
    return { conf_cal, u_ep };
  }

  /** Back-compat: epistemic uncertainty for a claim (CDCP vote term). */
  estimateEpistemicUncertainty(text) {
    if (this.examples.length === 0) return 0.5; // no evidence ⇒ maximally agnostic
    return this.assess(text).u_ep;
  }

  calibratedConfidence(text) {
    if (this.examples.length === 0) return 0.5;
    return this.assess(text).conf_cal;
  }
}

module.exports = EpistemicSkepticismEngine;
