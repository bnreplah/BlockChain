'use strict';

const { HOUR_MS } = require('../config');

/**
 * Decay scoring — paper §8.1, Proof P48.
 *
 *   DecayScore(e,t) = salience(e) × RecencyFactor(e,t) × ReinforcementFactor(e)
 *
 *   RecencyFactor    = exp(−λ_decay × Δt_hours)              (Ebbinghaus R(t)=e^{−t/S})
 *   ReinforcementFactor = 1 + log10(1 + replays)             (spacing effect, sublinear)
 *
 * High-salience entries (salience ≥ highSalience) decay slower (λ_high), giving
 * a ≈69h half-life vs ≈6.9h for ordinary entries (P48).
 */

function recencyFactor(ageMs, lambdaPerHour) {
  const ageHours = ageMs / HOUR_MS;
  return Math.exp(-lambdaPerHour * ageHours);
}

function reinforcementFactor(replays) {
  return 1 + Math.log10(1 + (replays || 0));
}

function decayScore(entry, now, cfg) {
  const lambda =
    entry.salience >= cfg.salience.highSalience
      ? cfg.decay.lambdaHighPerHour
      : cfg.decay.lambdaPerHour;
  const ageMs = now - entry.created_at;
  return (
    entry.salience * recencyFactor(ageMs, lambda) * reinforcementFactor(entry.replays)
  );
}

module.exports = { decayScore, recencyFactor, reinforcementFactor };
