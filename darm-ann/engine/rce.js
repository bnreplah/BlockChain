'use strict';

/**
 * Replay and Consolidation Engine (RCE) — paper §6, Algorithm 15.
 *
 * The engineering analog of hippocampal sharp-wave-ripple replay during NREM
 * sleep. Runs as a low-priority background cycle: salience-biased STM entries
 * are reactivated, re-validated through the GTE pipeline, reinforced or
 * decayed, and survivors are nominated to CDCP. Old LTM entries are
 * interleaved (ratio 50:20, r=0.4) to prevent catastrophic forgetting
 * (Proof P42). Finally the RRC is refreshed and stale entries evicted.
 */

/** Interleave new STM candidates with old LTM samples at the given ratio. */
function interleave(newItems, oldItems) {
  const out = [];
  const total = newItems.length + oldItems.length;
  let ni = 0;
  let oi = 0;
  // Maintain roughly newItems:oldItems proportion across the merged stream.
  for (let i = 0; i < total; i++) {
    const takeNew =
      oi >= oldItems.length ||
      (ni < newItems.length && ni * oldItems.length <= oi * newItems.length);
    if (takeNew) out.push({ kind: 'stm', item: newItems[ni++] });
    else out.push({ kind: 'ltm', item: oldItems[oi++] });
  }
  return out;
}

class ReplayConsolidationEngine {
  constructor({ stm, ltm, rrc, gte, cdcp, cfg }) {
    this.stm = stm;
    this.ltm = ltm;
    this.rrc = rrc;
    this.gte = gte;
    this.cdcp = cdcp;
    this.cfg = cfg;
    this.lastCycleTime = 0;
  }

  /** Algorithm 15 — one RCE replay cycle. */
  cycle({ now = Date.now() } = {}) {
    const cfg = this.cfg;
    const tStart = now;
    const cycleStartWall = Date.now();

    // Phase 1 — salience-biased replay candidates (not uniform)
    const candidates = this.stm
      .sampleBySalience(cfg.rce.sampleStm, 'high_salience')
      .filter((e) => !e.promoted && e.state !== 'EXPIRED');

    // Phase 2 — interleave with old LTM entries (catastrophic-forgetting prevention)
    const oldMemories = this.ltm.sampleByAge(cfg.rce.sampleLtm, 'old');
    const batch = interleave(candidates, oldMemories);

    const report = {
      replayed: 0,
      reinforced: 0,
      decayed: 0,
      nominated: 0,
      promoted: 0,
      interleavedOld: 0,
      rrcUpdated: 0,
      rrcEvicted: 0,
    };

    for (const { kind, item } of batch) {
      if (Date.now() - cycleStartWall > cfg.rce.cycleBudgetMs) break; // respect budget
      report.replayed += 1;

      if (kind === 'ltm') {
        // Interleaved old-memory replay: re-affirm (keeps gradient signal alive).
        this.gte.bfsValidate(item.claim_text, item.embedding, cfg.gte.bfsK2);
        report.interleavedOld += 1;
        continue;
      }

      const entry = item;
      const bfs = this.gte.bfsValidate(entry.claim_text, entry.embedding, cfg.gte.bfsK2);
      const dfs = this.gte.dfsAudit(entry.claim_text, entry.embedding);

      if (bfs.score > cfg.rce.bfsReinforceScore && dfs.type === 'Grounded') {
        entry.salience = Math.min(1, entry.salience * cfg.rce.reinforceFactor);
        entry.replays = (entry.replays || 0) + 1;
        report.reinforced += 1;

        if (entry.salience >= cfg.cdcp.thetaNominate && entry.state === 'PENDING') {
          const result = this.cdcp.runConsensus(entry);
          report.nominated += 1;
          if (result.status === 'PROMOTED') report.promoted += 1;
        }
      } else {
        entry.salience *= cfg.rce.decayFactor;
        report.decayed += 1;
        if (entry.salience < cfg.decay.thetaDecay) this.stm.expire(entry.claim_id);
      }
    }

    // Phase 3 — refresh RRC with recently promoted LTM entries
    const recent = this.ltm.getSince(this.lastCycleTime);
    for (const block of recent) {
      this.rrc.indexBlock(block);
      report.rrcUpdated += 1;
    }

    // Phase 4 — evict stale RRC entries
    report.rrcEvicted = this.rrc.evictStale(cfg.rrc.thetaRrcDecay);

    this.lastCycleTime = tStart;
    return report;
  }
}

ReplayConsolidationEngine.interleave = interleave;
module.exports = ReplayConsolidationEngine;
