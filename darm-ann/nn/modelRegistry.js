'use strict';

/**
 * ModelRegistry — holds the various SLMs / TinyLMs the system leverages, and
 * routes a task to an appropriate model. This is the "various SLM and TinyLMs
 * held within" container; the navigator and other components ask the registry
 * for the model that best fits the job.
 */
class ModelRegistry {
  constructor() {
    this.models = new Map(); // name -> { model, kind, tags }
  }

  register(name, model, { kind = 'tinyLM', tags = [] } = {}) {
    this.models.set(name, { model, kind, tags });
    return this;
  }

  get(name) {
    const e = this.models.get(name);
    return e ? e.model : null;
  }

  has(name) {
    return this.models.has(name);
  }

  list() {
    return [...this.models.entries()].map(([name, e]) => ({ name, kind: e.kind, tags: e.tags }));
  }

  /** Route a task to a model by kind/tag, falling back to the first match. */
  route({ kind = null, tag = null } = {}) {
    for (const [name, e] of this.models) {
      if (kind && e.kind !== kind) continue;
      if (tag && !e.tags.includes(tag)) continue;
      return { name, model: e.model, kind: e.kind };
    }
    const first = this.models.entries().next().value;
    return first ? { name: first[0], model: first[1].model, kind: first[1].kind } : null;
  }
}

module.exports = ModelRegistry;
