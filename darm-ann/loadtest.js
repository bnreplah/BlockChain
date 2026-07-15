#!/usr/bin/env node
'use strict';

/**
 * HTTP load test — drives real DARM-ANN nodes over their HTTP endpoints to
 * measure end-to-end throughput and latency under concurrency. Round-robins
 * across one or more node base-URLs (so it can hammer a whole cluster), with a
 * configurable concurrency level.
 *
 *   node darm-ann/loadtest.js [requests] [concurrency] [--urls u1,u2] [--mode tx|query|mixed] [--token T]
 *
 * Reports total time, throughput (req/s), success rate, and latency p50/p95/p99.
 * Exits non-zero if the success rate is below 95%.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

function parse(argv) {
  const o = { requests: 500, concurrency: 20, urls: [process.env.DARM_URL || 'http://127.0.0.1:3001'], mode: 'mixed', token: process.env.DARM_TOKEN || '' };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--urls') o.urls = argv[++i].split(',');
    else if (argv[i] === '--mode') o.mode = argv[++i];
    else if (argv[i] === '--token') o.token = argv[++i];
    else pos.push(argv[i]);
  }
  if (pos[0]) o.requests = Number(pos[0]);
  if (pos[1]) o.concurrency = Number(pos[1]);
  return o;
}

function request(base, method, path, body, token) {
  return new Promise((resolve) => {
    const u = new URL(base);
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const lib = u.protocol === 'https:' ? https : http;
    const t0 = process.hrtime.bigint();
    const req = lib.request({ host: u.hostname, port: u.port, path, method, headers, rejectUnauthorized: false }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, ms: Number(process.hrtime.bigint() - t0) / 1e6, code: res.statusCode }));
    });
    req.on('error', () => resolve({ ok: false, ms: Number(process.hrtime.bigint() - t0) / 1e6, code: 0 }));
    if (data) req.write(data);
    req.end();
  });
}

function opFor(mode, i) {
  const claim = `loadtest claim ${i} ${Math.random().toString(36).slice(2, 8)}`;
  if (mode === 'tx' || (mode === 'mixed' && i % 2 === 0)) {
    return { method: 'POST', path: '/darm/tx', body: { type: 'memory', payload: { claim, reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.05 } } } };
  }
  return { method: 'GET', path: `/darm/query?q=${encodeURIComponent(claim)}`, body: null };
}

async function run(o) {
  const results = [];
  let next = 0;
  const t0 = process.hrtime.bigint();

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= o.requests) return;
      const base = o.urls[i % o.urls.length];
      const op = opFor(o.mode, i);
      results.push(await request(base, op.method, op.path, op.body, o.token));
    }
  }
  await Promise.all(Array.from({ length: o.concurrency }, () => worker()));
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const oks = results.filter((r) => r.ok);
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const q = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : 0;
  const round = (x) => Math.round(x * 100) / 100;
  return {
    requests: o.requests, concurrency: o.concurrency, urls: o.urls, mode: o.mode,
    totalMs: round(totalMs),
    throughputRps: round((results.length / totalMs) * 1000),
    successRate: round(oks.length / results.length),
    latencyMs: { p50: round(q(0.5)), p95: round(q(0.95)), p99: round(q(0.99)), max: round(lat[lat.length - 1] || 0) },
  };
}

if (require.main === module) {
  const o = parse(process.argv.slice(2));
  run(o).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.successRate >= 0.95 ? 0 : 1);
  });
}

module.exports = { run };
