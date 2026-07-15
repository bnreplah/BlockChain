'use strict';

/**
 * Multi-process replicated state machine over real TCP — demonstrates, across
 * real OS processes:
 *   • a NEW node joining a running cluster (state-sync + add-validator txn), and
 *   • memory consolidation replicated through consensus into ONE shared LTM
 *     blockchain (every process ends with byte-identical LTM block hashes).
 *
 *   node darm-ann/clusterRSM.js [n] [basePort]
 *
 * Scenario (n initial validators + 1 joiner):
 *   h0  memory txn               (n validators commit → LTM grows)
 *   ——  joiner state-syncs from a seed peer (height + active set + LTM)
 *   h1  add-validator(joiner)    (n validators agree to admit the joiner)
 *   h2  memory txn               (n+1 validators commit → shared LTM grows)
 *   verify: every process (incl. joiner) has identical LTM head hashes.
 */

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { TcpTransport } = require('./consensus/transport');
const { BFTNode } = require('./consensus/bft');
const ValidatorKey = require('./consensus/validatorKey');
const WAL = require('./consensus/wal');
const LongTermMemory = require('./memory/longTermMemory');
const Embedder = require('./nn/embedder');

const BFT_TYPES = new Set(['PROPOSE', 'PREVOTE', 'PRECOMMIT']);

function buildKeys(master, total) {
  const keys = [];
  const all = new Map();
  for (let i = 0; i < total; i++) {
    const k = ValidatorKey.fromSeed(crypto.createHash('sha256').update(`${master}:${i}`).digest());
    keys.push(k);
    all.set(`v${i}`, { publicKeyB64: k.publicKeyB64, weight: 1 });
  }
  return { keys, all };
}

async function runChild(i, n, total, basePort, master, isJoiner) {
  const { keys, all } = buildKeys(master, total);
  const me = `v${i}`;
  const transport = new TcpTransport({ nodeId: me, port: basePort + i });
  await transport.listen();
  for (let j = 0; j < total; j++) if (j !== i) transport.addPeer(`v${j}`, '127.0.0.1', basePort + j);

  const wal = new WAL(path.join(os.tmpdir(), `darm-rsmjoin-${master}-v${i}.log`));
  const ltm = new LongTermMemory({ dim: 64 });
  const embedder = new Embedder({ dim: 64 });
  // Active validator set: initial members are v0..v(n-1); the joiner starts empty
  // and learns the set via state-sync.
  const active = new Map();
  if (!isJoiner) for (let j = 0; j < n; j++) active.set(`v${j}`, all.get(`v${j}`));
  let height = 0;
  let bft = null;

  function applyValue(value) {
    if (value.type === 'memory') {
      ltm.commit({ claim_text: value.claim, embedding: embedder.embed(value.claim), confidence: value.confidence || 0.9, salience: 0.7, consensus_votes: [], proposer: 'rsm', validation: {} });
    } else if (value.type === 'add-validator') {
      active.set(value.nodeId, all.get(value.nodeId));
    } else if (value.type === 'remove-validator') {
      active.delete(value.nodeId);
    }
    wal.append({ t: 'COMMIT', height, value, node: me });
    height += 1;
  }

  // One transport dispatcher routes consensus messages to the active BFT node
  // and state-sync messages to the sync handler.
  transport.connect(me, (msg) => {
    if (msg.type === 'SYNC_REQ') {
      transport.send(me, msg.from, { type: 'SYNC_RESP', to: msg.from, height, active: [...active.entries()], ltm: ltm.toJSON() });
      return;
    }
    if (msg.type === 'SYNC_RESP') {
      height = msg.height;
      for (const [id, v] of msg.active) active.set(id, v);
      ltm.load(msg.ltm);
      process.send({ synced: true, height, ltm: ltm.size });
      return;
    }
    if (BFT_TYPES.has(msg.type) && bft) bft.handle(msg);
  });

  function headHash() {
    return ltm.blocks.length ? ltm.blocks[ltm.blocks.length - 1].hash : 'genesis';
  }

  process.on('message', (m) => {
    if (m.cmd === 'done') return process.exit(0);
    if (m.cmd === 'sync') { transport.send(me, m.seed, { type: 'SYNC_REQ', from: me }); return; }
    if (m.cmd === 'head') { process.send({ finalHead: true, head: headHash(), ltm: ltm.size, validators: active.size }); return; }
    if (m.cmd === 'apply') { applyValue(m.value); process.send({ applied: true, height, head: headHash(), ltm: ltm.size }); return; }
    if (m.cmd === 'height') {
      if (!active.has(me)) { process.send({ skipped: true, height: m.height }); return; }
      bft = new BFTNode({
        nodeId: me, key: keys[i], validators: active, transport, tauC: 0.67,
        useTimers: true, timeoutMs: 200, height, autoConnect: false,
        evaluate: () => ({ vote: 'YES', score: 0.9 }),
        onDecide: () => { applyValue(m.value); process.send({ committed: true, height: m.height, head: headHash(), ltm: ltm.size }); },
      });
      bft.start(m.value);
    }
  });

  process.send({ ready: i });
}

function launch(n, basePort) {
  const master = crypto.randomBytes(8).toString('hex');
  const total = n + 1; // n initial + 1 joiner
  const joiner = `v${n}`;
  const children = [];
  let ready = 0;
  const events = { committed: {}, applied: {}, synced: 0, heads: {} };

  for (let i = 0; i < total; i++) {
    const child = fork(__filename, ['child', String(i), String(n), String(total), String(basePort), master, i === n ? 'join' : ''], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stderr.on('data', (d) => process.stderr.write(`  [v${i} err] ${d}`));
    children.push(child);
  }
  events.finalHeads = [];
  children.forEach((c, i) =>
    c.on('message', (m) => {
      if (m.ready != null) { ready += 1; if (ready === total) setTimeout(start, 700); }
      if (m.committed) events.committed[m.height] = (events.committed[m.height] || 0) + 1;
      if (m.synced) events.synced += 1;
      if (m.finalHead) events.finalHeads.push({ node: `v${i}`, head: m.head, ltm: m.ltm });
    })
  );

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const quorum = (size) => Math.ceil((2 * size) / 3);
  async function awaitCount(get, target, ms = 4000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (get() >= target) return true; await sleep(80); }
    return false;
  }

  async function start() {
    console.log(`[rsm-join] ${n} validators + 1 joiner on ports ${basePort}..${basePort + total - 1}`);
    let ok = true;

    console.log('[rsm-join] height 0: memory txn (n validators)');
    children.slice(0, n).forEach((c) => c.send({ cmd: 'height', height: 0, value: { type: 'memory', claim: 'genesis fact', confidence: 0.9 } }));
    ok = (await awaitCount(() => events.committed[0] || 0, quorum(n))) && ok;
    await sleep(400);

    console.log(`[rsm-join] joiner ${joiner} state-syncs from v0`);
    children[n].send({ cmd: 'sync', seed: 'v0' });
    ok = (await awaitCount(() => events.synced, 1)) && ok;

    console.log(`[rsm-join] height 1: add-validator ${joiner}`);
    const addVal = { type: 'add-validator', nodeId: joiner, publicKeyB64: null };
    children.slice(0, n).forEach((c) => c.send({ cmd: 'height', height: 1, value: addVal }));
    ok = (await awaitCount(() => events.committed[1] || 0, quorum(n))) && ok;
    children[n].send({ cmd: 'apply', value: addVal }); // joiner learns it was admitted
    await sleep(600);

    console.log(`[rsm-join] height 2: memory txn (n+1 = ${n + 1} validators, incl joiner)`);
    children.forEach((c) => c.send({ cmd: 'height', height: 2, value: { type: 'memory', claim: 'post-join fact', confidence: 0.9 } }));
    ok = (await awaitCount(() => events.committed[2] || 0, quorum(n + 1))) && ok;
    await sleep(600);

    // Verify by asking every process for its FINAL LTM head (no per-height
    // bookkeeping ambiguity): all should hold the same 2-block chain.
    children.forEach((c) => c.send({ cmd: 'head' }));
    await awaitCount(() => events.finalHeads.length, total, 3000);
    const heads = events.finalHeads;
    const full = heads.filter((h) => h.ltm === 2);
    const agreed = full.length === total && full.every((h) => h.head === full[0].head);
    console.log(`[rsm-join] final LTM heads: ${heads.map((h) => h.node + '=' + h.head.slice(0, 8) + '(' + h.ltm + ')').join(' ')}`);
    console.log(`[rsm-join] all ${total} processes share an identical 2-block LTM: ${agreed}`);
    console.log(`[rsm-join] result: ${ok && agreed ? 'SUCCESS' : 'PARTIAL'} — joiner admitted via consensus; shared LTM replicated`);
    children.forEach((c) => c.send({ cmd: 'done' }));
    setTimeout(() => process.exit(ok && agreed ? 0 : 1), 400);
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'child') {
    runChild(Number(argv[1]), Number(argv[2]), Number(argv[3]), Number(argv[4]), argv[5], argv[6] === 'join').catch((e) => { console.error(e); process.exit(3); });
  } else {
    launch(Number(argv[0] || 4), Number(argv[1] || 19900));
  }
}
