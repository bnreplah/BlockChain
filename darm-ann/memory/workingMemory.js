'use strict';

/**
 * Tier 0 — Working Memory (WM), paper §3.2.
 *
 * The agent's active scratch pad for a single inference pass: the prompt, the
 * chain-of-thought so far, and the snippets injected from STM / LTM / RRC. It
 * is never persisted directly — it is the *source* of all memory candidates.
 * Lifetime = one inference call, so we model it as a disposable object.
 */

class WorkingMemory {
  constructor({ agentId = 'agent-0', prompt = '' } = {}) {
    this.agentId = agentId;
    this.prompt = prompt;
    this.cot = []; // chain-of-thought reasoning steps
    this.stmCtx = []; // top-K STM retrievals injected into context
    this.ltmCtx = []; // top-J LTM retrievals injected into context
    this.rrcHits = []; // RRC hits for the current query
  }

  addThought(step) {
    this.cot.push(step);
    return this;
  }

  inject({ stm = [], ltm = [], rrc = [] } = {}) {
    this.stmCtx.push(...stm);
    this.ltmCtx.push(...ltm);
    this.rrcHits.push(...rrc);
    return this;
  }

  /** Snapshot used when forming an episodic trace. */
  snapshot() {
    return {
      agentId: this.agentId,
      prompt: this.prompt,
      cot: [...this.cot],
      contextSize: this.stmCtx.length + this.ltmCtx.length + this.rrcHits.length,
    };
  }
}

module.exports = WorkingMemory;
