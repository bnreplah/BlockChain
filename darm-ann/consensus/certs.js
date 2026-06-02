'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Minimal mTLS PKI helper for the consensus transport. Generates a self-signed
 * CA and node certificates signed by it, using the system `openssl` (no npm
 * deps). Intended for tests / single-operator clusters; production deployments
 * would mount externally-managed certs instead.
 *
 *   const { ca, nodes } = generatePKI(['v0','v1','v2'])
 *   new TcpTransport({ ..., tls: { key: nodes.v0.key, cert: nodes.v0.cert, ca } })
 */
function hasOpenSSL() {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch (_e) { return false; }
}

function generatePKI(nodeIds) {
  if (!hasOpenSSL()) throw new Error('openssl not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darm-pki-'));
  const run = (args) => execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    // CA
    run(['genrsa', '-out', path.join(dir, 'ca.key'), '2048']);
    run(['req', '-x509', '-new', '-nodes', '-key', path.join(dir, 'ca.key'), '-sha256', '-days', '1', '-subj', '/CN=darm-ca', '-out', path.join(dir, 'ca.pem')]);
    const ca = fs.readFileSync(path.join(dir, 'ca.pem'));
    const nodes = {};
    for (const id of nodeIds) {
      const k = path.join(dir, `${id}.key`);
      const csr = path.join(dir, `${id}.csr`);
      const crt = path.join(dir, `${id}.pem`);
      run(['genrsa', '-out', k, '2048']);
      run(['req', '-new', '-key', k, '-subj', `/CN=${id}`, '-out', csr]);
      run(['x509', '-req', '-in', csr, '-CA', path.join(dir, 'ca.pem'), '-CAkey', path.join(dir, 'ca.key'), '-CAcreateserial', '-days', '1', '-sha256', '-out', crt]);
      nodes[id] = { key: fs.readFileSync(k), cert: fs.readFileSync(crt) };
    }
    return { ca, nodes, dir };
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
    throw e;
  }
}

module.exports = { generatePKI, hasOpenSSL };
