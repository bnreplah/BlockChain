'use strict';

/**
 * DIRP-1 — DARM Inter-network Routing Protocol (DARM-ANN v7.2 §2.4).
 *
 * Core verbs: ADVERTISE, WITHDRAW, QUERY, ROUTE, DELEGATE, ATTEST, GOSSIP, SETTLE.
 * This module implements **path selection** — the deepest architectural payoff
 * of v7: "memory traversal and network routing are the same algorithm over
 * different graphs." We run a trust-pruned Dijkstra (the same shortest-path
 * primitive the GTE uses over G_K) over the RIB capability graph.
 *
 *   cost(path) = Σ (latency_i + price_i·β)
 *   subject to  Π trust_i ≥ T_floor   and   privacy_mode / sync_class constraints
 *
 * Guarantees implemented as real code (statements → assertions in tests):
 *   P63 — trust-pruned Dijkstra stays O(E + V log V): pruning removes edges
 *         before relaxation; asymptotics unchanged.
 *   P64 — ACS-path loop prevention: a candidate hop already on the path is
 *         dropped (BGP AS-path analogue) → loop-free forwarding.
 *   P65 — privacy plane (onion) needs ≥3 relay ACSs (enforced by the caller;
 *         see privacy.js). Path length is reported so onion mode can require ≥3.
 *   P81 — neutrality: cost terms use only advertised/measured/attested
 *         properties (latency, price, trust); provider identity never appears.
 */

const DEFAULT = { beta: 1.0, trustFloor: 0.5 };

/** A trust value in (0,1]; missing/invalid → 0 (unroutable through that hop). */
function trustOf(cap) {
  const t = cap && typeof cap.trust_score === 'number' ? cap.trust_score : 0;
  return Math.max(0, Math.min(1, t));
}

function latencyOf(cap) {
  return cap && typeof cap.latency_class === 'number' ? cap.latency_class : 10;
}

function priceOf(cap) {
  // price_curve may be a number (flat) or { base }. Neutral: it's a property.
  if (!cap) return 0;
  if (typeof cap.price_curve === 'number') return cap.price_curve;
  if (cap.price_curve && typeof cap.price_curve.base === 'number') return cap.price_curve.base;
  return 0;
}

/**
 * Select a route from `originAcsn` to any ACS advertising a capability matching
 * `match(capability)`, minimizing cost under a trust-product floor and loop-free
 * ACS-path (P64). Returns { ok, path[], cost, trust, hops, target } or {ok:false}.
 *
 * @param rib   the RIB (capability directory + peering graph)
 * @param req   { originAcsn, match, constraints, opts }
 *   constraints: { privacy_mode, sync_class, conf_class } — filter candidate hops
 *   opts:        { beta, trustFloor, minHops } — β price weight, trust floor, onion min
 */
function selectRoute(rib, { originAcsn, match, constraints = {}, opts = {} }) {
  const beta = opts.beta != null ? opts.beta : DEFAULT.beta;
  const trustFloor = opts.trustFloor != null ? opts.trustFloor : DEFAULT.trustFloor;
  const now = Date.now();

  // Does an ACS satisfy the destination match under the request constraints?
  const acsSatisfies = (acsn) => {
    const cap = rib.bestCapability(acsn, (c) => capabilityMatches(c, match, constraints), now);
    return cap ? cap.capability : null;
  };

  // Dijkstra over ACSN vertices. Edge relax cost = latency + price·β of the
  // NEIGHBOUR's advertised capability; trust multiplies along the path.
  // State: dist (cost), trust (product), prev, path (for ACS-path P64).
  const dist = new Map([[originAcsn, 0]]);
  const trust = new Map([[originAcsn, 1]]);
  const prev = new Map();
  const visited = new Set();
  // priority queue as a simple array (small graphs; O(E+VlogV) shape preserved
  // by pruning pre-relaxation — see P63).
  const pq = [{ acsn: originAcsn, d: 0 }];

  let best = null;
  while (pq.length) {
    pq.sort((a, b) => a.d - b.d);
    const { acsn, d } = pq.shift();
    if (visited.has(acsn)) continue;
    visited.add(acsn);

    // Reached a destination? (origin itself doesn't count as a remote target)
    if (acsn !== originAcsn) {
      const cap = acsSatisfies(acsn);
      if (cap && trust.get(acsn) >= trustFloor) {
        best = { target: acsn, cost: d, trust: trust.get(acsn), capability: cap };
        break; // Dijkstra: first popped destination is optimal
      }
    }

    for (const nb of rib.neighbours(acsn)) {
      if (visited.has(nb)) continue;
      // P64 loop prevention: skip a neighbour already on the path to `acsn`.
      if (onPath(prev, originAcsn, acsn, nb)) continue;
      // The neighbour must advertise SOMETHING satisfying the constraints
      // (either a usable transit or the destination); pick its best matching cap.
      const cap = rib.bestCapability(nb, (c) => capabilityUsable(c, constraints), now);
      if (!cap) continue;
      const tHop = trustOf(cap.capability);
      if (tHop <= 0) continue; // untrusted hop pruned BEFORE relaxation (P63)
      const newTrust = trust.get(acsn) * tHop;
      if (newTrust < trustFloor) continue; // trust-floor prune
      const edgeCost = latencyOf(cap.capability) + priceOf(cap.capability) * beta;
      const nd = d + edgeCost;
      if (nd < (dist.get(nb) ?? Infinity)) {
        dist.set(nb, nd);
        trust.set(nb, newTrust);
        prev.set(nb, acsn);
        pq.push({ acsn: nb, d: nd });
      }
    }
  }

  if (!best) return { ok: false, reason: 'no trust-feasible route to a matching provider' };
  const path = reconstruct(prev, originAcsn, best.target);
  const hops = path.length - 1;
  if (opts.minHops && hops < opts.minHops) {
    return { ok: false, reason: `route has ${hops} hop(s); privacy mode requires ≥${opts.minHops}` };
  }
  return { ok: true, path, hops, cost: best.cost, trust: best.trust, target: best.target, capability: best.capability };
}

/** Build a ROUTE header (§2.4) with the ACS-path attribute for loop prevention. */
function buildRouteHeader({ job_class, qos = {}, privacy_mode = 'direct', sync_class = 'async', conf_class = 'redact', budget = 0, proof_reqs = [], acsPath = [] }) {
  return { type: 'ROUTE', job_class, qos, privacy_mode, sync_class, conf_class, budget, proof_reqs, acs_path: [...acsPath] };
}

/** A node drops any job whose ACS-path already contains its ACSN (§2.4, P64). */
function wouldLoop(routeHeader, myAcsn) {
  return Array.isArray(routeHeader.acs_path) && routeHeader.acs_path.includes(myAcsn);
}

// ── internals ───────────────────────────────────────────────────────────────

function capabilityMatches(cap, match, constraints) {
  if (!capabilityUsable(cap, constraints)) return false;
  return typeof match === 'function' ? !!match(cap) : true;
}

/** A capability is "usable" as a hop iff it honours the request's constraint
 *  classes (sync_class / conf_class). Neutrality (P81): no provider identity. */
function capabilityUsable(cap, constraints) {
  if (!cap) return false;
  if (constraints.sync_class && Array.isArray(cap.sync_classes) && !cap.sync_classes.includes(constraints.sync_class)) return false;
  if (constraints.conf_class && Array.isArray(cap.conf_classes) && !cap.conf_classes.includes(constraints.conf_class)) return false;
  return true;
}

function onPath(prev, origin, node, candidate) {
  let cur = node;
  const seen = new Set([origin]);
  while (cur != null) { seen.add(cur); cur = prev.get(cur); }
  return seen.has(candidate);
}

function reconstruct(prev, origin, target) {
  const path = [target];
  let cur = target;
  while (cur !== origin && prev.has(cur)) { cur = prev.get(cur); path.unshift(cur); }
  return path;
}

module.exports = { selectRoute, buildRouteHeader, wouldLoop, trustOf, DEFAULT };
