'use strict';

/**
 * Agent tiers — a hierarchy of agent roles in the DARM-ANN network.
 *
 *   knowledgeable — broad-knowledge agents with full memory access; can teach,
 *                   consolidate, and answer across domains. Highest capability.
 *   generalist    — generally-specialized: competent across a domain family
 *                   (e.g. "security", "ops"); routes within its domain.
 *   narrow        — narrowly specialized; a single tight capability. Includes
 *                   the "dumb router" — it only classifies/forwards, no memory.
 *   worker        — worker node / operating plane (like a CI runner): executes
 *                   tasks/tools, holds no authoritative memory.
 *
 * `rank` orders capability (higher = more capable); the router prefers the
 * lowest-rank tier that can satisfy a request, escalating upward as needed.
 */
const TIERS = Object.freeze({
  worker: {
    name: 'worker',
    rank: 1,
    description: 'Worker node / operating plane — executes tasks and tools (runner-like).',
    canRoute: false,
    holdsMemory: false,
    defaultCapabilities: ['execute', 'run-tool'],
  },
  narrow: {
    name: 'narrow',
    rank: 2,
    description: 'Narrowly specialized — one tight capability (e.g. a dumb router that only classifies/forwards).',
    canRoute: true,
    holdsMemory: false,
    defaultCapabilities: ['route'],
  },
  generalist: {
    name: 'generalist',
    rank: 3,
    description: 'Generally specialized across a domain family; routes within its domain.',
    canRoute: true,
    holdsMemory: true,
    defaultCapabilities: ['route', 'reason', 'query'],
  },
  knowledgeable: {
    name: 'knowledgeable',
    rank: 4,
    description: 'Broad-knowledge agent with full memory access; teaches, consolidates, answers across domains.',
    canRoute: true,
    holdsMemory: true,
    defaultCapabilities: ['route', 'reason', 'query', 'teach', 'consolidate'],
  },
});

const TIER_NAMES = Object.keys(TIERS);

function isTier(name) {
  return Object.prototype.hasOwnProperty.call(TIERS, name);
}

function rankOf(name) {
  return TIERS[name] ? TIERS[name].rank : 0;
}

/** Order tiers from least to most capable. */
function ascending() {
  return TIER_NAMES.slice().sort((a, b) => rankOf(a) - rankOf(b));
}

module.exports = { TIERS, TIER_NAMES, isTier, rankOf, ascending };
