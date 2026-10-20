'use strict';

const crypto = require('crypto');
const ValidatorKey = require('../consensus/validatorKey');
const ACS = require('./acs');

/**
 * Compute pooling for the fabric: CPUs as well as GPUs (and NPUs, and phones
 * with their owner's consent) behind one capability model — v7.2 §4.4 CSP
 * capability prefixes made device-aware, with the DARM-ANN papers' admission
 * rules applied to results.
 *
 *   capability.compute = {
 *     form_factor: 'server'|'desktop'|'laptop'|'phone'|'tablet'|'edge',
 *     devices: [{ kind: 'cpu'|'gpu'|'npu', backend, gflops, memory_mb, share_pct }],
 *     conditions: { on_battery, charging, battery_pct, metered, thermal, load },
 *   }
 *
 * - Results are admitted at ⌈τ_c·n⌉ of a shard's n replicas (CDCP threshold,
 *   Paper 1); short of quorum a shard abstains instead of guessing (ESE's
 *   third outcome, Paper 2 §5). Agreement is consensus-validated system
 *   belief, not ground truth (Volume 1 §45).
 * - Replicas prefer different backends to lower failure correlation ρ
 *   (Paper 2; Volume 1.1 §3), and spot-check replicas implement P66/P67.
 * - `admissionProbability` is Proof P39 as corrected in Volume 1 §41
 *   (Gaussian-copula integral). Its outputs are MODELED: ρ is an assumption.
 *
 * Mirrors darm-compute in DARM-ANMN-LLM so both implementations plan and
 * verify the same way. Nothing here executes code.
 */

const KINDS = new Set(['cpu', 'gpu', 'npu']);
const BACKENDS = new Set(['cpu', 'cuda', 'rocm', 'metal', 'vulkan', 'other']);
const FORM_FACTORS = new Set(['server', 'desktop', 'laptop', 'phone', 'tablet', 'edge']);
const THERMAL = ['nominal', 'fair', 'serious', 'critical'];
const MAX_DEVICES = 16;
const MAX_GFLOPS = 2_000_000;
const MAX_SHARDS = 4096;
const MAX_REDUNDANCY = 7;
const SAME_BACKEND_PENALTY = 0.25;

const isMobile = (ff) => ff === 'phone' || ff === 'tablet';

// ── thresholds ───────────────────────────────────────────────────────────────

const Threshold = Object.freeze({
  TWO_THIRDS: Object.freeze({ num: 2, den: 3 }),
  HIGH_RISK: Object.freeze({ num: 4, den: 5 }),
  STRICT: Object.freeze({ num: 9, den: 10 }),
});

/** τ_c must satisfy 1/2 < τ_c ≤ 1 so at most one output can reach quorum. */
function validateThreshold(t) {
  const ok = t && Number.isInteger(t.num) && Number.isInteger(t.den) && t.den > 0 && t.num <= t.den && 2 * t.num > t.den;
  if (!ok) throw new Error('threshold must satisfy 1/2 < num/den <= 1');
  return t;
}

/** ⌈τ_c·n⌉, exactly (2/3 of 21 is 14). */
function quorum(t, n) {
  return Math.floor((t.num * n + t.den - 1) / t.den);
}

// ── P39 admission model ─────────────────────────────────────────────────────

function erfc(y) {
  if (y < 2) {
    let term = y;
    let sum = y;
    for (let n = 1; n < 200; n++) {
      term *= (-y * y) / n;
      const add = term / (2 * n + 1);
      sum += add;
      if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
    }
    return 1 - (sum * 2) / Math.sqrt(Math.PI);
  }
  // Modified Lentz continued fraction for y >= 2.
  const tiny = 1e-300;
  let f = y;
  let c = y;
  let d = 0;
  for (let k = 1; k < 500; k++) {
    const a = k / 2;
    d = y + a * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = y + a / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-y * y) / (f * Math.sqrt(Math.PI));
}

/** Upper normal tail, accurate far into the tail. */
function normalSf(x) {
  return x < 0 ? 1 - normalSf(-x) : 0.5 * erfc(x / Math.SQRT2);
}

/** Inverse normal CDF (Acklam + two Halley refinements). */
function normalInvCdf(p) {
  if (!(p > 0 && p < 1)) throw new Error('p must be in (0,1)');
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  let x;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - low) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  for (let i = 0; i < 2; i++) {
    const e = 1 - normalSf(x) - p;
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
    x -= u / (1 + (x * u) / 2);
  }
  return x;
}

/** P(X >= k), X ~ Binomial(n, p), summed in log space. */
function binomialTail(k, n, p) {
  if (k <= 0) return 1;
  if (k > n || p <= 0) return 0;
  if (p >= 1) return 1;
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  let sum = 0;
  for (let j = k; j <= n; j++) {
    let lc = 0;
    for (let i = 1; i <= j; i++) lc += Math.log((n - j + i) / i);
    sum += Math.exp(lc + j * lp + (n - j) * lq);
  }
  return Math.min(1, sum);
}

/** Modeled probability that a bad claim reaches quorum (P39, corrected). */
function admissionProbability(n, pNode, rho, threshold = Threshold.TWO_THIRDS) {
  const q = quorum(threshold, n);
  if (!(pNode > 0 && pNode < 1)) return pNode >= 1 ? 1 : 0;
  const r = Math.max(0, Math.min(0.999, rho));
  if (r === 0) return binomialTail(q, n, pNode);
  const zThr = normalInvCdf(1 - pNode);
  const sr = Math.sqrt(r);
  const s1r = Math.sqrt(1 - r);
  const f = (z) => binomialTail(q, n, normalSf((zThr - sr * z) / s1r)) * Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI);
  const steps = 4000;
  const lo = -8;
  const h = 16 / steps;
  let sum = f(lo) + f(8);
  for (let i = 1; i < steps; i++) sum += (i % 2 ? 4 : 2) * f(lo + h * i);
  return Math.min(1, (sum * h) / 3);
}

/** P67: chance k fraudulent single-replica shards all escape spot checks. */
function undetectedFraudBound(q, k) {
  return Math.pow(1 - Math.max(0, Math.min(1, q)), k);
}

function modeledAdmission(replicas, threshold, pNode = 0.01) {
  return {
    label: 'modeled (engineering estimate, P39 copula model); rho is assumed, not measured',
    replicas,
    quorum: quorum(threshold, replicas),
    threshold: threshold.num / threshold.den,
    p_node: pNode,
    by_correlation: [0, 0.3, 0.5].map((rho) => [rho, admissionProbability(replicas, pNode, rho, threshold)]),
  };
}

// ── capabilities, policy, consent ───────────────────────────────────────────

/** Throws on a malformed `capability.compute`; returns it otherwise. */
function validateCompute(compute) {
  if (!compute || typeof compute !== 'object') throw new Error('compute must be an object');
  if (!FORM_FACTORS.has(compute.form_factor)) throw new Error('unknown form_factor');
  if (!Array.isArray(compute.devices) || compute.devices.length > MAX_DEVICES) throw new Error('devices must be an array of <= 16');
  for (const d of compute.devices) {
    if (!KINDS.has(d.kind) || !BACKENDS.has(d.backend)) throw new Error('unknown device kind/backend');
    if ((d.kind === 'cpu') !== (d.backend === 'cpu') && d.kind !== 'npu') throw new Error('backend does not match kind');
    for (const f of ['gflops', 'memory_mb', 'share_pct']) {
      if (!Number.isInteger(d[f]) || d[f] < 0) throw new Error(`device.${f} must be a non-negative integer`);
    }
    if (d.gflops < 1 || d.gflops > MAX_GFLOPS) throw new Error('implausible gflops');
    if (d.share_pct < 1 || d.share_pct > 100) throw new Error('share_pct must be 1..100');
  }
  const c = compute.conditions || {};
  if (c.battery_pct != null && !(c.battery_pct >= 0 && c.battery_pct <= 100)) throw new Error('battery_pct must be 0..100');
  if (c.load != null && !(c.load >= 0 && c.load <= 1)) throw new Error('load must be 0..1');
  if (c.thermal != null && !THERMAL.includes(c.thermal)) throw new Error('unknown thermal state');
  return compute;
}

/** Owner contribution defaults; conservative for anything on a battery. */
function contributionPolicy(formFactor) {
  if (isMobile(formFactor)) {
    return { contribute: true, allowCpu: true, allowGpu: true, maxSharePct: 50, requireCharging: true, minBatteryPct: 50, allowMetered: false, maxThermal: 'fair' };
  }
  if (formFactor === 'laptop') {
    return { contribute: true, allowCpu: true, allowGpu: true, maxSharePct: 75, requireCharging: true, minBatteryPct: 30, allowMetered: false, maxThermal: 'fair' };
  }
  return { contribute: true, allowCpu: true, allowGpu: true, maxSharePct: 100, requireCharging: false, minBatteryPct: 0, allowMetered: true, maxThermal: 'serious' };
}

/** Why a device should not contribute right now, or null. */
function blockedBy(policy, conditions = {}) {
  if (!policy.contribute) return 'contribution disabled by owner';
  if (THERMAL.indexOf(conditions.thermal || 'nominal') > THERMAL.indexOf(policy.maxThermal)) return 'device too hot';
  if (conditions.metered && !policy.allowMetered) return 'metered network';
  if (conditions.on_battery) {
    if (policy.requireCharging && !conditions.charging) return 'on battery and not charging';
    if ((conditions.battery_pct ?? 100) < policy.minBatteryPct) return 'battery below owner minimum';
  }
  return null;
}

/** The `compute` block a node should advertise now (empty devices = consent withheld). */
function offer({ formFactor, devices, conditions = {}, policy = contributionPolicy(formFactor) }) {
  const blocked = blockedBy(policy, conditions);
  let share = Math.max(1, Math.min(100, policy.maxSharePct));
  share = Math.floor((share * (1000 - Math.min(900, Math.round((conditions.load || 0) * 1000)))) / 1000);
  if (conditions.thermal === 'fair') share = Math.floor((share * 3) / 4);
  share = Math.max(1, share);
  const allowed = (d) => (d.kind === 'cpu' ? policy.allowCpu : policy.allowGpu);
  return validateCompute({
    form_factor: formFactor,
    devices: blocked ? [] : devices.filter(allowed).map((d) => ({ ...d, share_pct: share })),
    conditions,
  });
}

/** DIRP `match` predicate: route to a provider with the right kind of compute. */
function computeMatch({ device = 'any', minMemoryMb = 0, allowMobile = false } = {}) {
  return (cap) => {
    const compute = cap && cap.compute;
    if (!compute) return false;
    try {
      validateCompute(compute);
    } catch (_e) {
      return false;
    }
    if (isMobile(compute.form_factor) && !allowMobile) return false;
    return compute.devices.some((d) => (device === 'any' || (device === 'cpu' ? d.kind === 'cpu' : d.kind !== 'cpu')) && d.memory_mb >= minMemoryMb);
  };
}

/** Providers in a RIB with a valid compute capability: [{acsn, compute, trust}]. */
function providersFromRib(rib, now = Date.now()) {
  const out = [];
  for (const { acsn, record } of rib.advertisersOf(computeMatch({ allowMobile: true }), now)) {
    const t = record.capability.trust_score;
    out.push({ acsn, compute: record.capability.compute, trust: typeof t === 'number' ? Math.max(0, Math.min(1, t)) : 0 });
  }
  return out;
}

// ── planning ─────────────────────────────────────────────────────────────────

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function inputRoot(inputs) {
  return sha(inputs.join('|'));
}

function validateSpec(spec) {
  if (!Array.isArray(spec.inputs) || spec.inputs.length === 0 || spec.inputs.length > MAX_SHARDS) throw new Error('inputs must hold 1..4096 hashes');
  if (!(Number.isInteger(spec.redundancy) && spec.redundancy >= 1 && spec.redundancy <= MAX_REDUNDANCY)) throw new Error('redundancy must be 1..7');
  if (!(spec.spotCheck >= 0 && spec.spotCheck <= 1)) throw new Error('spotCheck must be 0..1');
  validateThreshold(spec.threshold);
}

function spotChecked(spec, shard) {
  if (!spec.spotCheck) return false;
  const roll = parseInt(sha(`compute-spot-check|${inputRoot(spec.inputs)}|${spec.nonce}|${shard}`).slice(0, 4), 16) % 1000;
  return roll < Math.round(spec.spotCheck * 1000);
}

function jobIdOf(coordinator, spec) {
  return sha(JSON.stringify(['compute-job', coordinator, spec.device, inputRoot(spec.inputs), spec.inputs.length, spec.redundancy, spec.threshold.num, spec.threshold.den, Math.round(spec.spotCheck * 1000), spec.diverseReplicas, spec.allowMobile, spec.nonce]));
}

/**
 * Plan shards across providers by smooth weighted round robin over
 * gflops × share × trust × availability × mobile factor, CPU and GPU slots
 * together (or filtered by `device`), replicas on distinct providers that
 * prefer different backends.
 */
function planShards({ coordinator, providers, spec: input }) {
  const spec = {
    device: 'any',
    redundancy: 3,
    threshold: Threshold.TWO_THIRDS,
    spotCheck: 0,
    diverseReplicas: true,
    allowMobile: false,
    nonce: crypto.randomBytes(8).toString('hex'),
    ...input,
  };
  validateSpec(spec);
  const slots = [];
  for (const p of providers) {
    const compute = p.compute;
    if (!compute || (isMobile(compute.form_factor) && !spec.allowMobile) || !(p.trust > 0)) continue;
    const c = compute.conditions || {};
    const thermal = { nominal: 1, fair: 0.8, serious: 0.4, critical: 0 }[c.thermal || 'nominal'];
    const availability = Math.max(0.05, 1 - (c.load || 0)) * thermal;
    let mobile = isMobile(compute.form_factor) ? 0.5 : 1;
    if (c.on_battery && !c.charging) mobile *= 0.5;
    for (const d of compute.devices) {
      const accel = d.kind !== 'cpu';
      if ((spec.device === 'cpu' && accel) || (spec.device === 'gpu' && !accel)) continue;
      const weight = d.gflops * (d.share_pct / 100) * p.trust * availability * mobile;
      if (weight > 0) slots.push({ acsn: p.acsn, kind: d.kind, backend: d.backend, weight, current: 0 });
    }
  }
  const distinct = new Set(slots.map((s) => s.acsn));
  if (distinct.size < spec.redundancy) throw new Error(`need ${spec.redundancy} distinct eligible providers, have ${distinct.size}`);
  const spotPossible = distinct.size > spec.redundancy;
  const assignments = [];
  for (let shard = 0; shard < spec.inputs.length; shard++) {
    const used = [];
    const backends = [];
    const replicas = spec.redundancy + (spotPossible && spotChecked(spec, shard) ? 1 : 0);
    for (let replica = 0; replica < replicas; replica++) {
      const eligible = slots.filter((s) => !used.includes(s.acsn));
      const adj = (s) => (spec.diverseReplicas && backends.includes(s.backend) ? s.weight * SAME_BACKEND_PENALTY : s.weight);
      const total = eligible.reduce((acc, s) => acc + adj(s), 0);
      for (const s of eligible) s.current += adj(s);
      let best = eligible[0];
      for (const s of eligible) if (s.current > best.current) best = s;
      best.current -= total;
      used.push(best.acsn);
      backends.push(best.backend);
      assignments.push({ shard, replica, worker: best.acsn, device: best.kind, backend: best.backend });
    }
  }
  const replicasOf = (shard) => assignments.filter((a) => a.shard === shard).length;
  const spotCheckedShards = spec.inputs.filter((_, s) => replicasOf(s) > spec.redundancy).length;
  return {
    job: jobIdOf(coordinator, spec),
    coordinator,
    spec,
    assignments,
    cpuShards: assignments.filter((a) => a.device === 'cpu').length,
    gpuShards: assignments.filter((a) => a.device === 'gpu').length,
    npuShards: assignments.filter((a) => a.device === 'npu').length,
    spotCheckedShards,
    guarantees: {
      note: 'agreement is consensus-validated system belief, not ground truth',
      per_shard: modeledAdmission(spec.redundancy, spec.threshold),
    },
  };
}

// ── receipts and tallies ────────────────────────────────────────────────────

function receiptBytes(r) {
  return Buffer.from(JSON.stringify(['compute-receipt', r.job, r.shard, r.worker, r.input, r.output, r.device, r.backend, r.units, r.elapsedMs, r.completedAt]));
}

/** A worker's signed ATTEST-class receipt; `worker` is its ACSN. */
function signReceipt(key, receipt) {
  const r = { ...receipt, worker: key.address };
  return { receipt: r, publicKey: key.publicKeyB64, signature: key.sign(receiptBytes(r)) };
}

function verifyReceipt(signed) {
  if (!signed || !signed.receipt || typeof signed.publicKey !== 'string') return false;
  if (signed.receipt.worker !== ACS.acsnOf(signed.publicKey)) return false;
  return ValidatorKey.verify(receiptBytes(signed.receipt), signed.signature, signed.publicKey);
}

/**
 * Admit each shard's output at ⌈τ_c·n⌉ of its n assigned replicas. Receipts
 * from unassigned workers, over other inputs, for other jobs, or with bad
 * signatures are rejected; one per (shard, worker) counts.
 */
function tallyReceipts(plan, receipts) {
  const n = plan.spec.inputs.length;
  const accepted = new Map();
  let rejected = 0;
  for (const s of receipts) {
    const r = s && s.receipt;
    const ok = r && r.job === plan.job && Number.isInteger(r.shard) && r.shard >= 0 && r.shard < n && plan.spec.inputs[r.shard] === r.input && plan.assignments.some((a) => a.shard === r.shard && a.worker === r.worker) && verifyReceipt(s);
    if (!ok) {
      rejected += 1;
      continue;
    }
    const key = `${r.shard}|${r.worker}`;
    if (!accepted.has(key)) accepted.set(key, s);
  }
  const shards = [];
  const dissenters = [];
  const outputs = [];
  for (let shard = 0; shard < n; shard++) {
    const votes = new Map();
    for (const s of accepted.values()) {
      if (s.receipt.shard !== shard) continue;
      if (!votes.has(s.receipt.output)) votes.set(s.receipt.output, []);
      votes.get(s.receipt.output).push(s.receipt.worker);
    }
    const need = Math.max(1, quorum(plan.spec.threshold, plan.assignments.filter((a) => a.shard === shard).length));
    const winner = [...votes.entries()].find(([, w]) => w.length >= need);
    if (winner) {
      outputs.push(winner[0]);
      for (const [out, workers] of votes) if (out !== winner[0]) for (const w of workers) dissenters.push({ worker: w, shard });
      shards.push({ status: 'agreed', output: winner[0], votes: winner[1].length });
    } else if (votes.size > 1) {
      shards.push({ status: 'disputed', outputs: [...votes.entries()].map(([o, w]) => [o, w.length]) });
    } else {
      shards.push({ status: 'missing', received: [...votes.values()].reduce((a, w) => a + w.length, 0) });
    }
  }
  const complete = outputs.length === n;
  return { job: plan.job, shards, dissenters, rejected, complete, resultRoot: complete ? sha(outputs.join('|')) : null };
}

module.exports = {
  Threshold,
  validateThreshold,
  quorum,
  normalSf,
  normalInvCdf,
  binomialTail,
  admissionProbability,
  undetectedFraudBound,
  modeledAdmission,
  validateCompute,
  contributionPolicy,
  blockedBy,
  offer,
  computeMatch,
  providersFromRib,
  planShards,
  signReceipt,
  verifyReceipt,
  tallyReceipts,
};
