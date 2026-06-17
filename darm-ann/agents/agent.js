'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { TIERS, isTier } = require('./tiers');
const { adapterFor } = require('./vpn');

/**
 * Agent — a node that, when it comes online:
 *   1. joins the VPN (Tailscale/WireGuard/local) and learns its address,
 *   2. registers its TIER + CAPABILITIES to the model's agent registry (the
 *      linked list) over HTTP, receiving an agent id,
 *   3. heartbeats periodically so it stays "online", and
 *   4. deregisters on graceful shutdown.
 *
 * This is the client side of agentic registration. The server side (the model)
 * exposes /agents/* endpoints backed by AgentRegistry + AgentRouter.
 */
class Agent {
  constructor({
    name,
    tier = 'worker',
    capabilities = null,
    modelUrl,                       // base URL of the model/registry node
    token = process.env.DARM_TOKEN || process.env.DARM_CLUSTER_TOKEN || '',
    vpn = process.env.VPN_BACKEND || 'local',
    vpnOpts = {},
    port = Number(process.env.AGENT_PORT || 0),
    heartbeatMs = Number(process.env.AGENT_HEARTBEAT_MS || 20000),
    meta = {},
  } = {}) {
    if (!isTier(tier)) throw new Error(`unknown tier: ${tier}`);
    this.name = name || `${tier}-${Math.random().toString(36).slice(2, 8)}`;
    this.tier = tier;
    // Default to the tier's standard capabilities if none given.
    this.capabilities = capabilities || TIERS[tier].defaultCapabilities.slice();
    this.modelUrl = (modelUrl || process.env.DARM_MODEL_URL || 'http://localhost:3001').replace(/\/$/, '');
    this.token = token;
    this.vpnAdapter = adapterFor(vpn, vpnOpts);
    this.port = port;
    this.heartbeatMs = heartbeatMs;
    this.meta = meta;
    this.id = null;
    this.vpnIp = null;
    this._hbTimer = null;
  }

  _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const u = new URL(this.modelUrl + path);
      const data = body != null ? JSON.stringify(body) : null;
      const headers = {};
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
      if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, rejectUnauthorized: false }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => { let j = null; try { j = buf ? JSON.parse(buf) : null; } catch (_e) {} resolve({ status: res.statusCode, body: j }); });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  /** Step 1+2: come online → VPN up → register capabilities to the model. */
  async online() {
    const vpn = await this.vpnAdapter.up();
    this.vpnIp = vpn.ip;
    const endpoint = this.port && vpn.ip ? `http://${vpn.ip}:${this.port}` : null;
    const res = await this._request('POST', '/agents/register', {
      name: this.name,
      tier: this.tier,
      capabilities: this.capabilities,
      endpoint,
      vpnIp: vpn.ip,
      meta: { ...this.meta, vpnBackend: vpn.backend, vpnDetail: vpn.detail },
    });
    if (res.status !== 200 || !res.body || !res.body.id) {
      throw new Error(`registration failed (status ${res.status}): ${JSON.stringify(res.body)}`);
    }
    this.id = res.body.id;
    this._startHeartbeat();
    return { id: this.id, tier: this.tier, capabilities: this.capabilities, vpn };
  }

  _startHeartbeat() {
    this.stopHeartbeat();
    this._hbTimer = setInterval(() => {
      this._request('POST', '/agents/heartbeat', { id: this.id }).catch(() => {});
    }, this.heartbeatMs);
    if (this._hbTimer.unref) this._hbTimer.unref();
  }

  stopHeartbeat() {
    if (this._hbTimer) clearInterval(this._hbTimer);
    this._hbTimer = null;
  }

  /** Step 4: graceful shutdown — deregister and leave the VPN. */
  async offline() {
    this.stopHeartbeat();
    if (this.id) { try { await this._request('POST', '/agents/deregister', { id: this.id }); } catch (_e) {} }
    try { await this.vpnAdapter.down(); } catch (_e) {}
  }

  /** Discover where to route a capability (asks the model's router). */
  async discover(capability) {
    const res = await this._request('GET', `/agents/route?capability=${encodeURIComponent(capability)}`);
    return res.body;
  }
}

module.exports = Agent;
