import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Research, researchLimitsSchema } from '../src/research.js';
import type { Evidence, Notes, Snapshot } from '../src/model.js';
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
  assert.ok(file.nextOffset > 0 && file.nextOffset < file.totalCharacters);
  assert.ok(Buffer.byteLength(JSON.stringify(file.content)) <= 12000);
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
test('findings must cite fetched evidence and cover only actual release source IDs', async () => {
  const r = new Research(snapshot, evidence, limits, undefined, mock().fetcher);
  await call(r, 'pull_request');
  const finding = { sources: ['pr:1'], userProblem: 'Incomplete migration', implementation: 'Propagate listing errors',
    outcome: 'Failed listing stops migration', evidenceUrls: ['https://github.com/example/storage/pull/1'], limitations: [], needsReview: false };
  assert.throws(() => r.recordFindings({ findings: [{ ...finding, evidenceUrls: ['https://github.com/other/storage/pull/99'] }] }), /not returned/);
  assert.throws(() => r.recordFindings({ findings: [{ ...finding, sources: ['pr:99'] }] }), /outside/);
  r.recordFindings({ findings: [finding] });
  assert.deepEqual((r.artifact() as any).findings.findings[0], finding);
});
test('PRs read through the issues API keep canonical URLs and allow discussion reads', async () => {
  const m = mock();
  const r = new Research(snapshot, evidence, limits, undefined, async (url, init) => {
    if (String(url).endsWith('/issues/8')) return new Response(JSON.stringify({ number: 8, body: 'A PR', pull_request: { url: 'https://api.github.com/repos/other/storage/pulls/8' } }));
    return m.fetcher(url, init);
  });
  const result = await call(r, 'issue', { repository: 'other/storage', number: 8 });
  assert.equal(result.url, 'https://github.com/other/storage/pull/8');
  assert.ok(!(await call(r, 'issue_comments', { repository: 'other/storage', number: 8 })).error);
  r.recordFindings({ findings: [{ sources: ['pr:1'], userProblem: 'Problem', implementation: 'Change', outcome: 'Outcome',
    evidenceUrls: [result.url + '#discussion_r123'], limitations: [], needsReview: true }] });
});
test('shorthand issue references must be investigated and link depth bounds external follow-ups', async () => {
  const shorthand = structuredClone(evidence);
  shorthand.changes[0]!.pull!.body = 'Fixes other/storage#8';
  const r = new Research(snapshot, shorthand, { ...limits, maxDepth: 0 }, undefined, mock().fetcher);
  await call(r, 'pull_request');
  assert.throws(() => r.assertInvestigated(), /other\/storage\/issue\/8/);
  await call(r, 'issue', { repository: 'other/storage', number: 8 });
  assert.doesNotThrow(() => r.assertInvestigated());
  assert.match((await call(r, 'pull_request', { repository: 'other/storage', number: 9 })).error, /outside/);
});
test('unavailable auxiliary shorthand is recorded, never cited, and marks affected notes for review', async () => {
  const input = structuredClone(evidence);
  input.changes[0]!.pull!.body += '\ncompanion PR #1869, JuiceFS #4879/#3942';
  const r = new Research(snapshot, input, limits, undefined, mock().fetcher);
  await call(r, 'pull_request');
  await call(r, 'issue', { repository: 'other/storage', number: 8 });
  assert.throws(() => r.assertInvestigated(), /issue\/1869/);
  for (const number of [1869, 4879]) {
    const result = await call(r, 'issue', { number });
    assert.equal(result.unavailableReference.status, 404);
    assert.deepEqual(result.unavailableReference.sources, ['pr:1']);
  }
  assert.doesNotThrow(() => r.assertInvestigated());
  const finding = { sources: ['pr:1'], userProblem: 'Incomplete migration', implementation: 'Propagate errors',
    outcome: 'Failed listing stops migration', evidenceUrls: ['https://github.com/example/storage/pull/1'], limitations: [], needsReview: false };
  assert.throws(() => r.recordFindings({ findings: [{ ...finding, evidenceUrls: ['https://github.com/example/storage/issues/1869'] }] }), /not returned/);
  r.recordFindings({ findings: [finding] });
  const report = (r.artifact() as any).findings.findings[0];
  assert.equal(report.needsReview, true);
  assert.match(report.limitations.join('\n'), /example\/storage#1869 returned HTTP 404/);
  assert.equal((r.artifact() as any).unavailableReferences.length, 2);
  const notes: Notes = { entries: [{ category: 'fixes', summary: 'Migration copy errors are reported', impact: '',
    sources: ['pr:1'], upgradeNotes: [], needsReview: false }], excluded: [] };
  r.markReviewRequired(notes);
  assert.equal(notes.entries[0]!.needsReview, true);
  assert.ok(!r.citationUrls().some(url => url.includes('1869')));
});
test('missing source PRs cannot be excused as unavailable auxiliary evidence', async () => {
  const m = mock();
  const r = new Research(snapshot, evidence, limits, undefined, async (url, init) => {
    if (String(url).endsWith('/pulls/1')) return new Response('{}', { status: 404 });
    return m.fetcher(url, init);
  });
  const result = await call(r, 'pull_request');
  assert.equal(result.unavailableReference, undefined);
  await call(r, 'issue', { repository: 'other/storage', number: 8 });
  assert.throws(() => r.assertInvestigated(), /pull_request\/1/);
});
test('only direct auxiliary HTTP 404 or 410 resolves an attempted required read', async () => {
  for (const status of [404, 410, 401, 403, 429, 500]) {
    const m = mock();
    const r = new Research(snapshot, evidence, limits, undefined, async (url, init) => {
      if (String(url).endsWith('/issues/8')) return new Response('{}', { status });
      return m.fetcher(url, init);
    });
    await call(r, 'pull_request');
    await call(r, 'issue', { repository: 'other/storage', number: 8 });
    if ([404, 410].includes(status)) assert.doesNotThrow(() => r.assertInvestigated());
    else assert.throws(() => r.assertInvestigated(), /other\/storage\/issue\/8/);
  }
  const m = mock();
  const r = new Research(snapshot, evidence, limits, undefined, async (url, init) => {
    if (String(url).endsWith('/repos/other/storage')) return new Response('{}', { status: 404 });
    return m.fetcher(url, init);
  });
  await call(r, 'pull_request');
  await call(r, 'issue', { repository: 'other/storage', number: 8 });
  assert.throws(() => r.assertInvestigated(), /other\/storage\/issue\/8/);
});
test('unavailable evidence tracks every referring source without flagging unrelated findings', async () => {
  const input = structuredClone(evidence);
  input.changes.push({ id: 'commit:abc', diff: '', commits: [{ sha: 'abc', parents: [], subject: 'Context', message: 'Related other/storage#8' }] });
  input.changes.push({ id: 'commit:def', diff: '', commits: [] });
  const m = mock();
  const r = new Research(snapshot, input, limits, undefined, async (url, init) => {
    if (String(url).endsWith('/issues/8')) return new Response('{}', { status: 410 });
    return m.fetcher(url, init);
  });
  await call(r, 'pull_request');
  await call(r, 'issue', { repository: 'other/storage', number: 8 });
  r.recordFindings({ findings: input.changes.map(c => ({ sources: [c.id], userProblem: 'Task', implementation: 'Change', outcome: 'Outcome',
    evidenceUrls: ['https://github.com/example/storage/pull/1'], limitations: [], needsReview: false })) });
  assert.deepEqual((r.findingsReport() as any).findings.map((f: any) => f.needsReview), [true, true, false]);
});
test('provider diagnostics exclude arbitrary response messages and stacks', () => {
  const r = new Research(snapshot, evidence, limits);
  r.recordDiagnostic('research', { errorType: 'query', statusCode: 400, providerErrorParam: 'response_format',
    message: 'secret-token-response', stack: 'private-evidence' } as any);
  const saved = JSON.stringify(r.artifact());
  assert.match(saved, /response_format/);
  assert.ok(!saved.includes('secret-token-response') && !saved.includes('private-evidence'));
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
    await assert.rejects(prepare(f.options, { ...f, provider: { generate: async () => ({ entries: [], excluded: [] }) } }), /did not use GitHub research/);
    assert.equal(f.github.pulls.length, 0);
  } finally { await f.close(); }
});
