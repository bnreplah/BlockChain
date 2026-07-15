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

rule('6. Two memory blockchains + self-correction');
line(`STM chain height=${node.stm.chain.height}, valid=${node.stm.validateChain().valid}`);
line(`LTM chain valid=${node.ltm.validate().valid}`);
node.stm.chain.blocks.length > 1 && (node.stm.chain.blocks[1].payload.claim_text = 'TAMPERED');
line(`after tampering STM block → valid=${node.stm.validateChain().valid}`);
const corrected = node.selfCorrect();
line(`selfCorrect → ${JSON.stringify(corrected)}`);
line(`STM chain valid again=${node.stm.validateChain().valid}`);

rule('7. Markov chain-graph navigation (TinyLM-directed)');
const nav = new DarmAnn({ nodeId: 'nav', config: { cdcp: { tMinAgeMs: 0 } } });
const steps = ['initialise consensus round', 'collect prevotes from validators', 'reach precommit quorum', 'commit block to chain'];
for (let r = 0; r < 3; r++) for (const s of steps) nav.observe({ claim: s, reward: 0.9, epistemic: { conf_cal: 0.85, u_ep: 0.1 } });
line('markov graph: ' + JSON.stringify(nav.markov.stats()));
const navigation = nav.navigate('initialise consensus round', 5);
line('model-directed path:');
navigation.path.forEach((p, i) => line(`  ${i}. ${p}`));
line('models held: ' + nav.registry.list().map((m) => m.name).join(', '));

line('\nDone.\n');
