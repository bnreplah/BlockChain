'use strict';

const crypto = require('crypto');
const { isTier, rankOf, ascending } = require('./tiers');

/**
 * AgentRegistry — a singly-linked list of agent registrations (mirroring the
 * repo's linked-list Chain motif in structures/Chain.js) that the model uses
 * for **agentic registration and tool-capability discovery**.
 *
 * Each link is an agent record:
 *   { id, name, tier, capabilities[], endpoint, vpnIp, publicKey, status,
 *     registeredAt, lastSeen, meta }
 *
 * The list is the source of truth for "who is online and what can they do".
 * The router (router.js) walks it to dispatch a capability request to the
 * lowest-capable tier that can satisfy it, escalating upward as needed.
 */

class AgentLink {
  constructor(record) {
    this.record = record;
    this.next = null;
  }
}

class AgentRegistry {
  constructor({ heartbeatTimeoutMs = 60000 } = {}) {
    this.head = null; // first AgentLink
    this.tail = null;
    this.byId = new Map();
    this.size = 0;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.seq = 0;
  }

  static agentId(name, publicKey) {
    return 'agent:' + crypto.createHash('sha256').update(`${name}|${publicKey || ''}|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 24);
  }

  /**
   * Register (or re-register) an agent. Appends a new link to the list, or
   * updates the existing record if the id is already present.
   * @returns the agent record.
   */
  register({ id, name, tier, capabilities = [], endpoint = null, vpnIp = null, publicKey = null, meta = {} }) {
    if (!isTier(tier)) throw new Error(`unknown tier: ${tier}`);
    const now = Date.now();
    const agentId = id || AgentRegistry.agentId(name, publicKey);
    const existing = this.byId.get(agentId);
    if (existing) {
      Object.assign(existing.record, { name, tier, capabilities, endpoint, vpnIp, publicKey, meta, lastSeen: now, status: 'online' });
      return existing.record;
    }
    const record = {
      id: agentId,
      name: name || agentId,
      tier,
      rank: rankOf(tier),
      capabilities: [...new Set(capabilities)],
      endpoint,
      vpnIp,
      publicKey,
      status: 'online',
      registeredAt: now,
      lastSeen: now,
      order: this.seq++,
      meta,
    };
    const link = new AgentLink(record);
    if (!this.head) this.head = this.tail = link;
    else { this.tail.next = link; this.tail = link; }
    this.byId.set(agentId, link);
    this.size += 1;
    return record;
  }

  /** Heartbeat — refresh lastSeen so the agent stays "online". */
  heartbeat(id) {
    const link = this.byId.get(id);
    if (!link) return null;
    link.record.lastSeen = Date.now();
    link.record.status = 'online';
    return link.record;
  }

  /** Deregister — unlink an agent (graceful shutdown). */
  deregister(id) {
    if (!this.byId.has(id)) return false;
    let prev = null;
    let cur = this.head;
    while (cur) {
      if (cur.record.id === id) {
        if (prev) prev.next = cur.next; else this.head = cur.next;
        if (cur === this.tail) this.tail = prev;
        break;
      }
      prev = cur;
      cur = cur.next;
    }
    this.byId.delete(id);
    this.size -= 1;
    return true;
  }

  get(id) {
    const link = this.byId.get(id);
    return link ? link.record : null;
  }

  /** Mark agents whose heartbeat lapsed as offline (does not unlink them). */
  reapStale(now = Date.now()) {
    let reaped = 0;
    for (const link of this._links()) {
      const r = link.record;
      if (r.status === 'online' && now - r.lastSeen > this.heartbeatTimeoutMs) {
        r.status = 'offline';
        reaped += 1;
      }
    }
    return reaped;
  }

  *_links() {
    let cur = this.head;
    while (cur) { yield cur; cur = cur.next; }
  }

  /** All records in list (registration) order. */
  list({ tier = null, capability = null, onlineOnly = false } = {}) {
    const out = [];
    for (const link of this._links()) {
      const r = link.record;
      if (tier && r.tier !== tier) continue;
      if (capability && !r.capabilities.includes(capability)) continue;
      if (onlineOnly && r.status !== 'online') continue;
      out.push(r);
    }
    return out;
  }

  /** Online agents that advertise a capability, grouped by tier rank ascending. */
  findByCapability(capability, { onlineOnly = true } = {}) {
    return this.list({ capability, onlineOnly }).sort((a, b) => a.rank - b.rank || a.order - b.order);
  }

  /** The set of capabilities currently available across online agents. */
  capabilities() {
    const caps = new Set();
    for (const r of this.list({ onlineOnly: true })) for (const c of r.capabilities) caps.add(c);
    return [...caps].sort();
  }

  stats() {
    const byTier = {};
    let online = 0;
    for (const r of this.list()) {
      byTier[r.tier] = (byTier[r.tier] || 0) + 1;
      if (r.status === 'online') online += 1;
    }
    return { total: this.size, online, byTier, tierOrder: ascending() };
  }

  /** Serialise the linked list (for persistence / state-sync). */
  toJSON() {
    return { agents: this.list(), seq: this.seq };
  }

  load(data) {
    this.head = this.tail = null;
    this.byId = new Map();
    this.size = 0;
    this.seq = 0;
    for (const r of (data && data.agents) || []) {
      // preserve ids/timestamps on reload
      const link = new AgentLink({ ...r, rank: rankOf(r.tier) });
      if (!this.head) this.head = this.tail = link; else { this.tail.next = link; this.tail = link; }
      this.byId.set(r.id, link);
      this.size += 1;
    }
    this.seq = (data && data.seq) || this.size;
    return this;
  }
}

AgentRegistry.AgentLink = AgentLink;
module.exports = AgentRegistry;
