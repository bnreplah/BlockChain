'use strict';

const crypto = require('crypto');
const ACS = require('./acs');
const RIB = require('./rib');
const dirp = require('./dirp');
const privacy = require('./privacy');
const CCIL = require('./ccil');
const SAL = require('./sal');
const ValidatorKey = require('../consensus/validatorKey');

/**
 * Fabric — DARM-ANN v7.2 "Distributed AI Lens" facade.
 *
 * Turns a DARM-ANN node into an Autonomous Cognitive System (ACS) that:
 *   • advertises signed capabilities into its RIB (and gossips them),
 *   • routes jobs to matching providers via DIRP-1 (trust-pruned Dijkstra over
 *     the RIB graph — the GTE's shortest-path primitive, over a different graph),
 *   • honours the privacy plane (conf_class ladder + onion mode),
 *   • runs the CCIL role ladder + PoUI, and
 *   • settles over the SAL Rail Profile Registry.
 *
 * The full job lifecycle ADVERTISE→ROUTE→execute→ATTEST→SETTLE is the Phase-1
 * two-ACS peering artifact the v7.2 roadmap (§9.1) names as the next stage.
 */
class Fabric {
  constructor({ key = null, name = null, peering = {}, ccil = {}, executor = null } = {}) {
    this.acs = new ACS({ key: key || new ValidatorKey(), name, peering });
    this.rib = new RIB();
    this.ccil = new CCIL(ccil);
    this.sal = new SAL();
    this.ccil.attach(this.acs.acsn, { stake: ccil.stake || 0, uptime: ccil.uptime || 1, bvas: ccil.bvas || 0.9 });
    // executor(job, header) -> output. Default echoes (redaction applied upstream).
    this.executor = executor || ((job) => ({ ok: true, echo: job.payload, at: Date.now() }));
    this.attestations = []; // signed ATTEST receipts we issued
    this.settlements = []; // SETTLE records we validated
    // Self-advertisement into own RIB so single-node routing/tests work.
    this.rib.addPeering(this.acs.acsn, this.acs.acsn);
  }

  get acsn() { return this.acs.acsn; }

  static fromSeed(seed32, opts = {}) {
    return new Fabric({ ...opts, key: ValidatorKey.fromSeed(seed32) });
  }

  // ── ADVERTISE / WITHDRAW / GOSSIP ─────────────────────────────────────────

  advertise(capability, opts) {
    const ad = this.acs.advertise(capability, opts);
    this.rib.ingestAdvertise(ad); // into own RIB
    return ad;
  }

  withdraw(capabilityId) {
    const w = this.acs.withdraw(capabilityId);
    if (w) this.rib.ingestWithdraw(w);
    return w;
  }

  /** Ingest a peer's signed ADVERTISE (GOSSIP) + record peering. */
  gossipIn(record, { peerAcsn = null } = {}) {
    const res = record.type === 'WITHDRAW' ? this.rib.ingestWithdraw(record) : this.rib.ingestAdvertise(record);
    if (res.ok && record.acsn) {
      // We can reach the advertiser directly (peering edge) if policy allows.
      if (this.acs.peersWith(record.acsn)) this.rib.addPeering(this.acs.acsn, record.acsn);
      if (peerAcsn && peerAcsn !== record.acsn) this.rib.addPeering(peerAcsn, record.acsn);
    }
    return res;
  }

  /** Explicitly peer with another ACSN (bidirectional edges in the RIB graph). */
  peerWith(acsn) {
    this.rib.addPeering(this.acs.acsn, acsn);
    this.rib.addPeering(acsn, this.acs.acsn);
  }

  // ── ROUTE (DIRP-1 path selection §2.4) ────────────────────────────────────

  /**
   * Select a route for a job. `match(capability)` picks the destination class;
   * constraints carry privacy_mode / sync_class / conf_class.
   */
  route({ match, privacy_mode = 'direct', sync_class = 'async', conf_class = 'redact', beta = 1.0, trustFloor = 0.5 } = {}) {
    // Onion mode requires ≥3 relays (P65); ask DIRP for a min-hop path.
    const minHops = privacy_mode === 'onion' ? privacy.ONION_MIN_RELAYS : 0;
    const sel = dirp.selectRoute(this.rib, {
      originAcsn: this.acsn,
      match,
      constraints: { privacy_mode, sync_class, conf_class },
      opts: { beta, trustFloor, minHops },
    });
    if (!sel.ok) return sel;
    // Validate the privacy/conf combination for the chosen path.
    const pv = privacy.validate({ privacy_mode, conf_class, hops: sel.hops });
    if (!pv.ok) return { ok: false, reason: pv.reason };
    const header = dirp.buildRouteHeader({ job_class: 'inference', privacy_mode, sync_class, conf_class, acsPath: [this.acsn] });
    return { ...sel, header };
  }

  // ── Full lifecycle: ROUTE → execute → ATTEST → SETTLE ─────────────────────

  /**
   * Run a job end-to-end (Phase-1 artifact). Returns the receipt chain.
   *   job = { payload, budget }
   */
  async runJob(job, routeReq) {
    const sel = this.route(routeReq);
    if (!sel.ok) return { ok: false, stage: 'route', reason: sel.reason };

    // Loop-prevention check the executing node would perform (§2.4 / P64).
    if (dirp.wouldLoop(sel.header, sel.target)) return { ok: false, stage: 'route', reason: 'ACS-path loop' };

    // Rung-0 redaction is applied to any egressing payload; mandatory in onion.
    const safePayload = privacy.redact(typeof job.payload === 'string' ? job.payload : JSON.stringify(job.payload));
    const output = await this.executor({ ...job, payload: safePayload }, sel.header);

    // PoUI tier-1: spot-check with probability q (second executor = re-run here).
    let poui = { tier: 1, spotChecked: false };
    if (this.ccil.shouldSpotCheck()) {
      const output2 = await this.executor({ ...job, payload: safePayload }, sel.header);
      const check = CCIL.spotCheck(output, output2);
      poui = { tier: 1, spotChecked: true, agree: check.agree, needsArbitration: check.needsBvasArbitration };
    }

    const attest = this.attest({ jobId: hashJob(job), target: sel.target, output, poui });
    // Credit the executor and settle if a rail exists.
    let settle = null;
    if (job.budget && this.sal.settlementLive()) {
      const rail = this.sal.rails()[0];
      settle = this.settle({ rail_id: rail.rail_id, amount: job.budget, batchRoot: attest.receiptHash });
      this.ccil.credit(sel.target, job.budget);
    }
    return { ok: true, route: { path: sel.path, hops: sel.hops, cost: sel.cost, trust: sel.trust, target: sel.target }, output, poui, attest, settle };
  }

  // ── ATTEST (§2.4) ─────────────────────────────────────────────────────────

  attest({ jobId, target, output, poui }) {
    const body = { type: 'ATTEST', acsn: this.acsn, jobId, target, outputHash: sha(JSON.stringify(output)), poui, at: Date.now() };
    const signature = this.acs.key.sign(ACS.canonicalBytes(body));
    const receiptHash = sha(JSON.stringify(body) + signature);
    const rec = { ...body, publicKey: this.acs.publicKeyB64, signature, receiptHash };
    this.attestations.push(rec);
    return rec;
  }

  static verifyAttest(rec) {
    if (!rec || !rec.publicKey || !rec.signature) return false;
    const { publicKey, signature, receiptHash, ...body } = rec;
    return ValidatorKey.verify(ACS.canonicalBytes(body), signature, publicKey);
  }

  // ── SETTLE (§4.6) ─────────────────────────────────────────────────────────

  settle({ rail_id, amount, batchRoot }) {
    const record = { type: 'SETTLE', rail_id, amount, batch_root: batchRoot, proof: sha(rail_id + amount + batchRoot), at: Date.now() };
    const v = this.sal.validateSettle(record);
    record.valid = v.ok;
    this.settlements.push(record);
    return record;
  }

  // ── State / metrics ───────────────────────────────────────────────────────

  state() {
    return {
      acsn: this.acsn,
      name: this.acs.name,
      role: this.ccil.role(this.acsn),
      advertisements: this.acs.activeAdvertisements().length,
      rib: this.rib.stats(),
      ccil: this.ccil.stats(),
      sal: this.sal.stats(),
      attestations: this.attestations.length,
      settlements: this.settlements.length,
    };
  }
}

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 32); }
function hashJob(job) { return sha(JSON.stringify(job)); }

Fabric.ACS = ACS;
Fabric.RIB = RIB;
Fabric.dirp = dirp;
Fabric.privacy = privacy;
Fabric.CCIL = CCIL;
Fabric.SAL = SAL;
module.exports = Fabric;
