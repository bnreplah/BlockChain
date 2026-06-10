'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Append-only audit log of operator actions (who did what, when, outcome).
 * Each entry is JSON-lines; optionally persisted to disk so the trail survives
 * restarts. Kept dependency-free and small; a ring buffer bounds memory.
 */
class AuditLog {
  constructor({ file = null, max = 1000 } = {}) {
    this.file = file;
    this.max = max;
    this.entries = [];
    if (file) {
      try { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); } catch (_e) {}
    }
  }

  record({ actor = 'anonymous', scope = null, action, method = null, path: reqPath = null, status = null, meta = null } = {}) {
    const entry = { ts: Date.now(), actor, scope, action, method, path: reqPath, status, meta };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();
    if (this.file) {
      try { fs.appendFileSync(this.file, JSON.stringify(entry) + '\n'); } catch (_e) {}
    }
    return entry;
  }

  list({ limit = 100, action = null, actor = null } = {}) {
    const out = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i];
      if (action && e.action !== action) continue;
      if (actor && e.actor !== actor) continue;
      out.push(e);
    }
    return out;
  }

  size() {
    return this.entries.length;
  }
}

module.exports = AuditLog;
