'use strict';

const { decayScore } = require('./decay');

/**
 * Memory Triage — paper §8.2, Algorithm 17.
 *
 * Runs periodically (default every 30 min) on each node, evaluating STM entries
 * for promotion, retention, or expiry, and enforcing the hard capacity limit
 * via decay-ordered eviction.
 */
function memoryTriage({ stm, cdcp, cfg, now = Date.now() }) {
  const report = { promotedArchived: 0, expired: 0, abandoned: 0, nominated: 0, evicted: 0, held: 0 };

  for (const entry of stm.all()) {
    entry.decay_score = decayScore(entry, now, cfg);

    if (entry.promoted) {
      stm.archive(entry);
      report.promotedArchived += 1;
    } else if (entry.decay_score < cfg.decay.thetaExpire) {
      stm.expire(entry);
      report.expired += 1;
    } else if (entry.state === 'REJECTED') {
      entry.retry_count = (entry.retry_count || 0) + 1;
      if (entry.retry_count > cfg.cdcp.maxRetries) {
        stm.expire(entry);
        report.abandoned += 1;
      } else {
        report.held += 1;
      }
    } else if (entry.salience >= cfg.cdcp.thetaNominate && entry.state === 'PENDING') {
      const res = cdcp.runConsensus(entry);
      report.nominated += 1;
      if (res.status === 'PROMOTED') report.promotedArchived += 1;
    } else {
      report.held += 1;
    }
  }

  // Hard capacity limit — decay-ordered eviction.
  const evicted = stm.evictOverflow((e) => decayScore(e, now, cfg));
  report.evicted = evicted.length;
  return report;
}

module.exports = { memoryTriage };
