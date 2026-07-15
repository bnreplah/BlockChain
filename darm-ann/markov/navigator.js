'use strict';

/**
 * GraphNavigator — the model directing itself across the chain graph.
 *
 * At each step it takes the Markov candidates from the current node, scores
 * each with a TinyLM (P(candidate is a good continuation)), blends that with
 * the Markov transition probability, and advances to the highest-scoring node.
 * This is genuine model-directed traversal over the weighted Markov graph +
 * link-chain overlay — not a random walk.
 *
 *   blendedScore = alpha · markovProb + (1 − alpha) · tinyLMScore
 */
class GraphNavigator {
  constructor({ graph, tinyLM, labelOf, alpha = 0.5 }) {
    this.graph = graph;
    this.tinyLM = tinyLM;
    this.labelOf = labelOf || ((id) => id);
    this.alpha = alpha;
  }

  step(currentId) {
    const cands = this.graph.candidates(currentId);
    if (!cands.length) return null;
    const ctxText = this.labelOf(currentId);
    let best = null;
    let bestScore = -Infinity;
    for (const c of cands) {
      const tiny = this.tinyLM ? this.tinyLM.score(ctxText, this.labelOf(c.to)) : 0.5;
      const blended = this.alpha * c.prob + (1 - this.alpha) * tiny;
      if (blended > bestScore) {
        bestScore = blended;
        best = { to: c.to, prob: c.prob, tiny, blended };
      }
    }
    return best;
  }

  /** Navigate up to `steps` hops, returning the chosen path and per-step info. */
  navigate(startId, steps = 8) {
    const path = [startId];
    const trace = [];
    const visited = new Set([startId]);
    let cur = startId;
    for (let i = 0; i < steps; i++) {
      const choice = this.step(cur);
      if (!choice || visited.has(choice.to)) break; // stop at dead-end or cycle
      path.push(choice.to);
      trace.push(choice);
      visited.add(choice.to);
      cur = choice.to;
    }
    return { path, trace };
  }
}

module.exports = GraphNavigator;
