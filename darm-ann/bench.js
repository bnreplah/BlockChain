'use strict';

/**
 * Load / throughput benchmark for the DARM-ANN consensus pipeline.
 *
 *   node darm-ann/bench.js [txns] [validators] [batch]
 *
 * Drives N transactions through the full path —
 *   submit → gossip mempool → BFT consensus height → shared-LTM commit —
 * across an in-process validator set, and reports throughput (txns/sec),
 * per-height latency, and final chain agreement. This is a real end-to-end
 * measurement (genuine signed BFT rounds + hash-linked LTM commits), not a
 * micro-benchmark of one component.
 *
 * `batch` txns are committed per consensus height (batching amortises the
 * fixed round cost). Results are emitted as JSON and as Prometheus metrics
 * (darm-ann/metrics-style) so a runner can scrape or assert on them.
 */

const { InProcessBus } = require('./consensus/transport');
const { Replica, runHeight } = require('./consensus/replica');
const Mempool = require('./consensus/mempool');
const ValidatorKey = require('./consensus/validatorKey');
const LongTermMemory = require('./memory/longTermMemory');
const Embedder = require('./nn/embedder');

function buildCluster(n) {
  const keys = Array.from({ length: n }, () => new ValidatorKey());
  const set = new Map();
  keys.forEach((k, i) => set.set(`v${i}`, { publicKeyB64: k.publicKeyB64, weight: 1 }));
  const ids = keys.map((_, i) => `v${i}`);
  const ltms = keys.map(() => new LongTermMemory({ dim: 64 }));
  const embs = keys.map(() => new Embedder({ dim: 64 }));
  const reps = keys.map((k, i) =>
    new Replica({
      nodeId: `v${i}`, key: k, validators: set, tauC: 0.67,
      apply: (value) => {
        if (value.type === 'memory') {
          for (const claim of value.claims) {
            ltms[i].commit({ claim_text: claim, embedding: embs[i].embed(claim), confidence: 0.9, salience: 0.7, consensus_votes: [], proposer: 'bench', validation: {} });
          }
        }
      },
    })
  );
  return { keys, ids, set, reps, ltms };
}

function runBenchmark({ txns = 200, validators = 4, batch = 10 } = {}) {
  const consensusBus = new InProcessBus();
  const gossipBus = new InProcessBus();
  const { ids, reps, ltms } = buildCluster(validators);

  // One mempool per node; any node can submit. Seeded RNG → deterministic gossip.
  let s = 7;
  const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const pools = ids.map((id, i) => new Mempool({ nodeId: id, key: reps[i].key, transport: gossipBus, fanout: 3, ttl: validators + 2, rng }));
  pools.forEach((p) => p.setPeers(ids));
  pools.forEach((p) => gossipBus.connect(p.nodeId, (m) => p.handle(m)));

  // Submit all txns from rotating origin nodes; gossip propagates them.
  const submitStart = process.hrtime.bigint();
  for (let i = 0; i < txns; i++) pools[i % pools.length].submit('memory', { claim: `benchmark fact number ${i}` });
  gossipBus.pump();
  const submitMs = Number(process.hrtime.bigint() - submitStart) / 1e6;

  // Commit in batches: each height the proposer drains `batch` txns from its pool.
  const latencies = [];
  let committedTxns = 0;
  const start = process.hrtime.bigint();
  let guard = 0;
  while (committedTxns < txns && guard++ < txns + 100) {
    const proposerId = ids[reps[0].height % ids.length];
    const pIdx = ids.indexOf(proposerId);
    const take = pools[pIdx].take(batch);
    if (take.length === 0) break;
    const value = { type: 'memory', claims: take.map((t) => t.payload.claim), txIds: take.map((t) => t.id) };
    const h0 = process.hrtime.bigint();
    const r = runHeight(reps, consensusBus, value);
    const hMs = Number(process.hrtime.bigint() - h0) / 1e6;
    if (!r.committed) break;
    latencies.push(hMs);
    pools.forEach((p) => p.remove(value.txIds));
    committedTxns += take.length;
  }
  const totalMs = Number(process.hrtime.bigint() - start) / 1e6;

  // Verify every replica's LTM is byte-identical (correctness under load).
  const heads = ltms.map((l) => l.blocks.map((b) => b.hash).join(','));
  const agreed = heads.every((h) => h === heads[0]);
  latencies.sort((a, b) => a - b);
  const p = (q) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : 0;

  return {
    txns, validators, batch,
    committedTxns,
    heights: latencies.length,
    submitMs: round(submitMs),
    consensusMs: round(totalMs),
    throughputTps: round((committedTxns / totalMs) * 1000),
    heightLatencyMs: { p50: round(p(0.5)), p95: round(p(0.95)), max: round(latencies[latencies.length - 1] || 0) },
    ltmBlocks: ltms[0].size,
    ltmAgreement: agreed,
  };
}

function round(x) { return Math.round(x * 100) / 100; }

function toPrometheus(r) {
  return [
    `# TYPE darm_bench_throughput_tps gauge`,
    `darm_bench_throughput_tps ${r.throughputTps}`,
    `# TYPE darm_bench_height_latency_ms gauge`,
    `darm_bench_height_latency_ms{quantile="0.5"} ${r.heightLatencyMs.p50}`,
    `darm_bench_height_latency_ms{quantile="0.95"} ${r.heightLatencyMs.p95}`,
    `# TYPE darm_bench_committed_txns counter`,
    `darm_bench_committed_txns ${r.committedTxns}`,
    `# TYPE darm_bench_ltm_agreement gauge`,
    `darm_bench_ltm_agreement ${r.ltmAgreement ? 1 : 0}`,
  ].join('\n');
}

if (require.main === module) {
  const [txns, validators, batch] = process.argv.slice(2).map(Number);
  const r = runBenchmark({ txns: txns || 200, validators: validators || 4, batch: batch || 10 });
  console.log(JSON.stringify(r, null, 2));
  if (process.env.BENCH_PROM) console.log('\n' + toPrometheus(r));
  // Non-zero exit if correctness broke under load.
  process.exit(r.ltmAgreement && r.committedTxns === r.txns ? 0 : 1);
}

module.exports = { runBenchmark, toPrometheus };
