import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { chooseTag, recentTags } from '../src/tags.js';
import { prepare, releaseBranch, statePath } from '../src/prepare.js';
import { prepareSummary } from '../src/summary.js';
import { validateRelease } from '../src/validate.js';

test('recent tags are reachable SemVer releases below the proposed version, including annotated tags and prereleases', async t => {
  const f = await fixture(); t.after(f.close);
  f.run('tag', 'v1.0.99', f.from);
  f.run('tag', '-a', 'v1.1.2-alpha1', '-m', 'prerelease', f.to);
  f.run('tag', '1.1.2-alpha2', f.to);
  f.run('tag', 'v1.1.2', f.from); // Equal release and higher versions are excluded.
  f.run('tag', 'v2.0.0', f.from);
  f.run('tag', 'juicesync-v1.4.1', f.to);
  const later = await f.commit('later.txt', 'later', 'later change');
  f.run('tag', 'v1.1.2-rc2', later); // On the same branch, but after the requested cutoff.
  f.run('checkout', '-b', 'unmerged', f.from);
  const other = await f.commit('other.txt', 'other', 'unmerged change');
  f.run('tag', 'v1.1.2-rc1', other);
  const candidates = await recentTags(f.git, f.to, 'v1.1.2');
  assert.deepEqual(candidates, [
    { name: '1.1.2-alpha2', sha: f.to },
    { name: 'v1.1.2-alpha1', sha: f.to },
    { name: 'v1.1.1', sha: f.from },
  ]);
  for (const [index, choice] of ['latest', 'second-latest', 'third-latest'].entries()) {
    assert.equal(chooseTag(candidates, choice as 'latest' | 'second-latest' | 'third-latest'), candidates[index]);
  }
});

test('automatic selection freezes the tag, candidates and SHA before inference; reruns reuse them despite tag changes', async t => {
  const f = await fixture(); t.after(f.close);
  const options = { ...f.options, fromTag: '', version: 'v1.1.3' };
  await assert.rejects(prepare(options, { ...f, provider: { generate: async () => { throw new Error('model unavailable'); } } }), /model unavailable/);
  const branch = releaseBranch(options.repository, options.targetBranch, options.version);
  const frozen = JSON.parse(await f.github.requiredFile(statePath, await f.github.requiredRef('heads', branch)));
  assert.equal(frozen.fromTag, 'v1.1.1'); assert.equal(frozen.fromSha, f.from);
  f.run('tag', 'v1.1.2', f.to);
  f.run('tag', '-f', 'v1.1.1', f.to);
  f.github.refs.set('tags/v1.1.1', f.to);
  const first = await prepare(options, f);
  assert.deepEqual(first.manifest.snapshot, frozen);
  const second = await prepare(options, f);
  assert.equal(second.pull?.number, first.pull?.number);
  assert.equal(f.github.pulls.length, 1);
  assert.deepEqual(second.manifest.snapshot, frozen);
  const summary = prepareSummary(second.pull, second.manifest);
  assert.match(summary, /Starting tag: `v1.1.1`/);
  assert.match(summary, /Automatic choice: `latest`/);
  assert.match(second.pull!.body!, /v1.1.1.*selected/);
  await validateRelease(f.github, branch, options.targetBranch);
  const next = await f.commit('next.txt', 'advanced', 'advance target');
  f.github.trees.set(next, { ...f.github.trees.get(f.to), 'next.txt': 'advanced' });
  f.github.refs.set('heads/release/v1.1', next);
  await assert.rejects(prepare(options, f), /stale/);
  const refreshed = await prepare({ ...options, toRef: next }, f);
  assert.equal(refreshed.pull?.number, first.pull?.number);
  assert.equal(refreshed.manifest.snapshot.fromTag, 'v1.1.2');
  await validateRelease(f.github, branch, options.targetBranch);
});

test('manual tags override rank and remain unrestricted; changing automatic rank updates the same PR', async t => {
  const f = await fixture(); t.after(f.close);
  f.run('tag', 'v1.1.0', f.from); f.run('tag', 'v1.0.9', f.from);
  const options = { ...f.options, fromTag: undefined };
  const first = await prepare(options, f);
  assert.equal(first.manifest.snapshot.fromTag, 'v1.1.1');
  const second = await prepare({ ...options, fromTagChoice: 'second-latest' }, f);
  assert.equal(second.manifest.snapshot.fromTag, 'v1.1.0');
  const third = await prepare({ ...options, fromTagChoice: 'third-latest' }, f);
  assert.equal(third.manifest.snapshot.fromTag, 'v1.0.9');
  f.github.refs.set('tags/custom-baseline', f.from);
  const manual = await prepare({ ...options, fromTag: 'refs/tags/custom-baseline', fromTagChoice: 'third-latest' }, f);
  assert.equal(manual.manifest.snapshot.fromTag, 'custom-baseline');
  assert.equal(manual.manifest.snapshot.fromTagSelection, undefined);
  assert.equal(manual.pull?.number, first.pull?.number);
  assert.equal(f.github.pulls.length, 1);
  await validateRelease(f.github, manual.branch, options.targetBranch);
  assert.match(prepareSummary(manual.pull, manual.manifest), /specified manually/);
});

test('unavailable ranks fail before inference or remote writes; automatic preview also freezes its selection', async t => {
  const f = await fixture(); t.after(f.close);
  const options = { ...f.options, fromTag: '', version: 'v1.1.3' };
  await assert.rejects(prepare({ ...options, fromTagChoice: 'third-latest' }, f), /found 1 eligible tags/);
  await assert.rejects(prepare({ ...options, version: 'v0.1.0' }, f), /found 0 eligible tags/);
  await assert.rejects(prepare({ ...options, fromTagChoice: 'fourth-latest' }, f));
  assert.equal(f.github.writes, 0); assert.equal(f.github.inferenceCalls, 0);
  const first = await prepare({ ...options, publish: false }, f);
  f.run('tag', 'v1.1.2', f.to);
  const second = await prepare({ ...options, publish: false }, f);
  assert.deepEqual(second.manifest.snapshot, first.manifest.snapshot);
  assert.equal(JSON.parse(await readFile(join(options.outputDir, 'snapshot.json'), 'utf8')).fromTag, 'v1.1.1');
  assert.equal(f.github.writes, 0); assert.equal(f.github.pulls.length, 0);
});
