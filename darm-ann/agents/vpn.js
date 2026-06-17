'use strict';

const { execFile } = require('child_process');
const os = require('os');

/**
 * VPN adapters — bring an agent onto a private network when it comes online,
 * then report the address peers should reach it on. Pluggable so the same
 * registration flow works on Tailscale, a generic WireGuard/VPN, or locally.
 *
 * Adapter contract:
 *   async up()    -> { ok, ip, backend, detail }   join the network, return IP
 *   async down()  -> void                           leave (best-effort)
 */

function run(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() });
    });
  });
}

/**
 * Tailscale adapter. Uses `tailscale up` with an auth key (from opts or
 * TS_AUTHKEY) and reads the assigned 100.x IP from `tailscale ip -4`.
 * Designed to run inside the agent container (see deploy/agent/*).
 */
function tailscaleAdapter(opts = {}) {
  const authKey = opts.authKey || process.env.TS_AUTHKEY || '';
  const hostname = opts.hostname || process.env.TS_HOSTNAME || os.hostname();
  return {
    name: 'tailscale',
    async up() {
      const args = ['up', '--accept-routes', `--hostname=${hostname}`];
      if (authKey) args.push(`--authkey=${authKey}`);
      const upRes = await run('tailscale', args, 30000);
      const ipRes = await run('tailscale', ['ip', '-4'], 8000);
      const ip = (ipRes.stdout.split('\n').map((s) => s.trim()).find(Boolean)) || null;
      const ok = upRes.code === 0 && !!ip;
      return { ok, ip, backend: 'tailscale', detail: ok ? `joined as ${hostname}` : (upRes.stderr || ipRes.stderr || 'tailscale up failed') };
    },
    async down() { await run('tailscale', ['down'], 8000); },
  };
}

/** Generic VPN adapter: assumes an external process brought the tunnel up;
 *  reads the IP from a configured interface (VPN_IFACE) or env (VPN_IP). */
function genericVpnAdapter(opts = {}) {
  const iface = opts.iface || process.env.VPN_IFACE || 'wg0';
  const fixedIp = opts.ip || process.env.VPN_IP || null;
  return {
    name: 'generic-vpn',
    async up() {
      if (fixedIp) return { ok: true, ip: fixedIp, backend: 'generic-vpn', detail: 'from VPN_IP' };
      const addrs = os.networkInterfaces()[iface] || [];
      const v4 = addrs.find((a) => a.family === 'IPv4' && !a.internal);
      return v4 ? { ok: true, ip: v4.address, backend: 'generic-vpn', detail: `iface ${iface}` } : { ok: false, ip: null, backend: 'generic-vpn', detail: `no IPv4 on ${iface}` };
    },
    async down() {},
  };
}

/** Local/no-op adapter for development and tests — uses the first non-internal
 *  IPv4 (or 127.0.0.1). No network changes are made. */
function localAdapter() {
  return {
    name: 'local',
    async up() {
      const ifs = os.networkInterfaces();
      let ip = '127.0.0.1';
      for (const list of Object.values(ifs)) {
        const v4 = (list || []).find((a) => a.family === 'IPv4' && !a.internal);
        if (v4) { ip = v4.address; break; }
      }
      return { ok: true, ip, backend: 'local', detail: 'no VPN (development)' };
    },
    async down() {},
  };
}

/** Choose an adapter by name (env VPN_BACKEND or explicit). */
function adapterFor(name, opts = {}) {
  switch ((name || process.env.VPN_BACKEND || 'local').toLowerCase()) {
    case 'tailscale': return tailscaleAdapter(opts);
    case 'generic':
    case 'wireguard':
    case 'vpn': return genericVpnAdapter(opts);
    default: return localAdapter();
  }
}

module.exports = { tailscaleAdapter, genericVpnAdapter, localAdapter, adapterFor };
