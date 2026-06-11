'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Build / version info, surfaced at /darm/version and as a Prometheus
 * build-info gauge. Reads the package version and best-effort git metadata
 * (overridable via env for reproducible container builds).
 */
let cached = null;

function gitInfo() {
  const env = {
    commit: process.env.DARM_GIT_COMMIT || process.env.GIT_COMMIT || '',
    branch: process.env.DARM_GIT_BRANCH || '',
    builtAt: process.env.DARM_BUILD_TIME || '',
  };
  if (env.commit) return env;
  try {
    const opts = { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] };
    env.commit = execSync('git rev-parse --short HEAD', opts).toString().trim();
    env.branch = execSync('git rev-parse --abbrev-ref HEAD', opts).toString().trim();
  } catch (_e) {
    /* not a git checkout (e.g. inside a container) — env/unknown */
  }
  return env;
}

function info() {
  if (cached) return cached;
  let version = '0.0.0';
  try {
    version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || version;
  } catch (_e) {}
  const g = gitInfo();
  cached = {
    name: 'darm-ann',
    version,
    paperVersion: '6.0',
    commit: g.commit || 'unknown',
    branch: g.branch || 'unknown',
    builtAt: g.builtAt || null,
    node: process.version,
    pid: process.pid,
  };
  return cached;
}

module.exports = { info };
