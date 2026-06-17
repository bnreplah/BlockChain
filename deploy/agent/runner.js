#!/usr/bin/env node
'use strict';

/**
 * Agent runner — the long-lived process inside the agent container.
 * Reads its tier/capabilities/model from the environment, comes online (VPN up
 * + register + heartbeat), and stays up until SIGTERM/SIGINT, then deregisters.
 *
 * Env:
 *   AGENT_NAME, AGENT_TIER (worker|narrow|generalist|knowledgeable),
 *   AGENT_CAPS (comma list; default = tier defaults),
 *   DARM_MODEL_URL, DARM_TOKEN (or DARM_CLUSTER_TOKEN),
 *   VPN_BACKEND (tailscale|generic|local), TS_AUTHKEY, AGENT_PORT,
 *   AGENT_HEARTBEAT_MS.
 */

const Agent = require('../../darm-ann/agents/agent');

const caps = (process.env.AGENT_CAPS || '').split(',').map((s) => s.trim()).filter(Boolean);

const agent = new Agent({
  name: process.env.AGENT_NAME || undefined,
  tier: process.env.AGENT_TIER || 'worker',
  capabilities: caps.length ? caps : null,
  modelUrl: process.env.DARM_MODEL_URL,
  token: process.env.DARM_TOKEN || process.env.DARM_CLUSTER_TOKEN || '',
  vpn: process.env.VPN_BACKEND || 'local',
  port: Number(process.env.AGENT_PORT || 0),
  heartbeatMs: Number(process.env.AGENT_HEARTBEAT_MS || 20000),
  meta: { image: 'darm-agent', commit: process.env.DARM_GIT_COMMIT || 'unknown' },
});

let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`[agent] ${sig} received — going offline`);
  try { await agent.offline(); } catch (_e) {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

(async () => {
  // Retry registration with backoff — the model may not be reachable yet.
  for (let attempt = 1; ; attempt++) {
    try {
      const info = await agent.online();
      console.log(`[agent] online: id=${info.id} tier=${info.tier} caps=[${info.capabilities.join(',')}] vpn=${info.vpn.backend}@${info.vpn.ip}`);
      break;
    } catch (e) {
      const wait = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
      console.error(`[agent] registration attempt ${attempt} failed: ${e.message}; retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  // Keep the process alive; heartbeat runs on its own timer.
  setInterval(() => {}, 1 << 30);
})();
