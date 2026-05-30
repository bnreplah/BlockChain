'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Write-Ahead Log for BFT consensus.
 *
 * A validator appends every safety-critical action (round entry, prevote
 * choice, precommit/lock, decision) to an append-only log *before* acting on
 * it. After a crash/restart the node replays the WAL to recover its state — in
 * particular the value it locked on — so it cannot equivocate (e.g. prevote a
 * conflicting value in a later round). This is what makes consensus crash-safe.
 *
 * Backed by a file (durable) or an in-memory array (tests). File writes are
 * flushed with fsync so an entry survives an immediate crash.
 */
class WAL {
  constructor(file = null) {
    this.file = file;
    this.entries = [];
    if (file) {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (line.trim()) {
            try {
              this.entries.push(JSON.parse(line));
            } catch (_e) {
              /* skip a torn trailing line */
            }
          }
        }
      }
    }
  }

  append(entry) {
    const e = { ...entry, ts: Date.now() };
    this.entries.push(e);
    if (this.file) {
      const fd = fs.openSync(this.file, 'a');
      try {
        fs.writeSync(fd, JSON.stringify(e) + '\n');
        fs.fsyncSync(fd); // durable before we act on it
      } finally {
        fs.closeSync(fd);
      }
    }
    return e;
  }

  replay() {
    return this.entries.slice();
  }

  /** Start a fresh height: record a marker (kept for audit/replay ordering). */
  newHeight(height) {
    this.append({ t: 'HEIGHT', height });
  }

  /** Compact the log, dropping everything before the given height marker. */
  compact(height) {
    const kept = [];
    let keep = false;
    for (const e of this.entries) {
      if (e.t === 'HEIGHT' && e.height >= height) keep = true;
      if (keep) kept.push(e);
    }
    this.entries = kept;
    if (this.file) fs.writeFileSync(this.file, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
  }
}

module.exports = WAL;
