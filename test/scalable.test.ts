import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EvidenceStore, fragment } from '../src/evidence.js';
import { Research, researchLimitsSchema } from '../src/research.js';
import { generationPrompt, prepare } from '../src/prepare.js';
import { loadConfig } from '../src/config.js';
import { contextBudget } from '../src/context.js';
import { CopilotProvider } from '../src/providers.js';
import { writeOutput } from '../src/storage.js';
import type { Evidence, Snapshot } from '../src/model.js';
import type { CopilotClient, ModelInfo } from '@github/copilot-sdk';
import { fixture } from './helpers.js';

const from = 'a'.repeat(40), to = 'b'.repeat(40);
const snapshot: Snapshot = { schemaVersion: 1, repository: 'example/storage', targetBranch: 'main', version: 'v1.2.0',
  fromTag: 'v1.1.0', fromSha: from, toSha: to, toRef: to, targetSha: to, createdAt: '', generatedPaths: [] };
const config = loadConfig('schemaVersion: 1\nai:\n  provider: copilot\n  model: test-model\n');
const limits = researchLimitsSchema.parse({});
function input(diff = '-replaceAllEnv\n+mergeDeclaredEnv\n'): Evidence {
  return { changes: [399, 413].map(n => ({ id: `pr:${n}`, diff: n === 399 ? '+replaceAllEnv\n' : diff, commits: [],
    pull: { number: n, title: `Change ${n}`, body: null, html_url: `https://github.com/example/storage/pull/${n}`,
      state: 'closed', merged_at: 'date', merge_commit_sha: to, base: { ref: 'main' }, head: { ref: 'fix', repo: null } } })), netDiff: diff, warnings: [] };
}
const fetcher: typeof fetch = async url => new Response(JSON.stringify({ number: Number(String(url).split('/').at(-1)),
  body: 'Implementation evidence', base: { sha: from }, head: { sha: to }, merge_commit_sha: to }));
async function tool(r: Research, name: string, args: object): Promise<any> {
  return r.tools().find(t => t.name === name)!.handler(args, {} as never);
}
async function readAll(r: Research, documentId: string): Promise<string> {
  let offset: number | null = 0, text = '';
  while (offset !== null) {
    const page = await tool(r, 'release_evidence', { operation: 'read', documentId, offset });
    assert.equal(page.error, undefined); text += page.content; offset = page.nextOffset;
  }
  return text;
}
async function investigate(r: Research): Promise<void> {
  for (const doc of r.evidence.coverage().filter(d => d.required)) await readAll(r, doc.id);
  for (const number of [399, 413]) await r.execute({ operation: 'pull_request', repository: snapshot.repository, number });
}
function finding(r: Research, outcome = 'Declared overrides apply while retaining manually added variables') {
  return { sources: ['pr:399', 'pr:413'], userProblem: 'Configure member environment', implementation: 'Merge declared variables',
    outcome, evidenceUrls: r.citationUrls(), limitations: [], needsReview: false };
}

test('Copilot initial input stays bounded for many PRs and megabytes of diff; compatible input is unchanged', () => {
  const small = input(), big = input('LARGE_CONTENT_SENTINEL\n'.repeat(100000));
  for (let i = 0; i < 1000; i++) big.changes.push({ id: `commit:${i}`, commits: [], diff: 'extra' });
  const a = generationPrompt(snapshot, config, 'Policy', small, new Research(snapshot, small, limits));
  const b = generationPrompt(snapshot, config, 'Policy', big, new Research(snapshot, big, limits));
  assert.ok(Buffer.byteLength(b) < 20000);
  assert.ok(Math.abs(b.length - a.length) < 20);
  assert.ok(!b.includes('LARGE_CONTENT_SENTINEL') && !b.includes('pr:399'));
  assert.match(generationPrompt(snapshot, config, 'Policy', small), /EVIDENCE:\n/);
});

test('huge Unicode lines, deletion-only patches, renames and binaries survive chunking exactly', () => {
  const text = 'diff --git a/旧路径 b/新路径\nrename from 旧路径\nrename to 新路径\n'
    + '-删除接口😀\\"'.repeat(30000) + '\nBinary files a/image and b/image differ\n';
  const store = new EvidenceStore(snapshot, input(text));
  let offset: number | null = 0, restored = '', count = 0;
  while (offset !== null) {
    const part = store.read('net-diff', offset, 4096);
    assert.ok(Buffer.byteLength(JSON.stringify(part.content)) <= 4096);
    assert.ok(!/[\uD800-\uDBFF]$/.test(part.content));
    store.acknowledge('net-diff', offset, part.content.length);
    restored += part.content; offset = part.nextOffset; count++;
  }
  assert.equal(restored, text); assert.ok(count > 100);
  assert.equal(store.coverage().find(d => d.id === 'net-diff')?.nextUnreadOffset, null);
  assert.throws(() => fragment('😀', 1, 100), /offset/);
});

test('reading the tail or overlapping fragments cannot hide a hole in net diff coverage', () => {
  const store = new EvidenceStore(snapshot, input('abcdefghij'));
  store.acknowledge('net-diff', 5, 5);
  store.acknowledge('net-diff', 0, 2);
  store.acknowledge('net-diff', 1, 2);
  assert.equal(store.coverage()[0]!.nextUnreadOffset, 3);
  assert.throws(() => store.assertComplete(), /net-diff at offset 3/);
  store.acknowledge('net-diff', 3, 2);
  assert.equal(store.coverage()[0]!.nextUnreadOffset, null);
});

test('a partial source PR read cannot count as complete even when its last fragment was read', async () => {
  const r = new Research(snapshot, input(), limits, undefined, async () => new Response(JSON.stringify({ body: 'detail '.repeat(10000) })));
  const args = { operation: 'pull_request', repository: snapshot.repository, number: 399 };
  const first: any = await r.execute(args);
  assert.ok(first.nextOffset);
  await r.execute({ ...args, offset: first.totalCharacters - 5 });
  assert.throws(() => r.assertInvestigated(), /pull_request\/399/);
  let offset = first.nextOffset;
  while (offset !== null) { const result: any = await r.execute({ ...args, offset }); offset = result.nextOffset; }
  const status: any = r.status();
  assert.deepEqual(status.missingTargets.map((t: any) => t.number), [413]);
});

test('saved findings are durable, replace provisional conclusions and retain cross-PR provenance', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'research-checkpoint-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const r = new Research(snapshot, input(), limits, undefined, fetcher);
  r.setProgressWriter(() => writeOutput(directory, 'progress.json', JSON.stringify(r.checkpoint())));
  await investigate(r);
  await tool(r, 'research_notebook', { operation: 'save', id: 'environment', finding: finding(r, 'Provisional: removes manual variables') });
  await tool(r, 'research_notebook', { operation: 'save', id: 'environment', finding: finding(r) });
  r.assertComplete();
  const saved = JSON.parse(await readFile(join(directory, 'progress.json'), 'utf8'));
  assert.equal(Object.keys(saved.findings).length, 1);
  assert.deepEqual(saved.findings.environment.sources, ['pr:399', 'pr:413']);
  assert.doesNotMatch(JSON.stringify(saved), /Provisional/);
  const read = await tool(r, 'research_notebook', { operation: 'read', id: 'environment' });
  assert.equal(JSON.parse(read.content).outcome, finding(r).outcome);
  await tool(r, 'research_notebook', { operation: 'remove', id: 'environment' });
  assert.throws(() => r.assertComplete(), /notebook is empty/);
});

test('local evidence shares call/byte limits and failed delivery never marks content read', async () => {
  const r = new Research(snapshot, input('large'.repeat(5000)), { ...limits, maxBytes: 100 });
  const result = await tool(r, 'release_evidence', { operation: 'read', documentId: 'net-diff' });
  assert.match(result.error, /byte budget/);
  assert.equal(r.evidence.coverage()[0]!.nextUnreadOffset, 0);
  assert.throws(() => r.assertComplete(), /byte budget/);
  const calls = new Research(snapshot, input(), { ...limits, maxCalls: 1 });
  const pages = await Promise.all([tool(calls, 'release_evidence', { operation: 'index' }), tool(calls, 'release_evidence', { operation: 'index' })]);
  assert.ok(!pages[0].error); assert.match(pages[1].error, /call budget/);
});

test('checkpoint failure blocks completion and unverifiable findings never enter the notebook', async () => {
  const r = new Research(snapshot, input(), limits, undefined, fetcher);
  await investigate(r);
  const result = await tool(r, 'research_notebook', { operation: 'save', id: 'invalid', finding: { ...finding(r), evidenceUrls: ['https://github.com/fake/fake'] } });
  assert.match(result.error, /not returned/);
  assert.deepEqual((r.checkpoint() as any).findings, {});
  r.setProgressWriter(async () => { throw new Error('disk unavailable'); });
  const save = await tool(r, 'research_notebook', { operation: 'save', id: 'environment', finding: finding(r) });
  assert.match(save.error, /checkpoint/);
  assert.throws(() => r.assertComplete(), /checkpoint/);
});

test('model limits bound instructions and tool fragments independently of total evidence', () => {
  const model = { capabilities: { limits: { max_context_window_tokens: 100000, max_prompt_tokens: 70000, max_output_tokens: 20000 } } } as ModelInfo;
  assert.equal(contextBudget(model, 'Instructions').chunkBytes, 7000);
  assert.throws(() => contextBudget(model, 'x'.repeat(60000)), /shorten the policy/);
  assert.equal(contextBudget(undefined, 'Instructions').chunkBytes, 12000);
});

test('Copilot composes from checkpoint tools after context loss with automatic compaction enabled', async () => {
  const r = new Research(snapshot, input(), limits, undefined, fetcher);
  let request = 0, stopped = false;
  const client = { start: async () => {}, listModels: async () => [], stop: async () => { stopped = true; }, forceStop: async () => {},
    createSession: async (options: any) => {
      assert.equal(options.infiniteSessions.enabled, true);
      assert.equal(options.enableSessionStore, false);
      assert.deepEqual(options.availableTools.sort(), ['custom:github_research', 'custom:release_evidence', 'custom:research_notebook']);
      return { on: () => {}, sendAndWait: async (message: any) => {
        request++;
        if (request === 1) {
          await investigate(r);
          await tool(r, 'research_notebook', { operation: 'save', id: 'environment', finding: finding(r) });
          return { data: { content: '{"complete":true}' } };
        }
        // No previous model messages are retained by this transport; reload host-owned findings.
        assert.match(message.prompt, /research_notebook/);
        assert.doesNotMatch(message.prompt, /VALIDATED FINDINGS:/);
        const report = await tool(r, 'research_notebook', { operation: 'read', id: 'environment' });
        const f = JSON.parse(report.content);
        return { data: { content: JSON.stringify({ entries: [{ category: 'features', summary: f.outcome, impact: '', sources: f.sources, upgradeNotes: [], needsReview: false }], excluded: [] }) } };
      } };
    } } as unknown as CopilotClient;
  const result: any = await new CopilotProvider(config.ai, 'test-credential', () => client).generate('Policy', {}, r);
  assert.equal(result.entries[0].summary, finding(r).outcome);
  assert.equal(request, 2); assert.equal(stopped, true);
});

test('prepare rejects a plausible answer when final diff coverage is incomplete', async t => {
  const f = await fixture(); t.after(f.close);
  const tree = f.github.trees.get(f.to)!;
  tree['release-assistant.yml'] = tree['release-assistant.yml']!.replace('provider: compatible', 'provider: copilot');
  await assert.rejects(prepare(f.options, { ...f, provider: { generate: async (_prompt, _schema, r) => {
    await tool(r!, 'release_evidence', { operation: 'index' });
    return { entries: [], excluded: [] };
  } } }), /unread frozen evidence/);
  assert.equal(f.github.pulls.length, 0);
  const artifact = JSON.parse(await readFile(join(f.options.outputDir, 'research.json'), 'utf8'));
  assert.equal(artifact.coverage[0].nextUnreadOffset, 0);
});

test('frozen file reads handle files beyond GitHub Contents inline limits and never follow working-tree changes or symlinks', async t => {
  const f = await fixture(); t.after(f.close);
  const content = 'frozen code\n'.repeat(100000);
  const sha = await f.commit('large.txt', content, 'add large source');
  await f.commit('large.txt', 'subsequent change', 'advance target');
  assert.equal(await f.git.file(sha, 'large.txt'), content);
  await symlink('large.txt', join(f.directory, 'link.txt'));
  f.run('add', 'link.txt'); f.run('commit', '-m', 'add symlink');
  await assert.rejects(f.git.file(f.run('rev-parse', 'HEAD'), 'link.txt'), /regular file/);
  const r = new Research({ ...snapshot, toSha: sha }, input(), limits, undefined,
    async () => { throw new Error('GitHub API must not be needed'); }, (ref, path) => f.git.file(ref, path));
  const result: any = await r.execute({ operation: 'file', repository: snapshot.repository, ref: sha, path: 'large.txt' });
  assert.ok(!result.error); assert.ok(result.nextOffset > 0);
  assert.match(result.content, /frozen code/);
  assert.equal(result.revision, sha);
});

test('large Copilot release runs through prepare and reruns into the same PR with the latest policy', async t => {
  const f = await fixture(); t.after(f.close);
  const next = await f.commit('large.txt', 'public API declaration\n'.repeat(20000), 'add public API');
  const tree = { ...f.github.trees.get(f.to)! };
  tree['release-assistant.yml'] = tree['release-assistant.yml']!.replace('provider: compatible', 'provider: copilot');
  f.github.trees.set(next, tree); f.github.refs.set('heads/main', next); f.github.refs.set('heads/release/v1.1', next);
  const options = { ...f.options, toRef: next };
  const provider = { generate: async (prompt: string, _schema: object, r?: Research) => {
    assert.ok(r); assert.ok(Buffer.byteLength(prompt) < 20000);
    const sources: string[] = [];
    for (const doc of r.evidence.coverage().filter(d => d.required)) {
      const content = await readAll(r, doc.id);
      if (doc.id.startsWith('source:')) sources.push(JSON.parse(content).id);
    }
    const policy = await readAll(r, 'policy');
    const summary = policy.includes('Updated') ? 'Adds APIs with updated release wording.' : 'Adds public APIs.';
    await tool(r, 'research_notebook', { operation: 'save', id: 'api', finding: {
      sources, userProblem: 'Public API access', implementation: 'Adds API declarations', outcome: summary,
      evidenceUrls: r.citationUrls(), limitations: [], needsReview: false,
    } });
    return { entries: [{ category: 'features', summary, impact: '', sources, upgradeNotes: [], needsReview: false }], excluded: [] };
  } };
  const first = await prepare(options, { ...f, provider });
  assert.ok(Buffer.byteLength(first.manifest.evidence.netDiff) > 160000);
  tree['policy.md'] = 'Updated policy';
  const second = await prepare(options, { ...f, provider });
  assert.equal(second.pull?.number, first.pull?.number); assert.equal(f.github.pulls.length, 1);
  assert.equal(second.manifest.snapshot.toSha, next);
  assert.match(second.pull!.body!, /updated release wording/);
  assert.notEqual(second.manifest.policyHash, first.manifest.policyHash);
});
