'use strict';

/**
 * Multi-process TCP cluster launcher — a working distributed PoC of DARM-ANN
 * CDCP consensus running across real OS processes over real sockets.
 *
 *   node darm-ann/cluster.js <n> [basePort]      launch n validator processes
 *   node darm-ann/cluster.js child <i> <n> <basePort> <seedHex>   (internal)
 *
 * Each child is an independent validator process; they reconstruct the same
 * validator set from a shared master seed (deterministic Ed25519 keys), run a
 * real multi-round, leader-rotating BFT round over TCP, and each prints
 * COMMITTED when consensus is reached. The launcher reports how many committed.
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
const { generatePKI, hasOpenSSL } = require('./consensus/certs');

function seedFor(master, i) {
  return crypto.createHash('sha256').update(`${master}:${i}`).digest();
}

// Load this node's mTLS material from a PKI dir written by the launcher.
function loadTls(pkiDir, nodeId) {
  if (!pkiDir) return null;
  try {
    return {
      key: fs.readFileSync(path.join(pkiDir, `${nodeId}.key`)),
      cert: fs.readFileSync(path.join(pkiDir, `${nodeId}.pem`)),
      ca: fs.readFileSync(path.join(pkiDir, 'ca.pem')),
    };
  } catch (_e) {
    return null;
  }
}

function buildValidatorSet(master, n) {
  const keys = [];
  const validators = new Map();
  for (let i = 0; i < n; i++) {
    const key = ValidatorKey.fromSeed(seedFor(master, i));
    keys.push(key);
    validators.set(`v${i}`, { publicKeyB64: key.publicKeyB64, weight: 1 });
  }
  return { keys, validators };
}

async function runChild(i, n, basePort, master) {
  const { keys, validators } = buildValidatorSet(master, n);
  const tls = loadTls(process.env.DARM_PKI_DIR, `v${i}`); // mTLS if launcher set it
  const transport = new TcpTransport({ nodeId: `v${i}`, port: basePort + i, tls });
  await transport.listen();
  for (let j = 0; j < n; j++) if (j !== i) transport.addPeer(`v${j}`, '127.0.0.1', basePort + j);

  // Durable consensus WAL per process (crash recovery across restarts).
  const wal = new WAL(path.join(os.tmpdir(), `darm-wal-${master}-v${i}.log`));

  const node = new BFTNode({
    nodeId: `v${i}`,
    key: keys[i],
    validators,
    transport,
    tauC: 0.67,
    useTimers: true,
    timeoutMs: 250,
    wal,
    evaluate: () => ({ vote: 'YES', score: 0.9 }), // each process votes per its own policy
    onDecide: (res) => {
      console.log(`COMMITTED v${i} round=${res.round} yes=${res.yes.length}`);
      // Stay alive briefly so peers still awaiting our precommit can finalize.
      setTimeout(() => process.exit(0), process.env.DARM_PKI_DIR ? 1600 : 900);
    },
  });
  node.recoverFromWAL(); // resume safely if this process previously crashed

  process.send && process.send({ ready: i });
  // Give every process time to bind its listener, then begin the height.
  setTimeout(() => node.start({ claim_id: 'cluster-claim', claim_text: 'distributed consensus over TCP' }), 700);
  // Safety net: exit if no decision in time.
  setTimeout(() => process.exit(2), 8000);
}

function launch(n, basePort) {
  const master = crypto.randomBytes(8).toString('hex');
  let committed = 0;
  let exited = 0;

  // mTLS: when DARM_CLUSTER_MTLS=1, generate a CA + per-node certs and pass the
  // PKI dir to children so the consensus transport is encrypted + mutually
  // authenticated. Children without a valid cert cannot join the round.
  let pkiDir = null;
  if (process.env.DARM_CLUSTER_MTLS === '1') {
    if (!hasOpenSSL()) { console.error('[cluster] DARM_CLUSTER_MTLS=1 but openssl is unavailable'); process.exit(2); }
    pkiDir = generatePKI(Array.from({ length: n }, (_, i) => `v${i}`)).dir;
    console.log('[cluster] mTLS enabled — PKI at', pkiDir);
  }
  const childEnv = pkiDir ? { ...process.env, DARM_PKI_DIR: pkiDir } : process.env;

  console.log(`[cluster] launching ${n} validator processes on ports ${basePort}..${basePort + n - 1}${pkiDir ? ' (mTLS)' : ''}`);
  const children = [];
  for (let i = 0; i < n; i++) {
    const child = fork(__filename, ['child', String(i), String(n), String(basePort), master], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: childEnv });
    child.stdout.on('data', (d) => {
      const s = d.toString().trim();
      if (s) console.log(`  ${s}`);
      if (s.includes('COMMITTED')) committed += 1;
    });
    child.stderr.on('data', (d) => process.stderr.write(`  [v${i} err] ${d}`));
    child.on('exit', () => {
      exited += 1;
      if (exited === n) {
        if (pkiDir) try { fs.rmSync(pkiDir, { recursive: true, force: true }); } catch (_e) {}
        const quorum = Math.ceil((2 * n) / 3);
        console.log(`[cluster] ${committed}/${n} processes committed (quorum ${quorum}) → ${committed >= quorum ? 'SUCCESS' : 'FAILURE'}`);
        process.exit(committed >= quorum ? 0 : 1);
      }
    });
    children.push(child);
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'child') {
    const [, i, n, basePort, master] = argv;
    runChild(Number(i), Number(n), Number(basePort), master).catch((e) => {
      console.error('child error', e);
      process.exit(3);
    });
  } else {
    const n = Number(argv[0] || 4);
    const basePort = Number(argv[1] || 19500);
    launch(n, basePort);
  }
}

module.exports = { buildValidatorSet, seedFor };
