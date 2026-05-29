'use strict';

/**
 * Weighted Markov state graph G_M (paper §10, "RLRF + MARKOV GRAPH" layer)
 * with a **link-chain overlay** — together a "chain graph".
 *
 *   • Markov layer: a directed, weighted transition graph. Edge weights are
 *     observed transition counts; prob(from → to) = count / Σ counts. This is a
 *     genuine first-order Markov chain over states.
 *
 *   • Link-chain overlay: every observed state is also appended to a singly /
 *     doubly linked chain in temporal order, so the same node set carries both
 *     a probabilistic transition structure and a sequential chain structure.
 *
 * The model (a TinyLM navigator, see nn/) is steered across this chain graph:
 * Markov weights propose candidates, the link chain provides sequence context,
 * and the navigator's policy chooses the next node.
 */
class MarkovGraph {
  constructor() {
    this.states = new Map(); // id -> { id, label, visits }
    this.out = new Map(); // from -> Map(to -> count)
    this.totals = new Map(); // from -> Σ counts
    this.chain = { head: null, tail: null, length: 0 }; // link-chain overlay
    this.linkPrev = new Map(); // id -> prev id (most recent)
    this.linkNext = new Map(); // id -> next id (most recent)
    this._lastState = null;
  }

  _ensure(id, label) {
    let s = this.states.get(id);
    if (!s) {
      s = { id, label: label || id, visits: 0 };
      this.states.set(id, s);
      this.out.set(id, new Map());
      this.totals.set(id, 0);
    }
    return s;
  }

  /** Observe a visit to a state; extends the link-chain overlay. */
  visit(id, label) {
    const s = this._ensure(id, label);
    s.visits += 1;
    // link-chain overlay (temporal sequence)
    if (this.chain.head === null) this.chain.head = id;
    if (this.chain.tail !== null) {
      this.linkPrev.set(id, this.chain.tail);
      this.linkNext.set(this.chain.tail, id);
    }
    this.chain.tail = id;
    this.chain.length += 1;
    // Markov transition from the previous visited state.
    if (this._lastState !== null) this._countTransition(this._lastState, id);
    this._lastState = id;
    return s;
  }

  _countTransition(from, to) {
    const m = this.out.get(from);
    m.set(to, (m.get(to) || 0) + 1);
    this.totals.set(from, this.totals.get(from) + 1);
  }

  /** Explicitly record a transition (e.g., from RLRF feedback). */
  observeTransition(from, to, { labelFrom, labelTo } = {}) {
    this._ensure(from, labelFrom);
    this._ensure(to, labelTo);
    this._countTransition(from, to);
  }

  weight(from, to) {
    const m = this.out.get(from);
    return m ? m.get(to) || 0 : 0;
  }

  prob(from, to) {
    const total = this.totals.get(from) || 0;
    return total === 0 ? 0 : this.weight(from, to) / total;
  }

  /** Candidate next states from `from`, sorted by transition probability. */
  candidates(from) {
    const m = this.out.get(from);
    if (!m) return [];
    const total = this.totals.get(from) || 1;
    return [...m.entries()]
      .map(([to, count]) => ({ to, count, prob: count / total }))
      .sort((a, b) => b.prob - a.prob);
  }

  /** Highest-probability successor (greedy Markov step). */
  nextBest(from) {
    const c = this.candidates(from);
    return c.length ? c[0].to : null;
  }

  /** Probabilistic random walk over the Markov layer. */
  randomWalk(start, steps, rand = Math.random) {
    const path = [start];
    let cur = start;
    for (let i = 0; i < steps; i++) {
      const cand = this.candidates(cur);
      if (!cand.length) break;
      let r = rand();
      let next = cand[cand.length - 1].to;
      for (const c of cand) {
        if (r < c.prob) {
          next = c.to;
          break;
        }
        r -= c.prob;
      }
      path.push(next);
      cur = next;
    }
    return path;
  }

  /** Link-chain overlay navigation. */
  chainNext(id) {
    return this.linkNext.get(id) || null;
  }

  chainPrev(id) {
    return this.linkPrev.get(id) || null;
  }

  stats() {
    let edges = 0;
    for (const m of this.out.values()) edges += m.size;
    return { states: this.states.size, edges, chainLength: this.chain.length };
  }
}

module.exports = MarkovGraph;
