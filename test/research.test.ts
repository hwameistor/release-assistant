import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Research, researchLimitsSchema } from '../src/research.js';
import type { Evidence, Snapshot } from '../src/model.js';
import { fixture } from './helpers.js';
import { prepare } from '../src/prepare.js';

const from = 'a'.repeat(40), to = 'b'.repeat(40), head = 'c'.repeat(40);
const snapshot: Snapshot = { schemaVersion: 1, repository: 'example/storage', targetBranch: 'main', version: 'v1.1.2',
  fromTag: 'v1.1.1', fromSha: from, toSha: to, toRef: to, targetSha: to, createdAt: '', generatedPaths: [] };
const evidence: Evidence = { changes: [{ id: 'pr:1', commits: [], diff: 'actual diff', pull: { number: 1, title: 'Repair copy',
  body: 'Fixes https://github.com/other/storage/issues/8', html_url: 'https://github.com/example/storage/pull/1',
  state: 'closed', merged_at: '', merge_commit_sha: to, base: { ref: 'main' }, head: { ref: 'fix', repo: null } } }], netDiff: 'net diff', warnings: [] };
const limits = researchLimitsSchema.parse({});
const call = (research: Research, operation: string, extra: object = {}) => research.execute({ operation, repository: 'example/storage', number: 1, ...extra }) as Promise<any>;
function mock() {
  const requests: { url: string; auth?: string; method?: string; redirect?: string }[] = [];
  let moved = false;
  const fetcher: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), auth: (init?.headers as any)?.Authorization, method: init?.method, redirect: init?.redirect });
    const path = new URL(String(url)).pathname;
    let body: unknown;
    if (path === '/repos/other/storage') body = { private: false };
    else if (path.endsWith('/issues/8')) body = { number: 8, body: 'copy reports success after listing fails. Related https://github.com/other/storage/pull/9', title: 'Lost files' };
    else if (path.endsWith('/pulls/1')) body = { number: 1, body: 'Fixes https://github.com/other/storage/issues/8', base: { sha: from }, head: { sha: moved ? to : head }, merge_commit_sha: to };
    else if (path.endsWith('/pulls/9')) body = { number: 9, body: 'Fix listing propagation', base: { sha: from }, head: { sha: head } };
    else if (path.endsWith('/files')) body = [{ filename: 'copy.go', patch: '- return nil\n+ return err' }];
    else if (path.endsWith('/comments')) body = Array.from({ length: 10 }, () => ({ body: 'reported scenario', html_url: 'https://github.com/example/storage/issues/1#issuecomment-1' }));
    else if (path.includes('/contents/')) body = { type: 'file', encoding: 'base64', content: Buffer.from('code'.repeat(5000)).toString('base64') };
    else return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetcher, requests, move: () => { moved = true; } };
}
test('Copilot tools can discover issues, follow companion PRs and read immutable code', async () => {
  const m = mock(), r = new Research(snapshot, evidence, limits, 'read-only-secret', m.fetcher);
  assert.equal(m.requests.length, 0, 'construction must not prefetch instead of letting the model investigate');
  await call(r, 'pull_request');
  assert.throws(() => r.assertInvestigated(), /other\/storage\/issue\/8/);
  const issue = await call(r, 'issue', { repository: 'other/storage', number: 8 });
  assert.match(issue.content, /listing fails/);
  await call(r, 'pull_request', { repository: 'other/storage', number: 9 });
  const file = await call(r, 'file', { repository: 'other/storage', ref: head, path: 'copy.go' });
  assert.equal(file.revision, head);
  assert.equal(file.nextOffset, 10000);
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => r.assertInvestigated());
  assert.equal(m.requests.find(q => q.url.endsWith('/repos/other/storage'))?.auth, undefined);
  assert.ok(m.requests.every(q => q.method === 'GET' && q.redirect === 'error'));
  assert.ok(!JSON.stringify(r.artifact()).includes('read-only-secret'));
});
test('chunk continuations use cached evidence and comments expose pagination', async () => {
  const m = mock(), r = new Research(snapshot, evidence, limits, undefined, m.fetcher);
  const first = await call(r, 'file', { ref: to, path: 'copy.go' });
  const second = await call(r, 'file', { ref: to, path: 'copy.go', offset: first.nextOffset });
  assert.equal(first.sha256, second.sha256);
  assert.equal(m.requests.length, 1);
  const page = await call(r, 'pull_request_comments');
  assert.equal(JSON.parse(page.content).nextPage, 2);
});
test('scope rejects arbitrary repositories, paths and unfrozen file refs before HTTP', async () => {
  const m = mock(), r = new Research(snapshot, evidence, limits, undefined, m.fetcher);
  assert.match((await call(r, 'issue', { repository: 'private/secrets' })).error, /outside/);
  assert.match((await call(r, 'file', { ref: head, path: 'copy.go' })).error, /revisions/);
  assert.match((await call(r, 'file', { ref: to, path: '../token' })).error, /path/);
  assert.match((await call(r, 'file', { ref: to, path: '.git/config' })).error, /path/);
  assert.match((await call(r, 'file', { ref: 'main', path: 'copy.go' })).error, /Invalid/);
  assert.equal(m.requests.length, 0);
});
test('linked private repositories are rejected without sending read credentials', async () => {
  const seen: RequestInit[] = [];
  const r = new Research(snapshot, evidence, limits, 'private-read-token', async (_, init) => {
    seen.push(init!); return new Response(JSON.stringify({ private: true }));
  });
  assert.match((await call(r, 'issue', { repository: 'other/storage', number: 8 })).error, /public/);
  assert.equal((seen[0]!.headers as any).Authorization, undefined);
  assert.equal(seen.length, 1);
});
test('exhausted research budgets fail final validation, including parallel calls', async () => {
  const m = mock(), r = new Research(snapshot, evidence, { ...limits, maxCalls: 1 }, undefined, m.fetcher);
  const results = await Promise.all([call(r, 'pull_request'), call(r, 'pull_request')]);
  assert.equal(results[0].error, undefined);
  assert.match(results[1].error, /budget/);
  assert.throws(() => r.assertInvestigated(), /budget/);
  assert.equal(m.requests.length, 1);
  const bytes = new Research(snapshot, evidence, { ...limits, maxBytes: 100 }, undefined, m.fetcher);
  assert.match((await call(bytes, 'file', { ref: to, path: 'copy.go' })).error, /byte budget/);
});
test('changed PR revisions reject files instead of mixing two implementations', async () => {
  const m = mock(), r = new Research(snapshot, evidence, limits, undefined, m.fetcher);
  await call(r, 'pull_request'); m.move();
  assert.match((await call(r, 'pull_request_files')).error, /revisions changed/);
});
test('research artifacts survive generation failure and no release PR is published', async () => {
  const f = await fixture();
  try {
    const tree = f.github.trees.get(f.to)!;
    tree['release-assistant.yml'] = tree['release-assistant.yml']!.replace('provider: compatible', 'provider: copilot');
    await assert.rejects(prepare(f.options, { ...f, provider: { generate: async (_p, _s, research) => {
      assert.ok(research);
      await call(research, 'file', { ref: f.to, path: 'file.txt' });
      throw new Error('Simulated inference failure');
    } }, researchFetch: mock().fetcher }), /Simulated/);
    const artifact = JSON.parse(await readFile(join(f.options.outputDir, 'research.json'), 'utf8'));
    assert.equal(artifact.records[0].status, 'success');
    assert.equal(f.github.pulls.length, 0);
  } finally { await f.close(); }
});
test('generation refuses a valid JSON answer when Copilot never investigated', async () => {
  const f = await fixture();
  try {
    const tree = f.github.trees.get(f.to)!;
    tree['release-assistant.yml'] = tree['release-assistant.yml']!.replace('provider: compatible', 'provider: copilot');
    await assert.rejects(prepare(f.options, f), /did not use GitHub research/);
    assert.equal(f.github.pulls.length, 0);
  } finally { await f.close(); }
});
