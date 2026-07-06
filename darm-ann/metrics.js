'use strict';

/**
 * Prometheus exposition-format metrics for a DARM-ANN node. No dependencies —
 * renders the gauges/counters the node already tracks into text/plain;version=0
 * so Prometheus can scrape /darm/metrics and Grafana can chart it.
 */

function line(name, help, type, value, labels = '') {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name}${labels} ${value}\n`;
}

/**
 * render(darm, extra) -> Prometheus text.
 *   darm  — a DarmAnn node (uses its state())
 *   extra — optional { mempoolSize, uptimeSeconds, ... }
 */
function render(darm, extra = {}) {
  const st = darm.state();
  let out = '';
  out += line('darm_tier_entries', 'Entries per memory tier', 'gauge', st.tiers.EB, '{tier="EB"}');
  out += `darm_tier_entries{tier="STM"} ${st.tiers.STM}\n`;
  out += `darm_tier_entries{tier="LTM"} ${st.tiers.LTM}\n`;
  out += `darm_tier_entries{tier="RRC"} ${st.tiers.RRC}\n`;
  out += line('darm_stm_chain_height', 'Short-term memory blockchain height', 'gauge', st.chains.stmHeight);
  out += line('darm_stm_chain_valid', 'STM chain validity (1=valid)', 'gauge', st.chains.stmValid ? 1 : 0);
  out += line('darm_ltm_chain_valid', 'LTM chain validity (1=valid)', 'gauge', st.chains.ltmValid ? 1 : 0);
  out += line('darm_ltm_assoc_edges', 'LTM associative graph edges', 'gauge', st.associativeGraph.edges);
  out += line('darm_markov_states', 'Markov chain-graph states', 'gauge', st.markov.states);
  out += line('darm_markov_edges', 'Markov chain-graph edges', 'gauge', st.markov.edges);
  out += line('darm_rrc_hit_rate', 'Rapid-retrieval-cache hit rate [0,1]', 'gauge', Number(st.rrcHitRate.toFixed(4)));
  out += line('darm_vocab_size', 'Embedder vocabulary size', 'gauge', st.vocab);
  out += line('darm_validators', 'Active CDCP validator count', 'gauge', st.cluster.voters);
  out += line('darm_membership_version', 'Validator-set membership version', 'counter', st.cluster.membershipVersion);
  if (extra.mempoolSize != null) out += line('darm_mempool_size', 'Pending transactions in the gossip mempool', 'gauge', extra.mempoolSize);
  if (extra.uptimeSeconds != null) out += line('darm_uptime_seconds', 'Process uptime in seconds', 'counter', Math.floor(extra.uptimeSeconds));
  if (extra.networkNodes != null) out += line('darm_network_peers', 'Registered network peer count', 'gauge', extra.networkNodes);
  if (extra.tasks) {
    out += `# HELP darm_tasks Tracked operations by status\n# TYPE darm_tasks gauge\n`;
    for (const status of ['queued', 'running', 'done', 'failed']) {
      out += `darm_tasks{status="${status}"} ${extra.tasks[status] || 0}\n`;
    }
  }
  if (extra.buildInfo) {
    const b = extra.buildInfo;
    const esc = (s) => String(s).replace(/["\\]/g, '\\$&');
    out += `# HELP darm_build_info Build/version info (constant 1; value in labels)\n# TYPE darm_build_info gauge\n`;
    out += `darm_build_info{version="${esc(b.version)}",commit="${esc(b.commit)}",paper="${esc(b.paperVersion)}",node="${esc(b.node)}"} 1\n`;
  }
  if (extra.agents) {
    const a = extra.agents;
    out += `# HELP darm_agents Registered agents by tier\n# TYPE darm_agents gauge\n`;
    for (const tier of (a.tierOrder || Object.keys(a.byTier || {}))) {
      out += `darm_agents{tier="${tier}"} ${(a.byTier && a.byTier[tier]) || 0}\n`;
    }
    out += line('darm_agents_online', 'Agents currently online (heartbeat fresh)', 'gauge', a.online || 0);
  }
  if (extra.fabric) {
    const f = extra.fabric;
    out += line('darm_fabric_advertisements', 'Active capability advertisements by this ACS', 'gauge', f.advertisements || 0);
    out += line('darm_fabric_rib_acs', 'ACS entries known in the routing information base', 'gauge', (f.rib && f.rib.acsCount) || 0);
    out += line('darm_fabric_rib_peering_edges', 'Peering edges in the RIB graph', 'gauge', (f.rib && f.rib.peeringEdges) || 0);
    out += line('darm_fabric_sal_adapters', 'Registered SAL adapter ACSs', 'gauge', (f.sal && f.sal.adapters) || 0);
    out += line('darm_fabric_sal_rails', 'Registered settlement rails', 'gauge', (f.sal && f.sal.rails) || 0);
    out += line('darm_fabric_settlement_live', 'Settlement plane live (>=1 rail) [P82]', 'gauge', (f.sal && f.sal.settlementLive) ? 1 : 0);
    out += line('darm_fabric_attestations', 'ATTEST receipts issued', 'counter', f.attestations || 0);
    if (f.ccil && f.ccil.byRole) {
      out += `# HELP darm_fabric_ccil_role CCIL members by role\n# TYPE darm_fabric_ccil_role gauge\n`;
      for (const role of ['LEAF', 'RELAY', 'ANCHOR', 'VALIDATOR']) out += `darm_fabric_ccil_role{role="${role}"} ${(f.ccil.byRole[role]) || 0}\n`;
    }
  }
  return out;
}

module.exports = { render };
