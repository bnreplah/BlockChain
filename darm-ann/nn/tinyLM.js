'use strict';

const { MLP } = require('./network');

/**
 * TinyLM — a genuine small neural model (built on the from-scratch MLP) that
 * scores graph transitions: given a context node and a candidate next node, it
 * predicts P(candidate is a good continuation). Input is the concatenation of
 * the two embeddings ([context ⊕ candidate], 2·dim), so the output dimension is
 * fixed and independent of vocabulary size.
 *
 * It is trained on observed transitions (positives) versus sampled non-
 * transitions (negatives). This is the model that "directs the system on the
 * graph": the navigator queries it to choose where to go next.
 */
class TinyLM {
  constructor({ embedder, dim = 64, hidden = 24, negatives = 2, lr = 0.05, seed = 5 } = {}) {
    this.embedder = embedder;
    this.dim = dim;
    this.negatives = negatives;
    this.net = new MLP({ sizes: [2 * dim, hidden, 1], activations: ['relu', 'sigmoid'], lr, seed });
    this.examples = [];
    this.contextPool = []; // observed candidate texts (negative sampling pool)
    this.dirty = false;
    let a = (seed ^ 0xabcd) >>> 0;
    this._rng = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  _features(ctxText, candText) {
    const a = this.embedder.embed(ctxText);
    const b = this.embedder.embed(candText);
    const x = new Float64Array(2 * this.dim);
    x.set(a, 0);
    x.set(b, this.dim);
    return x;
  }

  /** Record a real observed transition (context → next). */
  observeTransition(ctxText, nextText) {
    this.contextPool.push(nextText);
    this.examples.push({ x: this._features(ctxText, nextText), y: [1] });
    // Negative samples: context paired with unrelated observed texts.
    for (let n = 0; n < this.negatives && this.contextPool.length > 1; n++) {
      const neg = this.contextPool[Math.floor(this._rng() * this.contextPool.length)];
      if (neg !== nextText) this.examples.push({ x: this._features(ctxText, neg), y: [0] });
    }
    this.dirty = true;
  }

  trainIfDirty({ epochs = 400 } = {}) {
    if (!this.dirty || this.examples.length === 0) return;
    this.net.fit(this.examples.map((e) => e.x), this.examples.map((e) => e.y), { epochs, loss: 'bce', seed: 9 });
    this.dirty = false;
  }

  /** P(candidate is a good next node) ∈ [0,1]. */
  score(ctxText, candText) {
    if (this.examples.length === 0) return 0.5;
    this.trainIfDirty();
    return this.net.predict(this._features(ctxText, candText))[0];
  }
}

module.exports = TinyLM;
