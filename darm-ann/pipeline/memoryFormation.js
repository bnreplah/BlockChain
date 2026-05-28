'use strict';

const { embed, cosineSimilarity } = require('../util/embedding');
const { novelty, salienceScore } = require('./salience');
const { claimId } = require('../util/hash');
const { STATE } = require('../memory/shortTermMemory');

/**
 * Memory Formation Pipeline — paper §4.
 *   Algorithm 10 — MemoryEncode (WM → EB)
 *   Algorithm 11 — STM_Persist  (EB → STM)
 */

/** ExtractClaims(CoT) — atomic factual assertions. Stand-in: explicit claims. */
function extractClaims(input) {
  if (Array.isArray(input.claims)) return input.claims.map((c) => ({ text: c }));
  if (input.claim) return [{ text: input.claim }];
  return [];
}

/**
 * Algorithm 10 — Memory Encoding (WM → EB).
 * `ctx` provides { eb, stm, cfg, accessFreq(embedding) }.
 */
function memoryEncode({ cot, output, reward, epistemic }, ctx) {
  const { eb, stm, cfg } = ctx;
  const maxReward = ctx.maxReward || 1;
  const existing = [...eb.embeddings(), ...stm.all().map((e) => e.embedding)];
  const candidates = extractClaims({ claims: cot && cot.claims, claim: output || (cot && cot.claim) });
  let encoded = 0;
  const created = [];

  for (const c of candidates) {
    const embedding = embed(c.text, cfg.embeddingDim);
    const nov = novelty(embedding, existing);
    const rlrfWeight = Math.min(1, Math.max(0, reward / maxReward));
    const accessFreq = ctx.accessFreq ? ctx.accessFreq(embedding) : 0;
    const epistemic_ok =
      epistemic.conf_cal >= cfg.ese.thetaConf && epistemic.u_ep <= cfg.ese.thetaU;
    const salience = salienceScore(
      { nov, rlrfWeight, accessFreq, confidence: epistemic.conf_cal },
      cfg.salience
    );

    if (epistemic_ok && salience >= cfg.salience.thetaSalience) {
      const { entry } = eb.push({
        claim: c.text,
        embed: embedding,
        salience,
        source: (cot && cot.trace_id) || null,
        reward,
        epistemic,
        timestamp: Date.now(),
      });
      existing.push(embedding); // keep novelty honest within the batch
      created.push(entry);
      encoded += 1;
    }
  }
  return { encoded, created };
}

/**
 * Algorithm 11 — STM Persistence (EB → STM).
 * `ctx` provides { stm, gte, cfg, nodeId }.
 * Returns one of: HELD_IN_EB | CONTRADICTED | MERGED | PROMOTED_TO_STM.
 */
function stmPersist(ebEntry, ctx) {
  const { stm, gte, cfg, nodeId } = ctx;

  // Gate 1 — confidence threshold
  if (ebEntry.epistemic.conf_cal < cfg.ese.thetaConf) {
    return { status: 'HELD_IN_EB' };
  }

  // Gate 2 — quick BFS consistency check (k = 1)
  const verdict = gte.bfsValidate(ebEntry.claim, ebEntry.embed, cfg.gte.bfsK1);
  if (verdict.conflict_score > cfg.gte.thetaConflict) {
    return { status: 'CONTRADICTED', verdict };
  }

  // Gate 3 — deduplication via cosine similarity
  const nn = stm.nearestNeighbor(ebEntry.embed);
  if (nn && nn.similarity > cfg.stm.thetaDedup) {
    stm.mergeReinforce(nn.entry, ebEntry);
    return { status: 'MERGED', entry: nn.entry };
  }

  // Promote to STM
  const created_at = Date.now();
  const entry = {
    claim_id: claimId(ebEntry.claim, created_at, nodeId),
    claim_text: ebEntry.claim,
    embedding: ebEntry.embed,
    confidence: ebEntry.epistemic.conf_cal,
    salience: ebEntry.salience,
    source_traces: ebEntry.source ? [ebEntry.source] : [],
    validation: { bfs_score: verdict.score, dfs_groundedness: null, bvas_score: null },
    epistemic_tuple: ebEntry.epistemic,
    consensus_votes: {},
    created_at,
    expires_at: created_at + cfg.stm.ttlMs,
    promoted: false,
    state: STATE.PENDING,
    replays: 0,
    retry_count: 0,
    decay_score: ebEntry.salience,
  };
  stm.insert(entry);
  return { status: 'PROMOTED_TO_STM', entry };
}

module.exports = { extractClaims, memoryEncode, stmPersist };
