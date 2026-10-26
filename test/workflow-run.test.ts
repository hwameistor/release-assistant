import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { prepare, releaseBranch, statePath } from '../src/prepare.js';
import { validateRelease } from '../src/validate.js';
import { workflowRunFromEnv } from '../src/workflow-run.js';

const run = (runId: string, attempt = 1) => ({ repository: 'example/storage', runId, attempt });
async function advance(f: Awaited<ReturnType<typeof fixture>>) {
  const next = await f.commit('file.txt', 'fixed after the first generation\n', 'Preserve user environment');
  f.github.trees.set(next, { ...f.github.trees.get(f.to), 'file.txt': 'fixed after the first generation\n' });
  f.github.refs.set('heads/release/v1.1', next);
  return next;
}

test('Actions run identity is stable across attempts; local CLI does not inherit partial Actions variables', () => {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'example/storage', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1' };
  assert.deepEqual(workflowRunFromEnv(env), run('100'));
  assert.deepEqual(workflowRunFromEnv({ ...env, GITHUB_RUN_ATTEMPT: '2' }), run('100', 2));
  assert.equal(workflowRunFromEnv({ GITHUB_RUN_ID: '100' }), undefined);
  assert.throws(() => workflowRunFromEnv({ ...env, GITHUB_RUN_ATTEMPT: undefined }), /GITHUB_RUN_ATTEMPT/);
  assert.throws(() => workflowRunFromEnv({ ...env, GITHUB_RUN_ID: '' }));
});

for (const legacy of [false, true]) {
  test(`new dispatch refreshes unchanged branch input and updates the same PR (${legacy ? 'legacy' : 'run-owned'} snapshot)`, async t => {
    const f = await fixture(); t.after(f.close);
    const first = await prepare({ ...f.options, workflowRun: legacy ? undefined : run('100') }, f);
    const previousHead = await f.github.requiredRef('heads', first.branch);
    const next = await advance(f);
    const result = await prepare({ ...f.options, workflowRun: run('101') }, f);
    assert.equal(result.manifest.snapshot.toSha, next);
    assert.equal(result.manifest.snapshot.targetSha, next);
    assert.equal(result.manifest.snapshot.toRef, f.options.toRef);
    assert.deepEqual(result.manifest.snapshot.workflowRun, { repository: 'example/storage', runId: '101' });
    assert.match(result.manifest.evidence.netDiff, /fixed after the first generation/);
    assert.ok(result.manifest.evidence.changes.some(change => change.commits.some(commit => commit.sha === next)));
    assert.equal(result.pull?.number, first.pull?.number);
    assert.equal(f.github.pulls.length, 1);
    const head = await f.github.requiredRef('heads', first.branch);
    const frozenHead = f.github.parents.get(head)![0]!;
    assert.deepEqual(f.github.parents.get(frozenHead), [previousHead, next]);
    await validateRelease(f.github, result.branch, f.options.targetBranch);
  });
}

test('rerun after inference failure reuses the frozen range and latest template, even if the starting tag moves', async t => {
  const f = await fixture(); t.after(f.close);
  const options = { ...f.options, workflowRun: run('100') };
  await assert.rejects(prepare(options, { ...f, provider: { generate: async () => { throw new Error('model unavailable'); } } }), /model unavailable/);
  const branch = releaseBranch(options.repository, options.targetBranch, options.version);
  const frozen = JSON.parse(await f.github.requiredFile(statePath, await f.github.requiredRef('heads', branch)));
  f.github.refs.set('tags/v1.1.1', f.to);
  const templateSha = 'f'.repeat(40);
  f.github.trees.set(templateSha, { ...f.github.trees.get(f.to), 'template.md': '## {{version}}\n\nLatest template\n\n{{sections}}' });
  f.github.refs.set('heads/main', templateSha);
  const result = await prepare({ ...options, workflowRun: run('100', 2) }, f);
  assert.deepEqual(result.manifest.snapshot, frozen);
  assert.equal(result.manifest.snapshot.fromSha, f.from);
  assert.equal(result.manifest.templateSha, templateSha);
  assert.match(result.pull!.body!, /Latest template/);
  const writes = f.github.writes;
  await advance(f);
  await assert.rejects(prepare({ ...options, workflowRun: run('100', 3) }, f), /stale/);
  assert.equal(f.github.writes, writes);
  assert.equal(f.github.inferenceCalls, 1);
});

test('old reruns cannot adopt or overwrite a newer run snapshot', async t => {
  const f = await fixture(); t.after(f.close);
  await prepare({ ...f.options, workflowRun: run('100') }, f);
  const latest = await prepare({ ...f.options, workflowRun: run('101') }, f);
  const head = await f.github.requiredRef('heads', latest.branch);
  const calls = f.github.inferenceCalls, writes = f.github.writes;
  await assert.rejects(prepare({ ...f.options, workflowRun: run('100', 2) }, f), /another run has replaced/);
  await assert.rejects(prepare({ ...f.options, workflowRun: { ...run('101', 2), repository: 'other/storage' } }, f), /another run has replaced/);
  assert.equal(await f.github.requiredRef('heads', latest.branch), head);
  assert.equal(f.github.inferenceCalls, calls);
  assert.equal(f.github.writes, writes);
});

test('rerun without its own snapshot or with changed range inputs fails before writes and inference', async t => {
  const f = await fixture(); t.after(f.close);
  await assert.rejects(prepare({ ...f.options, workflowRun: run('100', 2) }, f), /No snapshot/);
  assert.equal(f.github.writes, 0);
  await prepare({ ...f.options, workflowRun: run('100') }, f);
  const writes = f.github.writes, calls = f.github.inferenceCalls;
  await assert.rejects(prepare({ ...f.options, toRef: f.to, workflowRun: run('100', 2) }, f), /inputs changed/);
  assert.equal(f.github.writes, writes);
  assert.equal(f.github.inferenceCalls, calls);
});

test('new dispatch refreshes automatic tag selection; reruns preserve the old candidates', async t => {
  const f = await fixture(); t.after(f.close);
  const options = { ...f.options, version: 'v1.1.3', fromTag: '', workflowRun: run('100') };
  const first = await prepare(options, f);
  f.run('tag', 'v1.1.2', f.to);
  const retry = await prepare({ ...options, workflowRun: run('100', 2) }, f);
  assert.deepEqual(retry.manifest.snapshot.fromTagSelection, first.manifest.snapshot.fromTagSelection);
  const next = await advance(f);
  const latest = await prepare({ ...options, workflowRun: run('101') }, f);
  assert.equal(latest.manifest.snapshot.fromTag, 'v1.1.2');
  assert.equal(latest.manifest.snapshot.fromSha, f.to);
  assert.equal(latest.manifest.snapshot.toSha, next);
  assert.equal(latest.pull?.number, first.pull?.number);
});

test('new dispatch preserves explicit cutoff and refuses to discard unrelated PR edits', async t => {
  const f = await fixture(); t.after(f.close);
  const first = await prepare({ ...f.options, workflowRun: run('100') }, f);
  const head = await f.github.requiredRef('heads', first.branch);
  await advance(f);
  const writes = f.github.writes, calls = f.github.inferenceCalls;
  await assert.rejects(prepare({ ...f.options, toRef: f.to, workflowRun: run('101') }, f), /must end at the target branch HEAD/);
  f.github.trees.get(head)!['manual.txt'] = 'retain me';
  await assert.rejects(prepare({ ...f.options, workflowRun: run('101') }, f), /edits outside generated files/);
  assert.equal(f.github.writes, writes);
  assert.equal(f.github.inferenceCalls, calls);
});

test('new dispatch still stops publication if the target moves during inference', async t => {
  const f = await fixture(); t.after(f.close);
  await assert.rejects(prepare({ ...f.options, workflowRun: run('100') }, { ...f, provider: { generate: async prompt => {
    await advance(f);
    return f.provider.generate(prompt);
  } } }), /stale/);
  assert.equal(f.github.pulls.length, 0);
});
