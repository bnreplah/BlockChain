'use strict';

const crypto = require('crypto');
const { tokenize } = require('../util/embedding');

/**
 * A real knowledge graph G_K with genuine graph-traversal algorithms.
 *
 * Nodes are claims and entities (content tokens). A claim node is connected to
 * each of its entity nodes; two claims that share entities are therefore
 * connected by a claim→entity→claim path. Claims can be flagged `grounded`
 * (axioms / consensus-committed truth) or `refuted` (known-false). This is the
 * structure the GTE traverses — no embedding shortcuts.
 *
 * Implements BFS, DFS, Dijkstra and A* for real (paper §3, v5.0 GTE).
 */

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'with', 'is', 'are', 'be', 'via', 'by', 'as', 'at', 'it']);

function claimNodeId(text) {
  return 'c:' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 24);
}

class KnowledgeGraph {
  constructor() {
    this.nodes = new Map(); // id -> { id, type, text, grounded, refuted }
    this.adj = new Map(); // id -> Map(neighborId -> weight)
  }

  _node(id, attrs) {
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, type: attrs.type, text: attrs.text || '', grounded: false, refuted: false };
      this.nodes.set(id, n);
      this.adj.set(id, new Map());
    }
    // Refutation overrides groundedness: new contradicting evidence wins, so
    // a claim cannot remain a grounded axiom once it has been refuted.
    if (attrs.refuted) {
      n.refuted = true;
      n.grounded = false;
    } else if (attrs.grounded && !n.refuted) {
      n.grounded = true;
    }
    return n;
  }

  _edge(a, b, w = 1) {
    this.adj.get(a).set(b, Math.max(this.adj.get(a).get(b) || 0, w));
    this.adj.get(b).set(a, Math.max(this.adj.get(b).get(a) || 0, w));
  }

  entitiesOf(text) {
    return [...new Set(tokenize(text).filter((t) => t.length > 2 && !STOP.has(t)))];
  }

  /** Add (or flag) a claim and wire it to its entity nodes. Returns claim id. */
  addClaim(text, { grounded = false, refuted = false } = {}) {
    const id = claimNodeId(text);
    this._node(id, { type: 'claim', text, grounded, refuted });
    for (const ent of this.entitiesOf(text)) {
      const eid = 'e:' + ent;
      this._node(eid, { type: 'entity', text: ent });
      this._edge(id, eid, 1);
    }
    return id;
  }

  /** Ephemeral entry node for a query claim not (yet) stored, linked to entities. */
  _attachQuery(text) {
    const id = 'q:' + claimNodeId(text);
    this._node(id, { type: 'query', text });
    for (const ent of this.entitiesOf(text)) {
      const eid = 'e:' + ent;
      if (this.nodes.has(eid)) this._edge(id, eid, 1);
    }
    return id;
  }

  _detachQuery(id) {
    const neighbors = this.adj.get(id);
    if (neighbors) for (const nb of neighbors.keys()) this.adj.get(nb).delete(id);
    this.adj.delete(id);
    this.nodes.delete(id);
  }

  claimCount() {
    let n = 0;
    for (const node of this.nodes.values()) if (node.type === 'claim') n += 1;
    return n;
  }

  /** Real BFS up to depth k from `startId`; returns map nodeId → depth. */
  bfs(startId, k) {
    const depth = new Map([[startId, 0]]);
    const queue = [startId];
    while (queue.length) {
      const cur = queue.shift();
      const d = depth.get(cur);
      if (d >= k) continue;
      for (const nb of this.adj.get(cur).keys()) {
        if (!depth.has(nb)) {
          depth.set(nb, d + 1);
          queue.push(nb);
        }
      }
    }
    return depth;
  }

  /** Real DFS searching for a path to a node satisfying `pred`, depth-limited. */
  dfs(startId, pred, maxDepth) {
    const visited = new Set();
    const stack = [{ id: startId, depth: 0, path: [startId] }];
    while (stack.length) {
      const { id, depth, path } = stack.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      const node = this.nodes.get(id);
      if (id !== startId && node && pred(node)) return { found: true, path, depth };
      if (depth >= maxDepth) continue;
      for (const nb of this.adj.get(id).keys()) {
        if (!visited.has(nb)) stack.push({ id: nb, depth: depth + 1, path: [...path, nb] });
      }
    }
    return { found: false };
  }

  /** Real Dijkstra shortest path (edge distance = 1/weight). */
  dijkstra(startId, goalId) {
    const dist = new Map([[startId, 0]]);
    const prev = new Map();
    const visited = new Set();
    const pq = [{ id: startId, d: 0 }];
    while (pq.length) {
      pq.sort((a, b) => a.d - b.d);
      const { id, d } = pq.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      if (id === goalId) break;
      for (const [nb, w] of this.adj.get(id)) {
        const nd = d + 1 / w;
        if (nd < (dist.get(nb) ?? Infinity)) {
          dist.set(nb, nd);
          prev.set(nb, id);
          pq.push({ id: nb, d: nd });
        }
      }
    }
    if (!dist.has(goalId)) return { distance: Infinity, path: [] };
    const path = [goalId];
    let c = goalId;
    while (prev.has(c)) {
      c = prev.get(c);
      path.unshift(c);
    }
    return { distance: dist.get(goalId), path };
  }

  /** Real A* with a hop-count heuristic (admissible: ≤ remaining hops). */
  aStar(startId, goalId, heuristic = () => 0) {
    const g = new Map([[startId, 0]]);
    const prev = new Map();
    const open = [{ id: startId, f: heuristic(startId, goalId) }];
    const closed = new Set();
    while (open.length) {
      open.sort((a, b) => a.f - b.f);
      const { id } = open.shift();
      if (id === goalId) break;
      if (closed.has(id)) continue;
      closed.add(id);
      for (const [nb, w] of this.adj.get(id)) {
        const ng = g.get(id) + 1 / w;
        if (ng < (g.get(nb) ?? Infinity)) {
          g.set(nb, ng);
          prev.set(nb, id);
          open.push({ id: nb, f: ng + heuristic(nb, goalId) });
        }
      }
    }
    if (!g.has(goalId)) return { distance: Infinity, path: [] };
    const path = [goalId];
    let c = goalId;
    while (prev.has(c)) {
      c = prev.get(c);
      path.unshift(c);
    }
    return { distance: g.get(goalId), path };
  }
}

KnowledgeGraph.claimNodeId = claimNodeId;
module.exports = KnowledgeGraph;
