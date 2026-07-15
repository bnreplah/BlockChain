'use strict';

/**
 * Token-bucket rate limiter, keyed (e.g. by token or IP). Pure and testable;
 * no timers — refill is computed lazily from elapsed time on each check.
 *
 *   const rl = new RateLimiter({ capacity: 20, refillPerSec: 10 });
 *   rl.allow(key)  -> { ok, remaining, retryAfterMs }
 */
class RateLimiter {
  constructor({ capacity = 60, refillPerSec = 30, now = () => Date.now() } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.buckets = new Map(); // key -> { tokens, last }
  }

  _bucket(key) {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: this.now() };
      this.buckets.set(key, b);
    }
    return b;
  }

  _refill(b) {
    const t = this.now();
    const elapsed = (t - b.last) / 1000;
    if (elapsed > 0) {
      b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
      b.last = t;
    }
  }

  /** Try to consume one token. Returns { ok, remaining, retryAfterMs }. */
  allow(key, cost = 1) {
    const b = this._bucket(key);
    this._refill(b);
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
    }
    const deficit = cost - b.tokens;
    return { ok: false, remaining: Math.floor(b.tokens), retryAfterMs: Math.ceil((deficit / this.refillPerSec) * 1000) };
  }

  /** Drop idle buckets (housekeeping). */
  sweep(maxIdleMs = 5 * 60 * 1000) {
    const t = this.now();
    for (const [k, b] of this.buckets) if (t - b.last > maxIdleMs) this.buckets.delete(k);
  }
}

module.exports = RateLimiter;
