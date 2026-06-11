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
      assert.ok(v.body.version && v.body.paperVersion === '6.0');
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
  } finally {
    await stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('integration harness error:', e); process.exit(2); });
