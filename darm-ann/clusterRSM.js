'use strict';

/**
 * Multi-process replicated state machine over real TCP — demonstrates a running
 * cluster changing its validator set **live, via consensus**.
 *
 *   node darm-ann/clusterRSM.js [n] [basePort]
 *
 * The launcher forks n validator processes (deterministic keys from a master
 * seed) and orchestrates a sequence of consensus heights:
 *   h0  commit a memory txn            (n validators)
 *   h1  commit remove-validator v(n-1) (n validators agree to shrink)
 *   h2  commit a memory txn            (n-1 validators — the removed node is
 *                                       no longer counted toward quorum)
 *
 * Each child applies committed membership changes to its local validator set
 * and writes a durable WAL. This shows the set shrinking live with every node
 * agreeing through the BFT. (Growth/join is covered deterministically by the
 * in-process Replica tests, which also exercise new-node bootstrap.)
 */

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { TcpTransport } = require('./consensus/transport');
const { BFTNode } = require('./consensus/bft');
const ValidatorKey = require('./consensus/validatorKey');
const WAL = require('./consensus/wal');

function buildSet(master, n) {
  const keys = [];
  const set = new Map();
  for (let i = 0; i < n; i++) {
    const k = ValidatorKey.fromSeed(crypto.createHash('sha256').update(`${master}:${i}`).digest());
    keys.push(k);
    set.set(`v${i}`, { publicKeyB64: k.publicKeyB64, weight: 1 });
  }
  return { keys, set };
}

async function runChild(i, n, basePort, master) {
  const { keys, set } = buildSet(master, n);
  const transport = new TcpTransport({ nodeId: `v${i}`, port: basePort + i });
  await transport.listen();
  for (let j = 0; j < n; j++) if (j !== i) transport.addPeer(`v${j}`, '127.0.0.1', basePort + j);
  const wal = new WAL(path.join(os.tmpdir(), `darm-rsm-${master}-v${i}.log`));
  let height = 0;

  function applyCommit(value) {
    wal.append({ t: 'COMMIT', height, value, node: `v${i}` });
    if (value.type === 'remove-validator') set.delete(value.nodeId);
    height += 1;
  }

  process.on('message', (m) => {
    if (m.cmd === 'done') return process.exit(0);
    if (m.cmd !== 'height') return;
    if (!set.has(`v${i}`)) { process.send({ skipped: true, height: m.height }); return; }
    const node = new BFTNode({
      nodeId: `v${i}`, key: keys[i], validators: set, transport, tauC: 0.67,
      useTimers: true, timeoutMs: 200, height, wal,
      evaluate: (v) => ({ vote: v && v.nodeId === `v${i}` && v.type === 'remove-validator' ? 'NO' : 'YES', score: 0.9 }),
      onDecide: (res) => { applyCommit(m.value); process.send({ committed: true, height: m.height, round: res.round, size: set.size }); },
    });
    node.start(m.value);
  });

  process.send({ ready: i });
}

function launch(n, basePort) {
  const master = crypto.randomBytes(8).toString('hex');
  const children = [];
  let readyCount = 0;
  const liveSet = new Set(Array.from({ length: n }, (_, i) => `v${i}`));

  for (let i = 0; i < n; i++) {
    const child = fork(__filename, ['child', String(i), String(n), String(basePort), master], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', (d) => process.stdout.write(`  [v${i}] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`  [v${i} err] ${d}`));
    children.push(child);
  }

  const committedFor = {};
  children.forEach((c, i) =>
    c.on('message', (m) => {
      if (m.ready != null) { readyCount += 1; if (readyCount === n) setTimeout(start, 600); }
      if (m.committed) { committedFor[m.height] = (committedFor[m.height] || 0) + 1; }
    })
  );

  function broadcast(height, value) {
    children.forEach((c) => c.send({ cmd: 'height', height, value }));
  }
  function quorum(setSize) { return Math.ceil((2 * setSize) / 3); }
  async function awaitHeight(height, setSize, ms = 4000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if ((committedFor[height] || 0) >= quorum(setSize)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  async function start() {
    console.log(`[rsm] ${n} processes ready on ports ${basePort}..${basePort + n - 1}`);
    let ok = true;
    console.log('[rsm] height 0: memory txn');
    broadcast(0, { type: 'memory', claim: 'genesis fact' });
    ok = (await awaitHeight(0, liveSet.size)) && ok;

    const victim = `v${n - 1}`;
    console.log(`[rsm] height 1: remove-validator ${victim}`);
    broadcast(1, { type: 'remove-validator', nodeId: victim });
    ok = (await awaitHeight(1, liveSet.size)) && ok;
    liveSet.delete(victim);

    console.log(`[rsm] height 2: memory txn (now ${liveSet.size} validators)`);
    broadcast(2, { type: 'memory', claim: 'post-shrink fact' });
    ok = (await awaitHeight(2, liveSet.size)) && ok;

    console.log(`[rsm] result: ${ok ? 'SUCCESS' : 'FAILURE'} — set shrank ${n} → ${liveSet.size} live via consensus`);
    children.forEach((c) => c.send({ cmd: 'done' }));
    setTimeout(() => process.exit(ok ? 0 : 1), 400);
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'child') {
    runChild(Number(argv[1]), Number(argv[2]), Number(argv[3]), argv[4]).catch((e) => { console.error(e); process.exit(3); });
  } else {
    launch(Number(argv[0] || 4), Number(argv[1] || 19800));
  }
}
