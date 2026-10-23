import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { collect } from '../src/collect.js';
import type { Pull, Snapshot } from '../src/model.js';

test('real merge, squash, cherry-pick and revert histories retain provenance and authoritative net diff', async t => {
  const f = await fixture(); t.after(f.close);
  f.run('checkout', '-b', 'feature');
  const one = await f.commit('feature.txt', 'one\n', 'feature part one');
  const two = await f.commit('feature.txt', 'two\n', 'feature part two');
  f.run('checkout', 'release/v1.1'); f.run('merge', '--no-ff', 'feature', '-m', 'Merge pull request #2');
  const merge = f.run('rev-parse', 'HEAD');
  f.run('checkout', '-b', 'squash-feature'); await f.commit('squash.txt', 'squashed\n', 'squash change');
  f.run('checkout', 'release/v1.1'); f.run('merge', '--squash', 'squash-feature'); f.run('commit', '-m', 'Squashed change (#3)');
  const squash = f.run('rev-parse', 'HEAD');
  f.run('checkout', '-b', 'upstream'); const original = await f.commit('fix.txt', 'fix\n', 'Fix timeout');
  f.run('checkout', 'release/v1.1'); f.run('cherry-pick', '-x', original);
  const picked = f.run('rev-parse', 'HEAD'); f.run('revert', '--no-edit', picked);
  const last = f.run('rev-parse', 'HEAD');
  const pr = (number: number, sha: string, base = 'release/v1.1'): Pull => ({ number, title: `PR ${number}`, body: '', html_url: `https://github.com/example/storage/pull/${number}`,
    state: 'closed', merged_at: '2026-10-01', merge_commit_sha: sha, base: { ref: base }, head: { ref: `feature-${number}`, repo: { full_name: f.github.repository } } });
  const merged = pr(2, merge), squashed = pr(3, squash), backport = pr(4, picked), upstream = pr(40, original, 'main');
  backport.body = 'Backport of #40';
  f.github.pulls.push(merged, squashed, backport, upstream);
  for (const sha of [one, two, merge]) f.github.associated.set(sha, [merged]);
  f.github.associated.set(squash, [squashed]); f.github.associated.set(picked, [backport, upstream]);
  const snapshot: Snapshot = { schemaVersion: 1, repository: f.github.repository, targetBranch: 'release/v1.1', version: 'v1.1.2',
    fromTag: 'v1.1.1', fromSha: f.from, toRef: last, toSha: last, targetSha: last, createdAt: '2026-10-23', generatedPaths: [] };
  const evidence = await collect(f.git, f.github, snapshot, 100);
  assert.equal(evidence.changes.filter(c => c.id === 'pr:2').length, 1);
  assert.equal(evidence.changes.find(c => c.id === 'pr:2')!.commits.length, 3);
  assert.equal(evidence.changes.find(c => c.id === 'pr:4')!.originalPull?.number, 40);
  assert.equal(evidence.changes.some(c => c.id === 'pr:40'), false);
  assert.ok(evidence.changes.find(c => c.id === `commit:${last}`));
  assert.doesNotMatch(evidence.netDiff, /fix\.txt/);
  assert.match(evidence.netDiff, /feature\.txt/); assert.match(evidence.netDiff, /squash\.txt/);
  await assert.rejects(collect(f.git, f.github, snapshot, 2), /exceeding maxCommits/);
});
