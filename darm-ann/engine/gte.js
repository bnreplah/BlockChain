'use strict';

const KnowledgeGraph = require('./knowledgeGraph');

/**
 * Graph Traversal Engine (GTE) — real implementation (paper §3, v5.0).
 *
 * Operates over a genuine knowledge graph G_K (engine/knowledgeGraph.js) using
 * real breadth-first and depth-first traversal — no embedding similarity
 * shortcuts.
 *
 *   bfsValidate(claim, k) — BFS to depth k from the claim's entity nodes,
 *     accumulating support from reachable *grounded* claims and conflict from
 *     reachable *refuted* claims, discounted by path depth. Returns
 *     { score, conflict_score, conflicts }.
 *
 *   dfsAudit(claim) — DFS for a path from the claim to any grounded axiom
 *     node within a depth budget. Returns { type: 'Grounded'|'Ungrounded' }.
 *
 * Each node owns its own GTE/G_K, so CDCP votes are genuinely independent and
 * cross-node knowledge can diverge (the ρ_GK of Proof P39).
 */
class GraphTraversalEngine {
  constructor({ groundedThreshold = 0.5, maxDepth = 4 } = {}) {
    this.graph = new KnowledgeGraph();
    this.groundedThreshold = groundedThreshold;
    this.maxDepth = maxDepth;
  }

  addGrounded(text) {
    this.graph.addClaim(text, { grounded: true });
    return this;
  }

  addRefuted(text) {
    this.graph.addClaim(text, { refuted: true });
    return this;
  }

  addClaim(text) {
    this.graph.addClaim(text);
    return this;
  }

  /** Size of G_K (claim count) — feeds VoteWeight scaling (§5.7). */
  gkSize() {
    return this.graph.claimCount();
  }

  /** Real BFS neighbourhood-consistency validation. */
  bfsValidate(claimText, _embedding = null, k = 2) {
    const g = this.graph;
    const qid = g._attachQuery(claimText);
    try {
      const depthMap = g.bfs(qid, k + 1); // +1 hop: query→entity→claim
      let support = 0;
      let conflict = 0;
      const conflicts = [];
      for (const [nodeId, depth] of depthMap) {
        if (nodeId === qid || depth === 0) continue;
        const node = g.nodes.get(nodeId);
        if (!node || node.type !== 'claim') continue;
        const contribution = 1 / depth; // closer evidence counts more
        if (node.grounded) support += contribution;
        if (node.refuted) {
          conflict += contribution;
          conflicts.push({ weight: contribution, text: node.text });
        }
      }
      // Squash unbounded accumulations into [0,1].
      const score = 1 - Math.exp(-support);
      const conflict_score = 1 - Math.exp(-conflict);
      return { score, conflict_score, conflicts };
    } finally {
      g._detachQuery(qid);
    }
  }

  /** Real DFS causal-chain groundedness audit. */
  dfsAudit(claimText, _embedding = null) {
    const g = this.graph;
    const qid = g._attachQuery(claimText);
    try {
      const res = g.dfs(qid, (node) => node.type === 'claim' && node.grounded, this.maxDepth);
      // Strength = inverse of the hop distance to the nearest grounded axiom.
      const support = res.found ? 1 / Math.max(1, res.depth - 1) : 0;
      return { type: support >= this.groundedThreshold ? 'Grounded' : 'Ungrounded', support, path: res.path };
    } finally {
      g._detachQuery(qid);
    }
  }
}

module.exports = GraphTraversalEngine;
