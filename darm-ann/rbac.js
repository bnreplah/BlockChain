'use strict';

/**
 * RBAC helper for the DARM-ANN API — token→scope parsing and authorization.
 * Kept dependency-free and pure so it is unit-testable independently of Express.
 *
 * Scopes (ordered): read < operator.
 *   read     → GET/HEAD endpoints
 *   operator → mutating endpoints (POST/DELETE/…)
 */
const SCOPE_RANK = { read: 1, operator: 2 };

/**
 * Build a token→scope map from config.
 *   authToken: a single legacy operator-scope token (DARM_AUTH_TOKEN)
 *   tokensSpec: "tokA:operator,tokB:read" (DARM_TOKENS)
 */
function buildTokenScopes({ authToken = '', tokensSpec = '' } = {}) {
  const map = new Map();
  if (authToken) map.set(authToken, 'operator');
  for (const pair of String(tokensSpec).split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = pair.lastIndexOf(':');
    const tok = idx >= 0 ? pair.slice(0, idx) : pair;
    const scope = idx >= 0 ? pair.slice(idx + 1) : 'operator';
    if (tok) map.set(tok, SCOPE_RANK[scope] ? scope : 'operator');
  }
  return map;
}

/** Minimum scope required for an HTTP method. */
function requiredScope(method) {
  return method === 'GET' || method === 'HEAD' ? 'read' : 'operator';
}

/**
 * Authorize a request. Returns { ok, status, scope?, error? }.
 *   tokenScopes: Map from buildTokenScopes
 *   method, token: from the request
 */
function authorize(tokenScopes, method, token) {
  if (tokenScopes.size === 0) return { ok: true, status: 200, scope: 'operator' }; // auth disabled
  const scope = tokenScopes.get(token);
  if (!scope) return { ok: false, status: 401, error: 'unauthorized' };
  const need = requiredScope(method);
  if (SCOPE_RANK[scope] < SCOPE_RANK[need]) return { ok: false, status: 403, error: 'forbidden', need, have: scope };
  return { ok: true, status: 200, scope };
}

module.exports = { SCOPE_RANK, buildTokenScopes, requiredScope, authorize };
