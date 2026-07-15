'use strict';

/**
 * Integration tests — boots the REAL Express server (app.js) as a child process
 * and exercises the full HTTP API over the wire: version/health/ready, RBAC,
 * rate limiting, the teach→observe→consolidate→query lifecycle, gossip mempool,
 * tasks/monitor, audit, metrics, and the backup→restore round-trip.
 *
 * No test framework: a tiny async runner. Run: `node darm-ann/integration.test.js`
 * Each server runs on an ephemeral port with an isolated temp data dir.
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let passed = 0;
let failed = 0;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    results.push(`  ✗ ${name}\n      ${e.message}`);
  }
}

function req(port, method, p, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch (_e) {}
        resolve({ status: res.statusCode, body: json, raw: buf, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitHealthy(port, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await req(port, 'GET', '/darm/health'); if (r.status === 200) return true; } catch (_e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become healthy on port ' + port);
}

function startServer(port, env = {}) {
  const child = spawn(process.execPath, ['app.js', String(port), `http://localhost:${port}`], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DARM_MIN_AGE_MS: '0', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));
  child._stderr = () => stderr;
  return child;
}

function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGKILL');
    setTimeout(resolve, 1000);
  });
}

const PORT = 3201 + Math.floor(Math.random() * 200);
const TOKEN_OP = 'op-int-token';
const TOKEN_RO = 'ro-int-token';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darm-int-'));

async function main() {
  console.log('\nDARM-ANN integration tests (real server over HTTP)\n');
  const env = {
    DARM_TOKENS: `${TOKEN_OP}:operator,${TOKEN_RO}:read`,
    DARM_SNAPSHOT: path.join(dataDir, 'node.json'),
    DARM_AUDIT_FILE: path.join(dataDir, 'audit.log'),
    DARM_RATE_CAPACITY: '1000',
    DARM_RATE_PER_SEC: '1000',
  };
  const server = startServer(PORT, env);

  try {
    await waitHealthy(PORT);

    await test('version + ready are open and report build info', async () => {
      const v = await req(PORT, 'GET', '/darm/version');
      assert.strictEqual(v.status, 200);
      assert.ok(v.body.version && v.body.paperVersion === '7.2');
      const r = await req(PORT, 'GET', '/darm/ready');
      assert.strictEqual(r.status, 200);
    });

    await test('RBAC: no token 401, read token 403 on mutation, operator 200', async () => {
      assert.strictEqual((await req(PORT, 'GET', '/darm/state')).status, 401);
      assert.strictEqual((await req(PORT, 'GET', '/darm/state', { token: TOKEN_RO })).status, 200);
      assert.strictEqual((await req(PORT, 'POST', '/darm/replay', { token: TOKEN_RO })).status, 403);
      assert.strictEqual((await req(PORT, 'POST', '/darm/replay', { token: TOKEN_OP })).status, 200);
    });

    const CLAIM = 'integration test consolidated knowledge';
    await test('lifecycle: teach → observe → consolidate → query (RRC/LTM hit)', async () => {
      assert.strictEqual((await req(PORT, 'POST', '/darm/teach', { token: TOKEN_OP, body: { claim: CLAIM } })).status, 200);
      assert.strictEqual((await req(PORT, 'POST', '/darm/observe', { token: TOKEN_OP, body: { claim: CLAIM, reward: 1, epistemic: { conf_cal: 0.92, u_ep: 0.05 } } })).status, 200);
      await req(PORT, 'POST', '/darm/replay', { token: TOKEN_OP });
      const st = await req(PORT, 'GET', '/darm/state', { token: TOKEN_RO });
      assert.ok(st.body.tiers.LTM >= 1, 'claim consolidated to LTM');
      assert.ok(st.body.chains.ltmValid, 'LTM chain valid');
      const q = await req(PORT, 'GET', '/darm/query?q=' + encodeURIComponent(CLAIM), { token: TOKEN_RO });
      assert.ok(q.body.hit && (q.body.tier === 'RRC' || q.body.tier === 'LTM'), 'retrieved from ' + q.body.tier);
    });

    await test('gossip mempool: submit a tx, it is admitted', async () => {
      const r = await req(PORT, 'POST', '/darm/tx', { token: TOKEN_OP, body: { type: 'memory', payload: { claim: 'gossip integration claim', reward: 1 } } });
      assert.strictEqual(r.status, 200);
      const mp = await req(PORT, 'GET', '/darm/mempool', { token: TOKEN_RO });
      assert.ok(mp.body.size >= 1);
    });

    await test('tasks were tracked and at least one completed', async () => {
      const t = await req(PORT, 'GET', '/darm/tasks', { token: TOKEN_RO });
      assert.ok(t.body.summary.done >= 1, 'a task completed');
      const monitor = await req(PORT, 'GET', '/darm/monitor');
      assert.strictEqual(monitor.status, 200);
    });

    await test('audit recorded the operator mutations', async () => {
      const a = await req(PORT, 'GET', '/darm/audit', { token: TOKEN_RO });
      assert.ok(a.body.size >= 1);
      assert.ok(a.body.entries.some((e) => e.action === 'teach'));
    });

    await test('metrics expose tiers, chain validity, and build info', async () => {
      const m = await req(PORT, 'GET', '/darm/metrics');
      assert.strictEqual(m.status, 200);
      assert.ok(/darm_tier_entries\{tier="LTM"\} \d+/.test(m.raw));
      assert.ok(/darm_ltm_chain_valid 1/.test(m.raw));
      assert.ok(/darm_build_info\{version=/.test(m.raw));
    });

    let archive = null;
    await test('backup returns a verifiable archive', async () => {
      const b = await req(PORT, 'POST', '/darm/backup?download=1', { token: TOKEN_OP });
      assert.strictEqual(b.status, 200);
      assert.ok(b.body.archive && b.body.archive.files.includes('node.json'));
      archive = b.body.archive;
    });

    await test('restore on a FRESH server recovers the consolidated memory', async () => {
      const port2 = PORT + 1;
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'darm-int2-'));
      const srv2 = startServer(port2, { DARM_TOKENS: env.DARM_TOKENS, DARM_SNAPSHOT: path.join(dir2, 'node.json'), DARM_AUDIT_FILE: path.join(dir2, 'audit.log') });
      try {
        await waitHealthy(port2);
        const before = await req(port2, 'GET', '/darm/state', { token: TOKEN_RO });
        assert.strictEqual(before.body.tiers.LTM, 0, 'fresh node starts empty');
        const r = await req(port2, 'POST', '/darm/restore', { token: TOKEN_OP, body: { archive } });
        assert.strictEqual(r.status, 200, 'restore ok: ' + JSON.stringify(r.body));
        assert.ok(r.body.ltm >= 1 && r.body.ltmValid);
        const q = await req(port2, 'GET', '/darm/query?q=' + encodeURIComponent(CLAIM), { token: TOKEN_RO });
        assert.ok(q.body.hit, 'restored memory is retrievable');
      } finally {
        await stop(srv2);
        fs.rmSync(dir2, { recursive: true, force: true });
      }
    });

    await test('rate limiter returns 429 when the bucket is exhausted', async () => {
      const port3 = PORT + 2;
      const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'darm-int3-'));
      const srv3 = startServer(port3, { DARM_TOKENS: env.DARM_TOKENS, DARM_RATE_CAPACITY: '3', DARM_RATE_PER_SEC: '0', DARM_SNAPSHOT: path.join(dir3, 'node.json') });
      try {
        await waitHealthy(port3);
        const codes = [];
        for (let i = 0; i < 6; i++) codes.push((await req(port3, 'GET', '/darm/state', { token: TOKEN_RO })).status);
        assert.ok(codes.includes(429), 'expected a 429, got ' + codes.join(','));
      } finally {
        await stop(srv3);
        fs.rmSync(dir3, { recursive: true, force: true });
      }
    });

    await test('agentic lifecycle: come online → register → route → deregister', async () => {
      const Agent = require('./agents/agent');
      // A "dumb router" (narrow) and a worker register against the live model.
      const router = new Agent({ name: 'dumb-router', tier: 'narrow', capabilities: ['route'], modelUrl: `http://127.0.0.1:${PORT}`, token: TOKEN_OP, vpn: 'local', heartbeatMs: 100000 });
      const worker = new Agent({ name: 'runner-1', tier: 'worker', capabilities: ['execute', 'run-tool'], modelUrl: `http://127.0.0.1:${PORT}`, token: TOKEN_OP, vpn: 'local', heartbeatMs: 100000 });
      const know = new Agent({ name: 'brain-1', tier: 'knowledgeable', capabilities: ['route', 'teach', 'query'], modelUrl: `http://127.0.0.1:${PORT}`, token: TOKEN_OP, vpn: 'local', heartbeatMs: 100000 });
      try {
        const r1 = await router.online();
        const r2 = await worker.online();
        const r3 = await know.online();
        assert.ok(r1.id && r2.id && r3.id, 'all agents got ids');
        assert.ok(r1.vpn.ok && r1.vpn.ip, 'VPN (local) brought the agent online with an IP');

        // The registry lists them and aggregates capabilities.
        const list = await req(PORT, 'GET', '/agents', { token: TOKEN_RO });
        assert.ok(list.body.stats.total >= 3 && list.body.stats.online >= 3);
        assert.ok(list.body.capabilities.includes('execute') && list.body.capabilities.includes('teach'));

        // Routing 'route' prefers the narrow dumb-router (lowest capable tier).
        const route = await req(PORT, 'GET', '/agents/route?capability=route', { token: TOKEN_RO });
        assert.ok(route.body.ok && route.body.agent.tier === 'narrow', 'dumb router selected for routing');
        // 'teach' only exists on the knowledgeable tier → escalation.
        const teach = await req(PORT, 'GET', '/agents/route?capability=teach', { token: TOKEN_RO });
        assert.ok(teach.body.ok && teach.body.agent.tier === 'knowledgeable');
        // 'execute' → the worker.
        const exec = await req(PORT, 'GET', '/agents/route?capability=execute', { token: TOKEN_RO });
        assert.ok(exec.body.ok && exec.body.agent.tier === 'worker');

        // Discovery via the agent client.
        const disc = await worker.discover('teach');
        assert.ok(disc.ok && disc.agent.tier === 'knowledgeable');
      } finally {
        await router.offline(); await worker.offline(); await know.offline();
      }
      const after = await req(PORT, 'GET', '/agents', { token: TOKEN_RO });
      assert.strictEqual(after.body.stats.total, 0, 'all agents deregistered on offline()');
    });

    await test('v7.2 fabric: ACS state, capability advertise, and DIRP-1 job lifecycle', async () => {
      // Node is an ACS with a role earned from its stake/uptime/bvas.
      const st = await req(PORT, 'GET', '/fabric/state', { token: TOKEN_RO });
      assert.ok(st.body.acsn && ['LEAF', 'RELAY', 'ANCHOR', 'VALIDATOR'].includes(st.body.role));
      assert.ok(st.body.advertisements >= 1, 'node self-advertised a capability');

      // A second ACS (peer) advertises a tinylm capability; we gossip it in + peer.
      const Fabric = require('./fabric');
      const peer = Fabric.fromSeed(require('crypto').createHash('sha256').update('int-peer').digest());
      const ad = peer.advertise({ model_classes: ['tinylm'], trust_score: 0.9, latency_class: 5, price_curve: 2, sync_classes: ['async'], conf_classes: ['redact'] });
      const g = await req(PORT, 'POST', '/fabric/gossip', { token: TOKEN_OP, body: { record: ad } });
      assert.ok(g.body.ok, 'peer advertisement ingested');
      await req(PORT, 'POST', '/fabric/peer', { token: TOKEN_OP, body: { acsn: peer.acsn } });

      // Register a settlement rail so SETTLE works.
      const rail = await req(PORT, 'POST', '/fabric/rails', { token: TOKEN_OP, body: { finality_bound: 5000, proof_format: 'merkle', escrow_primitive: 'htlc', dispute_hook: 'arb', denomination: 'credit' } });
      assert.ok(rail.body.ok, 'rail registered');

      // Route + run a job to the tinylm provider (async / redact).
      const job = await req(PORT, 'POST', '/fabric/job', { token: TOKEN_OP, body: { model_class: 'tinylm', payload: 'reach analyst alice@corp.com', budget: 8, sync_class: 'async', conf_class: 'redact' } });
      assert.ok(job.body.ok, 'job routed + executed: ' + JSON.stringify(job.body).slice(0, 120));
      assert.strictEqual(job.body.route.target, peer.acsn, 'routed to the advertising peer');
      assert.ok(/<email>/.test(JSON.stringify(job.body.output)), 'rung-0 redaction applied');
      assert.ok(job.body.settle && job.body.settle.valid, 'settled on the registered rail');

      // Fabric metrics are exposed.
      const m = await req(PORT, 'GET', '/darm/metrics');
      assert.ok(/darm_fabric_advertisements \d+/.test(m.raw) && /darm_fabric_settlement_live 1/.test(m.raw));
    });

    await test('v7.2 memory federation: LTM blockchain answers a DIRP-1 QUERY + checkpoint + breathe', async () => {
      // Teach + consolidate a fact so it lands on the node's LTM blockchain.
      const claim = 'the fabric federates memory across distributed nodes';
      await req(PORT, 'POST', '/darm/teach', { token: TOKEN_OP, body: { claim } });
      await req(PORT, 'POST', '/darm/observe', { token: TOKEN_OP, body: { claim, reward: 1, epistemic: { conf_cal: 0.92, u_ep: 0.05 } } });
      await req(PORT, 'POST', '/darm/replay', { token: TOKEN_OP });

      // DIRP-1 QUERY answers from this node's LTM blockchain shard.
      const q = await req(PORT, 'GET', '/fabric/query?q=' + encodeURIComponent(claim), { token: TOKEN_RO });
      assert.ok(q.body.hit && q.body.claim === claim && q.body.blockHash, 'shard answered from the LTM chain');

      // Federated query with the local shard's answer as the only source.
      const fed = await req(PORT, 'POST', '/fabric/federated-query', { token: TOKEN_OP, body: { q: claim, peerAnswers: [] } });
      assert.ok(fed.body.hit && fed.body.claim === claim);

      // Checkpoint the memory blockchain (global-chain root) + one breath.
      const cp = await req(PORT, 'POST', '/fabric/checkpoint', { token: TOKEN_OP });
      assert.ok(cp.body.head && cp.body.valid, 'checkpoint of the memory chain');
      const br = await req(PORT, 'POST', '/fabric/breathe', { token: TOKEN_OP });
      assert.ok(br.body.memoryValid, 'breath reports memory-chain validity');

      // Memory-federation metrics present.
      const m2 = await req(PORT, 'GET', '/darm/metrics');
      assert.ok(/darm_fabric_memory_valid 1/.test(m2.raw) && /darm_fabric_memory_height \d+/.test(m2.raw));
    });
  } finally {
    await stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('integration harness error:', e); process.exit(2); });
