import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { prepare, statePath, manifestPath, releaseBranch } from '../src/prepare.js';
import { validateRelease } from '../src/validate.js';

test('rerun refreshes model and latest template, overwrites manual notes, keeps range and same PR with normal commits', async t => {
  const f = await fixture(); t.after(f.close);
  const first = await prepare(f.options, f);
  const firstHead = await f.github.requiredRef('heads', first.branch);
  f.github.trees.get(firstHead)!['changelogs/released/v1.1.2-alpha1/changelog'] = 'manual edit';
  const templateSha = 'f'.repeat(40);
  f.github.trees.set(templateSha, { ...f.github.trees.get(f.to), 'template.md': '## {{version}}\n\nNew template\n\n{{sections}}' });
  f.github.refs.set('heads/main', templateSha);
  const second = await prepare(f.options, f);
  const head = await f.github.requiredRef('heads', first.branch);
  assert.equal(f.github.pulls.length, 1); assert.equal(f.github.inferenceCalls, 2);
  assert.equal(second.pull?.number, first.pull?.number);
  assert.equal(second.manifest.templateSha, templateSha); assert.equal(second.manifest.snapshot.toSha, f.to);
  assert.deepEqual(f.github.parents.get(head), [firstHead]);
  const notes = await f.github.requiredFile('changelogs/released/v1.1.2-alpha1/changelog', head);
  assert.match(notes, /New template/); assert.match(notes, /handling 2/); assert.doesNotMatch(notes, /manual edit/);
  assert.match(await f.github.requiredFile('Chart.yaml', head), /version: v1.2.0/);
  await validateRelease(f.github, first.branch, 'release/v1.1');
  f.github.trees.get(head)!['Chart.yaml'] += '# edited\n';
  await assert.rejects(validateRelease(f.github, first.branch, 'release/v1.1'), /changed after validation/);
});

test('first model failure persists snapshot; original rerun refuses advanced target; explicit new SHA refreshes same PR identity', async t => {
  const f = await fixture(); t.after(f.close);
  await assert.rejects(prepare(f.options, { ...f, provider: { generate: async () => { throw new Error('inference unavailable'); } } }), /inference unavailable/);
  const branch = releaseBranch(f.options.repository, f.options.targetBranch, f.options.version);
  const frozenHead = await f.github.requiredRef('heads', branch);
  assert.equal(JSON.parse(await f.github.requiredFile(statePath, frozenHead)).toSha, f.to);
  assert.equal(f.github.pulls.length, 0);
  const next = await f.commit('file.txt', 'new target\n', 'next change');
  f.github.trees.set(next, { ...f.github.trees.get(f.to), 'file.txt': 'new target\n' });
  f.github.refs.set('heads/release/v1.1', next);
  await assert.rejects(prepare(f.options, f), /stale/);
  assert.equal(f.github.inferenceCalls, 0);
  const result = await prepare({ ...f.options, toRef: next }, f);
  assert.equal(result.branch, branch); assert.equal(result.manifest.snapshot.toSha, next);
  const parent = f.github.parents.get(await f.github.requiredRef('heads', branch))![0]!;
  assert.deepEqual(f.github.parents.get(parent), [frozenHead, next]);
  await validateRelease(f.github, branch, f.options.targetBranch);
});

test('PR creation failure can be rerun without duplicating commits or PRs', async t => {
  const f = await fixture(); t.after(f.close);
  f.github.failCreate = true;
  await assert.rejects(prepare(f.options, f), /creation failure/);
  const result = await prepare(f.options, f);
  assert.equal(f.github.pulls.length, 1); assert.equal(f.github.inferenceCalls, 2);
  await validateRelease(f.github, result.branch, f.options.targetBranch);
});

test('closed, merged and published releases cannot be regenerated', async t => {
  const f = await fixture(); t.after(f.close);
  const result = await prepare(f.options, f);
  const writes = f.github.writes;
  result.pull!.state = 'closed';
  await assert.rejects(prepare(f.options, f), /closed or merged/);
  result.pull!.state = 'open'; result.pull!.merged_at = new Date().toISOString();
  await assert.rejects(prepare(f.options, f), /closed or merged/);
  result.pull!.merged_at = null;
  f.github.refs.set(`tags/${f.options.version}`, f.to);
  await assert.rejects(prepare(f.options, f), /tag already exists/);
  assert.equal(f.github.writes, writes);
});

test('concurrent branch edits and PR closure during inference stop publication', async t => {
  const f = await fixture(); t.after(f.close);
  const first = await prepare(f.options, f);
  await assert.rejects(prepare(f.options, { ...f, provider: { generate: async prompt => {
    const notes = await f.provider.generate(prompt);
    const head = await f.github.requiredRef('heads', first.branch);
    const next = await f.github.writeCommit(head, { 'manual.txt': 'change' }, 'manual');
    f.github.refs.set(`heads/${first.branch}`, next);
    return notes;
  } } }), /concurrently/);
  await assert.rejects(prepare(f.options, { ...f, provider: { generate: async prompt => {
    first.pull!.state = 'closed'; return f.provider.generate(prompt);
  } } }), /closed or merged/);
});

test('preview writes only local artifacts and freezes its original tag range', async t => {
  const f = await fixture(); t.after(f.close);
  const result = await prepare({ ...f.options, publish: false }, f);
  assert.equal(f.github.writes, 0); assert.equal(f.github.pulls.length, 0);
  assert.match(await readFile(join(f.options.outputDir, 'files/CHANGELOG.md'), 'utf8'), /v1.1.2-alpha1/);
  assert.equal(JSON.parse(await readFile(join(f.options.outputDir, 'manifest.json'), 'utf8')).snapshot.toSha, f.to);
  assert.equal(result.pull, undefined);
});

test('invalid output, uncovered sources and oversized prompts never create a release PR', async t => {
  const f = await fixture(); t.after(f.close);
  await assert.rejects(prepare(f.options, { ...f, provider: { generate: async () => ({ entries: [], excluded: [] }) } }), /Missing evidence coverage/);
  const tree = f.github.trees.get(f.to)!;
  tree['release-assistant.yml'] += 'limits:\n  maxPromptBytes: 1000\n';
  await assert.rejects(prepare(f.options, f), /Nothing was truncated/);
  assert.equal(f.github.pulls.length, 0); assert.equal(f.github.inferenceCalls, 0);
  const head = await f.github.requiredRef('heads', releaseBranch(f.options.repository, f.options.targetBranch, f.options.version));
  assert.equal(await f.github.file(manifestPath, head), null);
});
