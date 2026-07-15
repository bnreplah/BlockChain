'use strict';

/**
 * DARM-ANN v7.2 — Phase-1 two-ACS peering demo (roadmap §9.1 exit gate).
 *
 *   node darm-ann/fabricDemo.js
 *
 * Demonstrates the publishable artifact the v7.2 roadmap names as the next
 * stage of testing: a job originating in ACS-A executes in ACS-B with a
 * verifiable ATTEST receipt and settlement, routed via DIRP-1 as
 * `sync_class=async, conf_class=redact` end-to-end. Also shows onion routing
 * (privacy plane, P65) and the CCIL role ladder + PoUI economics.
 *
 * In-process (two Fabric instances) so it is dependency-free and CI-friendly;
 * the same objects run across real processes/TCP in production.
 */

const crypto = require('crypto');
const Fabric = require('./fabric');
const LongTermMemory = require('./memory/longTermMemory');
const { embed } = require('./util/embedding');

const line = (s = '') => console.log(s);
const rule = (t) => line(`\n──────── ${t} ────────`);

(async () => {
  rule('1. Two ACSs come online (Ed25519 identity = ACSN)');
  // Each ACS carries its own LONG-TERM MEMORY BLOCKCHAIN — the memory fabric.
  const ltmA = new LongTermMemory({ dim: 64 });
  const ltmB = new LongTermMemory({ dim: 64 });
  const A = Fabric.fromSeed(crypto.createHash('sha256').update('demo-A').digest(), { name: 'acs-A', ccil: { stake: 600, uptime: 1, bvas: 0.9 }, ltmProvider: () => ltmA, embed: (t) => embed(t, 64) });
  const B = Fabric.fromSeed(crypto.createHash('sha256').update('demo-B').digest(), { name: 'acs-B', ccil: { stake: 800, uptime: 0.995, bvas: 0.92 }, ltmProvider: () => ltmB, embed: (t) => embed(t, 64) });
  A.ccil.reconcile(A.acsn); B.ccil.reconcile(B.acsn);
  line(`A ${A.acsn.slice(0, 12)} role=${A.ccil.role(A.acsn)}`);
  line(`B ${B.acsn.slice(0, 12)} role=${B.ccil.role(B.acsn)}`);

  rule('2. B ADVERTISEs an inference capability; A ingests via GOSSIP + peers');
  const ad = B.advertise({ model_classes: ['tinylm', 'slm'], gpu_tiers: ['edge'], latency_class: 5, trust_score: 0.9, price_curve: 2, sync_classes: ['async', 'block'], conf_classes: ['redact', 'attested'] });
  const ingest = A.gossipIn(ad);
  A.peerWith(B.acsn);
  A.ccil.attach(B.acsn, { stake: 800, uptime: 0.995, bvas: 0.92 });
  line(`A ingested B's advertisement: ${ingest.ok}; A now peers with ${A.rib.neighbours(A.acsn).length} ACS(s)`);
  line(`signature verifies: ${Fabric.ACS.verifyAdvertisement(ad)}`);

  rule('3. A registers a settlement rail (Rail Profile Registry §4.6)');
  const rail = A.sal.registerRail({ finality_bound: 5000, proof_format: 'merkle', escrow_primitive: 'htlc', dispute_hook: 'arb', denomination: 'compute-credit' });
  line(`rail registered: ${rail.rail_id} (settlement live: ${A.sal.settlementLive()})`);

  rule('4. A ROUTEs a job to B via DIRP-1 and runs it end-to-end');
  line('   ADVERTISE → ROUTE → execute → ATTEST → SETTLE  (async / redact)');
  const res = await A.runJob(
    { payload: 'summarize the incident report from analyst alice@corp.com at host 10.0.0.42', budget: 12 },
    { match: (c) => c.model_classes.includes('tinylm'), sync_class: 'async', conf_class: 'redact' }
  );
  line(`route: A → ${res.route.target.slice(0, 12)} (${res.route.hops} hop, cost ${res.route.cost}, trust ${res.route.trust.toFixed(2)})`);
  line(`rung-0 redaction applied at egress: ${/<email>|<ip>/.test(JSON.stringify(res.output))}`);
  line(`PoUI tier-1 spot-check performed: ${res.poui.spotChecked}`);
  line(`ATTEST receipt verifies (P80 accountability): ${Fabric.verifyAttest(res.attest)}`);
  line(`SETTLE valid on ${res.settle.rail_id}: ${res.settle.valid}`);

  rule('5. Memory fabric — blockchains federate memory across nodes (§2.1)');
  const fact = 'the mitochondria is the powerhouse of the cell';
  // B consolidates the fact onto ITS OWN LTM blockchain.
  ltmB.commit({ claim_text: fact, embedding: embed(fact, 64), confidence: 0.92, salience: 0.7, consensus_votes: [], proposer: 'B', validation: {} });
  line(`B LTM blockchain: height ${ltmB.size}, valid ${ltmB.validate().valid}`);
  // A issues a DIRP-1 QUERY. A's shard misses; B's blockchain shard answers.
  const aShard = A.answerQuery(fact);
  const bShard = B.answerQuery(fact);
  line(`A shard hit: ${aShard.hit} | B shard hit: ${bShard.hit} (similarity ${(bShard.similarity || 0).toFixed(3)})`);
  const fed = A.federatedQuery(fact, { peerAnswers: [bShard] });
  line(`federated recall → answer from ${fed.fromAcs === B.acsn ? 'B\'s blockchain' : fed.fromAcs}, claim matches: ${fed.claim === fact}`);
  // Global-chain checkpoint of the memory shard (LTM → checkpoints, §2.1).
  const cp = B.checkpointMemory();
  line(`B memory checkpoint: height ${cp.height}, head ${cp.head.slice(0, 12)}, verifies ${Fabric.MemoryFederation.verifyCheckpoint(cp)}`);
  // Autonomous breathing: self-reconcile role + re-advertise + checkpoint.
  const breath = B.breathe({ refreshCapability: { model_classes: ['tinylm'], trust_score: 0.9 } });
  line(`B breathes: re-advertised ${breath.reAdvertised}, memory valid ${breath.memoryValid}, checkpoint ${!!breath.checkpoint}`);

  rule('6. Privacy plane — onion routing over 3 relays (P65)');
  const priv = Fabric.privacy;
  const relays = [priv.newRelayIdentity(), priv.newRelayIdentity(), priv.newRelayIdentity()].map((r, i) => ({ acsn: `relay-${i}`, publicKeyRaw: r.publicKeyRaw, priv: r.privateKey }));
  const { onion, ephemerals } = priv.buildOnion('confidential prompt for user@x.com', relays);
  let cur = onion, delivered = null;
  for (let i = 0; i < relays.length; i++) { const p = priv.peelOnion(relays[i].priv, ephemerals[i], cur); if (p.delivered != null) { delivered = p.delivered; break; } cur = p.inner; }
  line(`onion delivered to exit: "${delivered}" (exit never sees raw identifiers)`);
  line(`<3 relays rejected: ${!priv.validate({ privacy_mode: 'onion', conf_class: 'redact', hops: 2 }).ok}`);

  rule('7. SAL — a hyperscale cloud joins as an Adapter ACS (P79 neutrality)');
  const cloud = new Fabric.SAL.AdapterACS({ acsn: 'adapter-cloud-1', providerClass: 'CSP', backend: 'any-cloud-region', stake: 5000, profile: { sync_classes: ['async', 'tight'], conf_classes: ['attested'], price_curve: 3, attest: true } });
  const reg = A.sal.registerAdapter(cloud);
  line(`cloud adapter conforms + registered as CSP: ${reg.ok} (fabric cannot tell it from a bedroom GPU — that IS the neutrality property)`);

  rule('8. CCIL economics — PoUI soundness + incentive compatibility');
  line(`P67 undetected fraud over 20 spot-checked jobs (q=${A.ccil.q}): ${A.ccil.undetectedFraudProbability(20).toExponential(2)}`);
  line(`P68 min stake so honesty dominates at cheat-gain 100: ${A.ccil.minStakeForIncentiveCompatibility(100).toFixed(1)}`);
  line(`B (stake 800) incentive-compatible vs gain 100: ${A.ccil.isIncentiveCompatible(B.acsn, 100)}`);

  const pass = res.ok && Fabric.verifyAttest(res.attest) && res.settle.valid && delivered.includes('<email>') && reg.ok;
  rule('RESULT');
  line(`Phase-1 artifact (cross-ACS job with verifiable receipt + settlement): ${pass ? 'SUCCESS' : 'FAILURE'}`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('[fabric-demo] error', e); process.exit(2); });
