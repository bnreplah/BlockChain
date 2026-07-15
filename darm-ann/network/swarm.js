'use strict';

const DarmAnn = require('../index');

/**
 * Swarm — cross-chain dissemination, pollination & poly-chain morphism.
 *
 * A Swarm is a set of DARM-ANN nodes that may sit on *different* chain
 * substrates (standalone, self-contained PoW, bridged repo chain — see
 * network/chainAdapter.js). It implements **pollination**: high-value
 * consolidated memories migrate from one node to its peers, where each peer
 * **independently re-validates** them through its own CDCP quorum before
 * committing to its own chain. Knowledge spreads, but trust is never copied —
 * every chain re-earns each fact. This is what lets the network behave as a
 * single growing, multipurpose, chain-agnostic neural memory.
 *
 * Pollination strategies (which memories to disseminate):
 *   • 'top-confidence' (default) — the most strongly-validated memories
 *   • 'most-accessed'            — the hottest memories (RRC pressure)
 *   • 'recent'                   — newest consolidations
 */
class Swarm {
  constructor({ nodes = [] } = {}) {
    this.nodes = nodes;
  }

  add(node) {
    this.nodes.push(node);
    return node;
  }

  /** Spin up `count` self-contained nodes, optionally each with its own substrate. */
  static deploy({ count = 3, substrateFactory = null, config = {} } = {}) {
    const swarm = new Swarm();
    for (let i = 0; i < count; i++) {
      const adapter = substrateFactory ? substrateFactory(i) : null;
      swarm.add(new DarmAnn({ nodeId: `node-${i}`, config, adapter }));
    }
    return swarm;
  }

  _select(node, strategy, topK) {
    const blocks = node.ltm.blocks.filter((b) => !b.superseded);
    let ranked;
    if (strategy === 'most-accessed') ranked = blocks.sort((a, b) => b.access_count - a.access_count);
    else if (strategy === 'recent') ranked = blocks.sort((a, b) => b.promoted_at - a.promoted_at);
    else ranked = blocks.sort((a, b) => b.confidence - a.confidence);
    return ranked.slice(0, topK);
  }

  /**
   * One pollination round. Each node offers its selected memories to every
   * peer; peers ground + stage anything novel, then (optionally) run their own
   * CDCP/RCE to re-consolidate it onto their own chain.
   */
  pollinate({ strategy = 'top-confidence', topK = 5, reconsolidate = true } = {}) {
    const report = { offered: 0, accepted: 0, reconsolidated: 0, perNode: {} };

    // Phase 1 — disseminate (cross-pollinate) novel memories into peers.
    for (const source of this.nodes) {
      const memories = this._select(source, strategy, topK);
      for (const peer of this.nodes) {
        if (peer === source) continue;
        for (const mem of memories) {
          report.offered += 1;
          const e = peer.embedText(mem.claim_text);
          if (peer.ltm.contains(e, 0.97)) continue; // already known on this chain
          // Ground it in the peer's voters and stage it for independent re-validation.
          peer.teach(mem.claim_text);
          peer.observe({
            claim: mem.claim_text,
            reward: mem.confidence,
            epistemic: { conf_cal: Math.min(0.99, mem.confidence), u_ep: 0.1 },
          });
          report.accepted += 1;
        }
      }
    }

    // Phase 2 — each peer re-consolidates pollinated memories on its own chain.
    if (reconsolidate) {
      for (const node of this.nodes) {
        const r = node.replay();
        report.reconsolidated += r.promoted;
        report.perNode[node.nodeId] = { ltm: node.ltm.size, promoted: r.promoted };
      }
    }
    return report;
  }

  /** Aggregate growth metrics across the whole swarm (the growing network). */
  growth() {
    let ltm = 0;
    let edges = 0;
    let rrc = 0;
    const substrates = {};
    for (const n of this.nodes) {
      ltm += n.ltm.size;
      edges += n.ltm.graphStats().edges;
      rrc += n.rrc.size;
      const mode = n.ltm.mode;
      substrates[mode] = (substrates[mode] || 0) + 1;
    }
    return {
      nodes: this.nodes.length,
      totalLTM: ltm,
      associativeEdges: edges,
      totalRRC: rrc,
      substrates, // poly-chain composition of the swarm
    };
  }
}

module.exports = Swarm;
