'use strict';

const { cosineSimilarity } = require('../util/embedding');

/**
 * Salience scoring — paper §4.2.
 *
 *   SalienceScore(c) = w_nov·novelty + w_rew·rlrf_weight
 *                    + w_freq·access_frequency + w_conf·confidence
 *
 * Salience is a proxy for *future utility*, not just present confidence. It
 * decides which claims justify the overhead of STM storage and eventual CDCP
 * consensus. Score ∈ [0, 1].
 */

/** novelty(c) = 1 − max cosine similarity to anything already in EB ∪ STM. */
function novelty(embedding, existingEmbeddings) {
  let maxSim = 0;
  for (const e of existingEmbeddings) {
    const sim = cosineSimilarity(embedding, e);
    if (sim > maxSim) maxSim = sim;
  }
  return 1 - maxSim;
}

/**
 * salienceScore — weighted composite. Inputs are already normalised to [0,1]:
 *   nov          novelty
 *   rlrfWeight   R_RLRF / max_R_RLRF
 *   accessFreq   recurrence signal (lookup frequency proxy)
 *   confidence   ESE calibrated confidence
 */
function salienceScore(
  { nov, rlrfWeight, accessFreq, confidence },
  weights
) {
  const s =
    weights.wNov * nov +
    weights.wRew * rlrfWeight +
    weights.wFreq * accessFreq +
    weights.wConf * confidence;
  return Math.min(1, Math.max(0, s));
}

module.exports = { novelty, salienceScore };
