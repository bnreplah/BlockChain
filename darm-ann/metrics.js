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
  return out;
}

module.exports = { render };
