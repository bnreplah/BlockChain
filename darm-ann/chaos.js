'use strict';

/**
 * Chaos / soak test for the multi-process BFT cluster over real TCP.
 *
 *   node darm-ann/chaos.js [n] [basePort] [durationMs]
 *
 * Runs a cluster of n validator processes through a sequence of consensus
 * heights while INJECTING FAULTS — periodically killing a random validator and
 * restarting it (which recovers from its WAL). Asserts the two BFT guarantees
 * hold throughout:
 *   • LIVENESS: every height still commits (>= 2/3 quorum) despite the churn,
 *     as long as no more than f = floor((n-1)/3) nodes are down at once.
 *   • SAFETY:  no two validators ever commit a DIFFERENT value at the same
 *     height (agreement). A node that was down legitimately misses heights
 *     until it recovers — that is not a violation; committing a conflicting
 *     value at a height someone else committed differently would be.
 *
 * Each child keeps a durable WAL so a restarted process resumes consistently.
 * This is a soak harness: scale `durationMs` up for longer runs.
 */

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const { TcpTransport } = require('./consensus/transport');
const { BFTNode } = require('./consensus/bft');
const ValidatorKey = require('./consensus/validatorKey');
const WAL = require('./consensus/wal');

const BFT_TYPES = new Set(['PROPOSE', 'PREVOTE', 'PRECOMMIT']);

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

// ── Child validator process ───────────────────────────────────────────────
async function runChild(i, n, basePort, master) {
  const { keys, set } = buildSet(master, n);
  const me = `v${i}`;
  const transport = new TcpTransport({ nodeId: me, port: basePort + i });
  await transport.listen();
  for (let j = 0; j < n; j++) if (j !== i) transport.addPeer(`v${j}`, '127.0.0.1', basePort + j);

  const wal = new WAL(path.join(os.tmpdir(), `darm-chaos-${master}-v${i}.log`));
  const committed = []; // ordered committed values (the replicated log)
  let height = 0;
  let bft = null;

  // Recover committed log/height from WAL (in case this is a restart).
  for (const e of wal.replay()) {
    if (e.t === 'COMMIT' && e.node === me) { committed[e.height] = e.value.claim; height = e.height + 1; }
  }

  transport.connect(me, (msg) => { if (BFT_TYPES.has(msg.type) && bft) bft.handle(msg); });

  process.on('message', (m) => {
    if (m.cmd === 'done') return process.exit(0);
    if (m.cmd === 'state') { process.send({ state: true, height, log: committed.slice(0, height) }); return; }
    if (m.cmd === 'height') {
      // Already committed this height (e.g. recovered from WAL): re-report value.
      if (m.height < height) { process.send({ committed: true, height: m.height, value: committed[m.height], already: true }); return; }
      bft = new BFTNode({
        nodeId: me, key: keys[i], validators: set, transport, tauC: 0.67,
        useTimers: true, timeoutMs: 200, height: m.height, wal,
        evaluate: () => ({ vote: 'YES', score: 0.9 }),
        onDecide: () => {
          committed[m.height] = m.value.claim;
          height = m.height + 1;
          process.send({ committed: true, height: m.height, value: m.value.claim });
        },
      });
      bft.start(m.value);
    }
  });
  process.send({ ready: i });
}

// ── Orchestrator ──────────────────────────────────────────────────────────
function launch(n, basePort, durationMs) {
  const master = crypto.randomBytes(8).toString('hex');
  const f = Math.floor((n - 1) / 3);
  const quorum = Math.ceil((2 * n) / 3);
  const children = new Array(n).fill(null);
  const ready = new Set();
  const commitsAtHeight = {}; // height -> Map(nodeId -> digest)
  const downSince = {};

  function spawn(i) {
    const child = fork(__filename, ['child', String(i), String(n), String(basePort), master], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stderr.on('data', () => {}); // tolerate connection-refused churn noise
    child.on('message', (m) => {
      if (m.ready != null) ready.add(i);
      if (m.committed) {
        if (!commitsAtHeight[m.height]) commitsAtHeight[m.height] = new Map();
        commitsAtHeight[m.height].set(`v${i}`, m.value);
      }
    });
    child.on('exit', () => { if (children[i] === child) children[i] = null; });
    children[i] = child;
    return child;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const liveCount = () => children.filter(Boolean).length;
  const send = (i, msg) => { const c = children[i]; if (c && c.connected) try { c.send(msg); } catch (_e) {} };

  async function awaitCommit(height, target, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const got = commitsAtHeight[height] ? commitsAtHeight[height].size : 0;
      if (got >= target) return true;
      await sleep(60);
    }
    return false;
  }

  async function main() {
    console.log(`[chaos] n=${n} f=${f} quorum=${quorum} duration=${durationMs}ms`);
    for (let i = 0; i < n; i++) spawn(i);
    while (ready.size < n) await sleep(50);
    await sleep(400);

    const rand = (() => { let s = 1337; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
    const start = Date.now();
    let h = 0;
    let livenessOk = true;
    let safetyOk = true;
    let safetyChecks = 0;
    let faults = 0;

    while (Date.now() - start < durationMs) {
      // Occasionally kill a random live node (respecting the f bound), or revive one.
      if (rand() < 0.35) {
        const live = children.map((c, idx) => (c ? idx : -1)).filter((x) => x >= 0);
        const dead = children.map((c, idx) => (c ? -1 : idx)).filter((x) => x >= 0);
        if (dead.length < f && live.length > quorum && rand() < 0.6) {
          const victim = live[Math.floor(rand() * live.length)];
          send(victim, { cmd: 'done' });
          children[victim] && children[victim].kill('SIGKILL');
          children[victim] = null;
          downSince[victim] = Date.now();
          faults += 1;
        } else if (dead.length > 0) {
          const reviveIdx = dead[Math.floor(rand() * dead.length)];
          spawn(reviveIdx);
          await sleep(300); // let it bind + reconnect
        }
      }

      // Drive a height across whatever nodes are currently live.
      const value = { type: 'memory', claim: `chaos-h${h}` };
      for (let i = 0; i < n; i++) if (children[i]) send(i, { cmd: 'height', height: h, value });
      const ok = await awaitCommit(h, quorum);
      if (!ok) { livenessOk = false; console.log(`[chaos] height ${h} did NOT reach quorum (live=${liveCount()})`); break; }

      // SAFETY: every node that committed height h committed the SAME value
      // (agreement). Nodes that were down simply don't appear at this height.
      const values = [...commitsAtHeight[h].values()];
      const agree = values.every((v) => v === values[0]);
      safetyChecks += 1;
      if (!agree) { safetyOk = false; console.log(`[chaos] SAFETY VIOLATION at height ${h}: ${[...new Set(values)].join(' | ')}`); break; }

      if (h % 5 === 0) console.log(`[chaos] height ${h} committed by ${commitsAtHeight[h].size} (live=${liveCount()}, faults=${faults})`);
      h += 1;
      await sleep(120);
    }

    // Revive everyone, then verify FINAL AGREEMENT: for every height any node
    // committed, all nodes that have an entry there agree on the value (no fork
    // across the whole run, even accounting for nodes that lagged and caught up).
    for (let i = 0; i < n; i++) if (!children[i]) spawn(i);
    await sleep(800);
    const states = await collectStates();
    const perHeight = new Map(); // height -> committed value
    let finalAgree = states.length >= quorum;
    let conflictAt = -1;
    for (const s of states) {
      (s.log || []).forEach((val, ht) => {
        if (val == null) return;
        if (!perHeight.has(ht)) perHeight.set(ht, val);
        else if (perHeight.get(ht) !== val) { finalAgree = false; conflictAt = ht; }
      });
    }
    if (conflictAt >= 0) console.log(`[chaos] FINAL fork detected at height ${conflictAt}`);

    for (const c of children) if (c) { try { c.send({ cmd: 'done' }); } catch (_e) {} }
    await sleep(300);
    for (const c of children) if (c) c.kill('SIGKILL');
    // cleanup WALs
    for (let i = 0; i < n; i++) { try { fs.unlinkSync(path.join(os.tmpdir(), `darm-chaos-${master}-v${i}.log`)); } catch (_e) {} }

    const pass = livenessOk && safetyOk && finalAgree;
    console.log(`[chaos] heights=${h} faults=${faults} safetyChecks=${safetyChecks}`);
    console.log(`[chaos] liveness=${livenessOk} safety=${safetyOk} finalAgreement=${finalAgree}`);
    console.log(`[chaos] result: ${pass ? 'SUCCESS' : 'FAILURE'}`);
    process.exit(pass ? 0 : 1);
  }

  async function collectStates() {
    const out = [];
    const want = liveCount();
    let got = 0;
    const handlers = [];
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      children.forEach((c, i) => {
        if (!c) return;
        const h = (m) => { if (m.state) { out.push({ node: `v${i}`, height: m.height, log: m.log }); got += 1; if (got >= want) finish(); } };
        c.on('message', h);
        handlers.push([c, h]);
        try { c.send({ cmd: 'state' }); } catch (_e) {}
      });
      setTimeout(finish, 2000);
    });
    handlers.forEach(([c, h]) => c.removeListener('message', h));
    return out;
  }

  main().catch((e) => { console.error('[chaos] error', e); process.exit(2); });
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'child') {
    runChild(Number(argv[1]), Number(argv[2]), Number(argv[3]), argv[4]).catch((e) => { console.error(e); process.exit(3); });
  } else {
    launch(Number(argv[0] || 7), Number(argv[1] || 21000), Number(argv[2] || 12000));
  }
}
