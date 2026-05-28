'use strict';

/**
 * DARM-ANN v6.0 — narrated demo.  Run: `node darm-ann/demo.js`
 *
 * Walks the end-to-end memory flow (§11), then shows the self-contained PoW
 * substrate, poly-chain morphism, and cross-chain pollination across a swarm.
 */

const DarmAnn = require('./index');
const { standaloneAdapter, powAdapter } = require('./network/chainAdapter');

const line = (s = '') => console.log(s);
const rule = (t) => line(`\n──────── ${t} ────────`);

// Use a zero minimum-age so consolidation can happen inline in the demo.
const cfg = { config: { cdcp: { tMinAgeMs: 0 } } };

rule('1. End-to-end memory flow (§11): TLS 1.3 forward secrecy');
const node = new DarmAnn({ nodeId: 'demo', ...cfg });
const claim = 'TLS 1.3 mandates forward secrecy via ephemeral key exchange';

line('query before learning →');
line('  ' + JSON.stringify(node.query(claim)));

node.teach(claim); // the cluster grounds this fact in its G_K
node.observe({ claim, reward: 1, epistemic: { conf_cal: 0.91, u_ep: 0.08 } });
line(`\nafter observe: STM=${node.state().tiers.STM}, LTM=${node.state().tiers.LTM}`);

const res = node.consolidate(node.stm.all()[0].claim_id);
line(`\nCDCP consensus → ${res.status} (consolidated confidence ${res.consolidatedConf.toFixed(3)})`);
line(`  ${res.votes.filter((v) => v.vote === 'YES').length}/${res.votes.length} nodes voted YES`);
line(`  committed block ${res.block.hash.slice(0, 16)}…`);

line('\nquery after consolidation →');
line('  ' + JSON.stringify(node.query(claim)));

rule('2. Self-contained PoW substrate (no Redis / no external chain)');
const powNode = new DarmAnn({ nodeId: 'pow-demo', config: { cdcp: { tMinAgeMs: 0 } }, adapter: powAdapter({ difficulty: 4 }) });
const c = 'sharp wave ripples drive hippocampal replay during NREM sleep';
powNode.teach(c);
powNode.observe({ claim: c, reward: 1, epistemic: { conf_cal: 0.93, u_ep: 0.05 } });
const powRes = powNode.consolidate(powNode.stm.all()[0].claim_id);
line(`mined PoW block: ${powRes.block.hash.slice(0, 24)}…  (substrate: ${powNode.ltm.mode})`);

rule('3. Poly-chain morphism — swap substrate at runtime');
const morphNode = new DarmAnn({ nodeId: 'morph', config: { cdcp: { tMinAgeMs: 0 } }, adapter: standaloneAdapter() });
line(`start substrate: ${morphNode.ltm.mode}`);
morphNode.morph(powAdapter({ difficulty: 3 }));
line(`morphed substrate: ${morphNode.ltm.mode}`);

rule('4. Cross-chain pollination across a poly-chain swarm');
const { Swarm } = DarmAnn;
const a = new DarmAnn({ nodeId: 'A', config: { cdcp: { tMinAgeMs: 0 } }, adapter: standaloneAdapter() });
const b = new DarmAnn({ nodeId: 'B', config: { cdcp: { tMinAgeMs: 0 } }, adapter: powAdapter({ difficulty: 2 }) });
const facts = [
  'merkle proofs verify transaction inclusion in logarithmic time',
  'group relative policy optimisation reduces variance in RL training',
  'elastic weight consolidation prevents catastrophic forgetting',
];
for (const f of facts) {
  a.teach(f);
  a.observe({ claim: f, reward: 1, epistemic: { conf_cal: 0.9, u_ep: 0.06 } });
  a.consolidate(a.stm.all().find((e) => !e.promoted).claim_id);
}
line(`before: A.LTM=${a.ltm.size}, B.LTM=${b.ltm.size}`);
const swarm = new Swarm({ nodes: [a, b] });
const pr = swarm.pollinate({ strategy: 'top-confidence', topK: 5 });
line(`pollination: offered=${pr.offered}, accepted=${pr.accepted}, re-consolidated=${pr.reconsolidated}`);
line(`after:  A.LTM=${a.ltm.size}, B.LTM=${b.ltm.size}`);
line('swarm growth: ' + JSON.stringify(swarm.growth()));

rule('5. Associative network growth (Hebbian wiring)');
line('A associative graph: ' + JSON.stringify(a.ltm.graphStats()));

line('\nDone.\n');
