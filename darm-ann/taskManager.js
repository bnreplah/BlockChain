'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

/**
 * TaskManager — tracks long-running / async operations so an operator can
 * monitor progress. Each task has a lifecycle (queued → running → done|failed),
 * a 0..1 progress value, step log, and timing. Backed by an EventEmitter so a
 * monitor view can stream live updates (SSE).
 *
 * Used to wrap operations like replay, triage, self-correct, snapshot,
 * benchmark runs, and consolidation so they show up on the monitor.
 */
class TaskManager extends EventEmitter {
  constructor({ max = 200 } = {}) {
    super();
    this.max = max;
    this.tasks = new Map(); // id -> task
    this.order = []; // ids newest-last
  }

  _emit(task) {
    this.emit('update', task);
  }

  create(type, { label = '', total = 1, meta = {} } = {}) {
    const id = crypto.randomBytes(6).toString('hex');
    const task = {
      id, type, label: label || type,
      status: 'queued', progress: 0, total, completed: 0,
      steps: [], meta,
      createdAt: Date.now(), startedAt: null, endedAt: null,
      error: null, result: null,
    };
    this.tasks.set(id, task);
    this.order.push(id);
    while (this.order.length > this.max) this.tasks.delete(this.order.shift());
    this._emit(task);
    return task;
  }

  start(id) {
    const t = this.tasks.get(id);
    if (!t) return null;
    t.status = 'running';
    t.startedAt = Date.now();
    this._emit(t);
    return t;
  }

  step(id, message, completed = null) {
    const t = this.tasks.get(id);
    if (!t) return null;
    t.steps.push({ at: Date.now(), message });
    if (t.steps.length > 100) t.steps.shift();
    if (completed != null) {
      t.completed = completed;
      t.progress = t.total > 0 ? Math.min(1, completed / t.total) : 0;
    }
    this._emit(t);
    return t;
  }

  progress(id, value) {
    const t = this.tasks.get(id);
    if (!t) return null;
    t.progress = Math.min(1, Math.max(0, value));
    this._emit(t);
    return t;
  }

  finish(id, result = null) {
    const t = this.tasks.get(id);
    if (!t) return null;
    t.status = 'done';
    t.progress = 1;
    t.completed = t.total;
    t.endedAt = Date.now();
    t.result = result;
    this._emit(t);
    return t;
  }

  fail(id, error) {
    const t = this.tasks.get(id);
    if (!t) return null;
    t.status = 'failed';
    t.endedAt = Date.now();
    t.error = error && error.message ? error.message : String(error);
    this._emit(t);
    return t;
  }

  get(id) {
    return this.tasks.get(id) || null;
  }

  /** Run an async fn as a tracked task. fn receives a controller {step,progress}. */
  async run(type, opts, fn) {
    const task = this.create(type, opts);
    this.start(task.id);
    const ctl = {
      id: task.id,
      step: (m, c) => this.step(task.id, m, c),
      progress: (v) => this.progress(task.id, v),
    };
    try {
      const result = await fn(ctl);
      this.finish(task.id, result);
      return task;
    } catch (e) {
      this.fail(task.id, e);
      throw e;
    }
  }

  list({ status = null, limit = 50 } = {}) {
    const out = [];
    for (let i = this.order.length - 1; i >= 0 && out.length < limit; i--) {
      const t = this.tasks.get(this.order[i]);
      if (!t) continue;
      if (status && t.status !== status) continue;
      out.push(t);
    }
    return out;
  }

  summary() {
    const s = { queued: 0, running: 0, done: 0, failed: 0, total: 0 };
    for (const id of this.order) {
      const t = this.tasks.get(id);
      if (!t) continue;
      s[t.status] = (s[t.status] || 0) + 1;
      s.total += 1;
    }
    return s;
  }
}

module.exports = TaskManager;
