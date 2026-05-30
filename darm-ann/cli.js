#!/usr/bin/env node
'use strict';

/**
 * darm — a small CLI to drive and operate a running DARM-ANN node/cluster over
 * its HTTP endpoints. No dependencies (Node's http only).
 *
 *   node darm-ann/cli.js [--host H] [--port P] <command> [args]
 *
 * Commands:
 *   state | health | validators | models
 *   teach "<text>"            refute "<text>"
 *   observe "<text>" [reward] query  "<text>"
 *   navigate "<text>" [steps]
 *   replay | triage | selfcorrect | snapshot
 *   add-validator             remove-validator <nodeId>
 *
 * Env: DARM_HOST, DARM_PORT (defaults 127.0.0.1:3001).
 */

const http = require('http');

function parseArgs(argv) {
  const opts = { host: process.env.DARM_HOST || '127.0.0.1', port: Number(process.env.DARM_PORT || 3001) };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host') opts.host = argv[++i];
    else if (argv[i] === '--port') opts.port = Number(argv[++i]);
    else rest.push(argv[i]);
  }
  return { opts, rest };
}

function request(opts, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: opts.host, port: opts.port, path, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null });
          } catch (_e) {
            resolve({ status: res.statusCode, body: buf });
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const { opts, rest } = parseArgs(process.argv.slice(2));
  const cmd = rest[0];
  const arg = rest[1];
  const q = (s) => encodeURIComponent(s || '');
  let r;
  try {
    switch (cmd) {
      case 'state': r = await request(opts, 'GET', '/darm/state'); break;
      case 'health': r = await request(opts, 'GET', '/darm/health'); break;
      case 'validators': r = await request(opts, 'GET', '/darm/validators'); break;
      case 'models': r = await request(opts, 'GET', '/darm/state'); r.body = r.body && r.body.models; break;
      case 'teach': r = await request(opts, 'POST', '/darm/teach', { claim: arg }); break;
      case 'refute': r = await request(opts, 'POST', '/darm/refute', { claim: arg }); break;
      case 'observe': r = await request(opts, 'POST', '/darm/observe', { claim: arg, reward: Number(rest[2] || 1), epistemic: { conf_cal: 0.9, u_ep: 0.08 } }); break;
      case 'query': r = await request(opts, 'GET', `/darm/query?q=${q(arg)}`); break;
      case 'navigate': r = await request(opts, 'GET', `/darm/navigate?q=${q(arg)}&steps=${Number(rest[2] || 6)}`); break;
      case 'replay': r = await request(opts, 'POST', '/darm/replay'); break;
      case 'triage': r = await request(opts, 'POST', '/darm/triage'); break;
      case 'selfcorrect': r = await request(opts, 'POST', '/darm/selfcorrect'); break;
      case 'snapshot': r = await request(opts, 'POST', '/darm/snapshot'); break;
      case 'add-validator': r = await request(opts, 'POST', '/darm/validators', {}); break;
      case 'remove-validator': r = await request(opts, 'DELETE', `/darm/validators/${q(arg)}`); break;
      default:
        console.log('usage: darm [--host H] [--port P] <state|health|validators|models|teach|refute|observe|query|navigate|replay|triage|selfcorrect|snapshot|add-validator|remove-validator> [args]');
        process.exit(cmd ? 1 : 0);
        return;
    }
    console.log(JSON.stringify(r.body, null, 2));
    process.exit(r.status >= 200 && r.status < 300 ? 0 : 1);
  } catch (e) {
    console.error(`error: ${e.message} (is a node running at ${opts.host}:${opts.port}?)`);
    process.exit(2);
  }
}

main();
