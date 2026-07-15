#!/usr/bin/env node
'use strict';

/**
 * Backup / restore tooling for DARM-ANN node state (the LTM-snapshot + audit
 * files that live on a node's /data volume). Produces a single portable,
 * checksummed archive so a node's durable memory can be backed up and restored
 * (e.g. to migrate a Kubernetes PVC, or recover a failed pod).
 *
 *   node darm-ann/backup.js create  <dataDir> <archive.json>
 *   node darm-ann/backup.js restore <archive.json> <dataDir>
 *   node darm-ann/backup.js verify  <archive.json>
 *
 * The archive embeds each file's contents + a SHA-256, plus a manifest digest,
 * so restore can detect corruption. The snapshot itself is validated by loading
 * it through DarmAnn.fromSnapshot (chain integrity) when present.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SNAPSHOT_CANDIDATES = ['node.json'];
const EXTRA_FILES = ['audit.log'];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function createArchive(dataDir, files) {
  const entries = {};
  const present = [];
  for (const name of files) {
    const p = path.join(dataDir, name);
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      entries[name] = { content: buf.toString('base64'), sha256: sha256(buf), bytes: buf.length };
      present.push(name);
    }
  }
  const manifest = { version: 1, createdAt: Date.now(), files: present, entries };
  manifest.digest = sha256(Buffer.from(JSON.stringify(manifest.entries)));
  return manifest;
}

function verifyArchive(manifest) {
  if (!manifest || manifest.version !== 1) return { ok: false, reason: 'bad version' };
  const digest = sha256(Buffer.from(JSON.stringify(manifest.entries)));
  if (digest !== manifest.digest) return { ok: false, reason: 'manifest digest mismatch' };
  for (const name of manifest.files) {
    const e = manifest.entries[name];
    const buf = Buffer.from(e.content, 'base64');
    if (sha256(buf) !== e.sha256) return { ok: false, reason: `checksum mismatch: ${name}` };
  }
  // If a snapshot is present, validate its chain integrity by loading it.
  const snapName = manifest.files.find((f) => SNAPSHOT_CANDIDATES.includes(f));
  if (snapName) {
    try {
      const snap = JSON.parse(Buffer.from(manifest.entries[snapName].content, 'base64').toString('utf8'));
      const DarmAnn = require('./index');
      const node = DarmAnn.fromSnapshot(snap, { config: { cdcp: { tMinAgeMs: 0 } } });
      const v = node.ltm.validate();
      if (!v.valid) return { ok: false, reason: 'restored LTM chain invalid' };
    } catch (e) {
      return { ok: false, reason: 'snapshot load failed: ' + e.message };
    }
  }
  return { ok: true, files: manifest.files, createdAt: manifest.createdAt };
}

function restoreArchive(manifest, dataDir) {
  const v = verifyArchive(manifest);
  if (!v.ok) throw new Error('archive verification failed: ' + v.reason);
  fs.mkdirSync(dataDir, { recursive: true });
  const written = [];
  for (const name of manifest.files) {
    const buf = Buffer.from(manifest.entries[name].content, 'base64');
    fs.writeFileSync(path.join(dataDir, name), buf);
    written.push(name);
  }
  return written;
}

function allFiles() {
  return [...SNAPSHOT_CANDIDATES, ...EXTRA_FILES];
}

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'create') {
      const manifest = createArchive(a, allFiles());
      fs.writeFileSync(b, JSON.stringify(manifest));
      console.log(JSON.stringify({ ok: true, archive: b, files: manifest.files, digest: manifest.digest.slice(0, 16) }, null, 2));
    } else if (cmd === 'restore') {
      const manifest = JSON.parse(fs.readFileSync(a, 'utf8'));
      const written = restoreArchive(manifest, b);
      console.log(JSON.stringify({ ok: true, restoredTo: b, files: written }, null, 2));
    } else if (cmd === 'verify') {
      const manifest = JSON.parse(fs.readFileSync(a, 'utf8'));
      const r = verifyArchive(manifest);
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    } else {
      console.log('usage: backup.js <create|restore|verify> ...');
      process.exit(1);
    }
  } catch (e) {
    console.error('error:', e.message);
    process.exit(2);
  }
}

module.exports = { createArchive, verifyArchive, restoreArchive, allFiles };
