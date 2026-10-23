import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safePath, loadConfig, outputPaths } from '../src/config.js';
import { normalizeVersion } from '../src/prepare.js';
import { validateNotes, renderNotes, updateChangelog } from '../src/render.js';
import { writeOutput } from '../src/storage.js';
import type { Evidence, Snapshot } from '../src/model.js';

test('paths cannot escape output directory, replace workflow files or follow symlinks', async t => {
  for (const path of ['.', '../a', 'a/../../a', '/tmp/a', 'a\\b', '.git/config', '.github/workflows/release.yml', 'a\nb', 'a//b']) assert.throws(() => safePath(path), /Unsafe/);
  const config = loadConfig('schemaVersion: 1\nai: {model: configured-model}\noutput: {changelog: same, releaseNotes: same}');
  assert.throws(() => outputPaths(config, 'v1.1.2'), /unique/);
  const root = await mkdtemp(join(tmpdir(), 'release-assistant-path-')); t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(tmpdir(), join(root, 'escape'));
  await assert.rejects(writeOutput(root, 'escape/file', 'bad'), /symbolic link/);
});

test('structured output rejects invented, missing and conflicting sources and supports explicit exclusions', () => {
  const evidence: Evidence = { changes: [{ id: 'pr:42', commits: [], diff: '' }], netDiff: '', warnings: [] };
  assert.throws(() => validateNotes({ entries: [], excluded: [] }, evidence), /Missing evidence/);
  assert.throws(() => validateNotes({ entries: [], excluded: [{ sources: ['pr:43'], reason: 'reverted' }] }, evidence), /Unknown/);
  assert.throws(() => validateNotes({ entries: [], excluded: [{ sources: ['pr:42'], reason: '' }] }, evidence));
  const entry = { category: 'fixes', summary: 'Fix file copying.', impact: '', sources: ['pr:42'], upgradeNotes: [], needsReview: false };
  assert.throws(() => validateNotes({ entries: [entry], excluded: [{ sources: ['pr:42'], reason: 'reverted' }] }, evidence), /both included/);
  assert.equal(validateNotes({ entries: [], excluded: [{ sources: ['pr:42'], reason: 'Fully reverted in this range.' }] }, evidence).excluded.length, 1);
});

test('SemVer prereleases and template validation work without duplicate changelog entries', () => {
  assert.equal(normalizeVersion('1.1.2-alpha1'), 'v1.1.2-alpha1');
  for (const input of ['1.1', 'v1.1.2;echo bad', 'v01.1.2', 'v1.1.2\n']) assert.throws(() => normalizeVersion(input));
  const snapshot = { version: 'v1.1.2-alpha1', repository: 'example/storage', fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40), createdAt: '2026-10-23' } as Snapshot;
  const notes = { entries: [], excluded: [] };
  assert.throws(() => renderNotes(notes, snapshot, '{{sections}}'), /version/);
  assert.throws(() => renderNotes(notes, snapshot, '{{version}} {{sections}} {{unknown}}'), /Unknown template/);
  let log = updateChangelog('# Changelog\n\nHistorical notes\n', snapshot.version, 'first\n');
  log = updateChangelog(log, snapshot.version, 'second\n');
  assert.doesNotMatch(log, /first/); assert.match(log, /second/); assert.match(log, /Historical/);
  assert.equal(log.split(':start -->').length, 2);
});
