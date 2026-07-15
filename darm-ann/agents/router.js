'use strict';

/**
 * AgentRouter — dispatches a capability request to an agent in the registry.
 *
 * Policy: prefer the LOWEST-capability tier that can satisfy the request
 * (don't burn a knowledgeable agent on a job a worker can do), escalating
 * upward only when no lower tier advertises the capability. Within a tier,
 * pick by least-recently-used (fair load spreading) among online agents.
 *
 * The "dumb router" (a narrow-tier agent with only the `route` capability) is
 * itself selectable here — it does no reasoning, just classification/forward.
 */
class AgentRouter {
  constructor(registry) {
    this.registry = registry;
    this._lastPick = new Map(); // capability -> last picked agent id (for LRU-ish spread)
  }

  /**
   * Select an agent for a capability.
   * @param {string} capability
   * @param {object} opts { minTier, preferTier }
   * @returns the chosen agent record, or null.
   */
  select(capability, { minTier = null, preferTier = null } = {}) {
    let candidates = this.registry.findByCapability(capability, { onlineOnly: true });
    if (minTier) {
      const { rankOf } = require('./tiers');
      candidates = candidates.filter((a) => a.rank >= rankOf(minTier));
    }
    if (candidates.length === 0) return null;

    if (preferTier) {
      const pref = candidates.filter((a) => a.tier === preferTier);
      if (pref.length) candidates = pref;
    } else {
      // Lowest capable tier that can do it (candidates already rank-ascending).
      const lowestRank = candidates[0].rank;
      candidates = candidates.filter((a) => a.rank === lowestRank);
    }

    // LRU-ish spread within the chosen tier.
    const last = this._lastPick.get(capability);
    let pick = candidates.find((a) => a.id !== last) || candidates[0];
    this._lastPick.set(capability, pick.id);
    return pick;
  }

  /**
   * Full routing decision with provenance — what was chosen and why.
   * @returns { ok, agent, capability, reason, alternatives }
   */
  route(capability, opts = {}) {
    const all = this.registry.findByCapability(capability, { onlineOnly: true });
    const agent = this.select(capability, opts);
    if (!agent) {
      return { ok: false, capability, reason: 'no online agent advertises this capability', alternatives: [] };
    }
    return {
      ok: true,
      capability,
      agent: { id: agent.id, name: agent.name, tier: agent.tier, endpoint: agent.endpoint, vpnIp: agent.vpnIp },
      reason: `selected ${agent.tier} agent (rank ${agent.rank}) by lowest-capable-tier + LRU spread`,
      alternatives: all.filter((a) => a.id !== agent.id).map((a) => ({ id: a.id, tier: a.tier })),
    };
  }

  /**
   * Escalation chain: ordered agents to try for a capability, cheapest tier
   * first. Useful for fallback when a worker fails and a generalist is needed.
   */
  escalationChain(capability) {
    return this.registry.findByCapability(capability, { onlineOnly: true })
      .map((a) => ({ id: a.id, name: a.name, tier: a.tier, rank: a.rank, endpoint: a.endpoint }));
  }
}

module.exports = AgentRouter;
