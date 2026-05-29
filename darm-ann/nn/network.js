'use strict';

/**
 * A real, from-scratch feed-forward neural network with backpropagation.
 * Pure Node.js, no dependencies. This is the genuine ANN that the DARM-ANN
 * components train on — the embedder (skip-gram) and the ESE validity
 * classifiers are built on the primitives and the MLP here.
 *
 * Matrices are arrays of Float64Array (row-major: W[outIdx][inIdx]).
 */

/** Deterministic PRNG (mulberry32) so training runs are reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller normal sample from a uniform PRNG. */
function gaussian(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const ACT = {
  relu: {
    f: (z) => (z > 0 ? z : 0),
    df: (z) => (z > 0 ? 1 : 0),
  },
  tanh: {
    f: (z) => Math.tanh(z),
    df: (z) => 1 - Math.tanh(z) * Math.tanh(z),
  },
  sigmoid: {
    f: (z) => 1 / (1 + Math.exp(-z)),
    df: (z) => {
      const s = 1 / (1 + Math.exp(-z));
      return s * (1 - s);
    },
  },
  linear: { f: (z) => z, df: () => 1 },
};

/**
 * Multi-layer perceptron with Adam optimisation.
 *   sizes:       [inputDim, hidden1, ..., outputDim]
 *   activations: one per layer transition (sizes.length - 1 entries)
 */
class MLP {
  constructor({ sizes, activations, lr = 0.01, seed = 1, l2 = 0 } = {}) {
    if (!sizes || sizes.length < 2) throw new Error('MLP needs at least input+output sizes');
    this.sizes = sizes;
    this.activations = activations || sizes.slice(1).map(() => 'relu');
    this.lr = lr;
    this.l2 = l2;
    this.beta1 = 0.9;
    this.beta2 = 0.999;
    this.eps = 1e-8;
    this.t = 0;
    const rand = rng(seed);

    this.W = [];
    this.b = [];
    this.mW = [];
    this.vW = [];
    this.mb = [];
    this.vb = [];
    for (let l = 1; l < sizes.length; l++) {
      const fanIn = sizes[l - 1];
      const fanOut = sizes[l];
      const scale = Math.sqrt(2 / (fanIn + fanOut)); // Xavier/Glorot
      const W = [];
      const mW = [];
      const vW = [];
      for (let o = 0; o < fanOut; o++) {
        const row = new Float64Array(fanIn);
        for (let i = 0; i < fanIn; i++) row[i] = gaussian(rand) * scale;
        W.push(row);
        mW.push(new Float64Array(fanIn));
        vW.push(new Float64Array(fanIn));
      }
      this.W.push(W);
      this.mW.push(mW);
      this.vW.push(vW);
      this.b.push(new Float64Array(fanOut));
      this.mb.push(new Float64Array(fanOut));
      this.vb.push(new Float64Array(fanOut));
    }
  }

  forward(x) {
    const a = [Float64Array.from(x)];
    const z = [null];
    for (let l = 0; l < this.W.length; l++) {
      const W = this.W[l];
      const b = this.b[l];
      const act = ACT[this.activations[l]];
      const prev = a[l];
      const zl = new Float64Array(W.length);
      const al = new Float64Array(W.length);
      for (let o = 0; o < W.length; o++) {
        const row = W[o];
        let s = b[o];
        for (let i = 0; i < row.length; i++) s += row[i] * prev[i];
        zl[o] = s;
        al[o] = act.f(s);
      }
      z.push(zl);
      a.push(al);
    }
    return { a, z };
  }

  predict(x) {
    return this.forward(x).a[this.W.length];
  }

  /**
   * One gradient step on a single example.
   * loss: 'bce' (sigmoid output) or 'mse'. Returns scalar loss.
   */
  trainStep(x, y, loss = 'bce') {
    this.t += 1;
    const { a, z } = this.forward(x);
    const L = this.W.length;
    const out = a[L];
    const target = Float64Array.from(y);

    // Output-layer delta (dL/dz at the output).
    let delta = new Float64Array(out.length);
    let lossVal = 0;
    if (loss === 'bce') {
      // sigmoid + binary cross-entropy ⇒ dz = a - y
      for (let i = 0; i < out.length; i++) {
        const p = Math.min(1 - 1e-9, Math.max(1e-9, out[i]));
        lossVal += -(target[i] * Math.log(p) + (1 - target[i]) * Math.log(1 - p));
        delta[i] = out[i] - target[i];
      }
    } else {
      const act = ACT[this.activations[L - 1]];
      for (let i = 0; i < out.length; i++) {
        const d = out[i] - target[i];
        lossVal += d * d;
        delta[i] = 2 * d * act.df(z[L][i]);
      }
    }

    // Backpropagate and Adam-update layer by layer.
    for (let l = L - 1; l >= 0; l--) {
      const prev = a[l];
      const W = this.W[l];
      const b = this.b[l];
      const act = ACT[this.activations[l]];
      const isOutput = l === L - 1;
      const dz = isOutput && loss === 'bce' ? delta : new Float64Array(W.length);
      if (!(isOutput && loss === 'bce')) {
        for (let o = 0; o < W.length; o++) dz[o] = delta[o] * act.df(z[l + 1][o]);
      }

      // Gradient for the previous layer's activations.
      const dPrev = new Float64Array(prev.length);
      const bc1 = 1 - Math.pow(this.beta1, this.t);
      const bc2 = 1 - Math.pow(this.beta2, this.t);
      for (let o = 0; o < W.length; o++) {
        const row = W[o];
        const g = dz[o];
        // bias
        this.mb[l][o] = this.beta1 * this.mb[l][o] + (1 - this.beta1) * g;
        this.vb[l][o] = this.beta2 * this.vb[l][o] + (1 - this.beta2) * g * g;
        b[o] -= (this.lr * (this.mb[l][o] / bc1)) / (Math.sqrt(this.vb[l][o] / bc2) + this.eps);
        for (let i = 0; i < row.length; i++) {
          dPrev[i] += row[i] * g;
          let grad = g * prev[i] + this.l2 * row[i];
          this.mW[l][o][i] = this.beta1 * this.mW[l][o][i] + (1 - this.beta1) * grad;
          this.vW[l][o][i] = this.beta2 * this.vW[l][o][i] + (1 - this.beta2) * grad * grad;
          row[i] -= (this.lr * (this.mW[l][o][i] / bc1)) / (Math.sqrt(this.vW[l][o][i] / bc2) + this.eps);
        }
      }
      delta = dPrev;
    }
    return lossVal;
  }

  fit(X, Y, { epochs = 100, loss = 'bce', shuffle = true, seed = 7 } = {}) {
    const rand = rng(seed);
    const n = X.length;
    const idx = Array.from({ length: n }, (_, i) => i);
    let last = 0;
    for (let e = 0; e < epochs; e++) {
      if (shuffle) {
        for (let i = n - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [idx[i], idx[j]] = [idx[j], idx[i]];
        }
      }
      let total = 0;
      for (const i of idx) total += this.trainStep(X[i], Y[i], loss);
      last = total / n;
    }
    return last;
  }
}

module.exports = { MLP, rng, gaussian, ACT };
