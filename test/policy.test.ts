import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, policyReference } from '../src/config.js';
import { loadPolicy } from '../src/policy.js';
import { prepare, hash, manifestPath } from '../src/prepare.js';
import { validateRelease } from '../src/validate.js';
import { fixture } from './helpers.js';

test('policy references support optional defaults, local files and public HTTPS without credential-bearing URLs', () => {
  const config = 'schemaVersion: 1\nai: {model: example}\n';
  assert.equal(loadConfig(config).policy, undefined);
  assert.equal(loadConfig(config + 'policy: https://github.com/example/rules/blob/main/policy.md\n').policy,
    'https://github.com/example/rules/blob/main/policy.md');
  assert.equal(policyReference(' .release-assistant/policy.md '), '.release-assistant/policy.md');
  assert.equal(policyReference('https://github.com/example/rules/blob/main/policy.md#L10'), 'https://github.com/example/rules/blob/main/policy.md');
  for (const value of ['../policy.md', 'file:///tmp/policy.md', 'http://example.com/policy.md',
    'https://user:password@example.com/policy.md', 'https://example.com/policy.md?token=secret', 'policy\n.md']) {
    assert.throws(() => policyReference(value));
  }
});

test('GitHub blob/raw URLs with slash refs resolve once and read the immutable commit without sending credentials', async t => {
  const f = await fixture(); t.after(f.close);
  const sha = 'a'.repeat(40);
  for (const reference of ['https://github.com/example/rules/blob/release/v1.1/policy.md',
    'https://raw.githubusercontent.com/example/rules/release%2Fv1.1/policy.md',
    'https://raw.githubusercontent.com/example/rules/refs/heads/release/v1.1/policy.md']) {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input); requests.push(url);
      const headers = new Headers(init?.headers);
      assert.equal(headers.has('authorization'), false);
      assert.equal(headers.has('cookie'), false);
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal);
      if (url === `https://raw.githubusercontent.com/example/rules/${sha}/policy.md`) return new Response('Policy at pinned revision.');
      assert.equal(headers.get('accept'), 'application/vnd.github.sha');
      const ref = decodeURIComponent(url.split('/commits/')[1]!);
      return ['release/v1.1', 'refs/heads/release/v1.1'].includes(ref) ? new Response(sha) : new Response('', { status: 404 });
    };
    const result = await loadPolicy(reference, { github: f.github, configSha: f.to, fetcher });
    assert.equal(result.text, 'Policy at pinned revision.');
    assert.deepEqual(result.source, { kind: 'github', location: reference, sha });
    assert.equal(requests.at(-1), `https://raw.githubusercontent.com/example/rules/${sha}/policy.md`);
  }
});

test('external policy failures, HTML, invalid text and oversized streams fail instead of falling back', async t => {
  const f = await fixture(); t.after(f.close);
  const context = { github: f.github, configSha: f.to };
  const url = 'https://docs.example/policy.md';
  const result = await loadPolicy(url, { ...context, fetcher: async () => new Response('# Shared policy\nExplain user impact.') });
  assert.deepEqual(result.source, { kind: 'https', location: url });
  const cases: Array<[() => Response, RegExp]> = [
    [() => new Response('Not found', { status: 404 }), /HTTP 404/],
    [() => new Response('Moved', { status: 302 }), /HTTP 302/],
    [() => new Response('<h1>Sign in</h1>', { headers: { 'content-type': 'text/html' } }), /HTML/],
    [() => new Response('<!doctype html><html>Sign in</html>'), /HTML/],
    [() => new Response('  \n '), /nonempty/],
    [() => new Response(new Uint8Array([0xff, 0xfe])), /UTF-8/],
    [() => new Response('text', { headers: { 'content-length': String(129 * 1024) } }), /128 KiB/],
    [() => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(100 * 1024)); controller.enqueue(new Uint8Array(30 * 1024)); controller.close();
    } })), /128 KiB/],
  ];
  for (const [response, error] of cases) {
    await assert.rejects(loadPolicy(url, { ...context, fetcher: async () => response() }), error);
  }
  await assert.rejects(loadPolicy(url, { ...context, fetcher: async () => { throw new Error('redirect or timeout'); } }), /Unable to fetch/);
  await assert.rejects(prepare({ ...f.options, changelogPolicy: url }, { ...f, policyFetch: async () => new Response('', { status: 404 }) }), /HTTP 404/);
  assert.equal(f.github.inferenceCalls, 0); assert.equal(f.github.writes, 0);
});

test('a slash branch is not shadowed by a shorter tag with a different policy', async t => {
  const f = await fixture(); t.after(f.close);
  const branchSha = 'c'.repeat(40), tagSha = 'd'.repeat(40);
  const result = await loadPolicy('https://github.com/example/rules/blob/main/shared/policy.md', {
    github: f.github, configSha: f.to, fetcher: async input => {
      const url = String(input);
      if (url.endsWith('/commits/main%2Fshared')) return new Response(branchSha);
      if (url.endsWith('/commits/main')) return new Response(tagSha);
      assert.equal(url, `https://raw.githubusercontent.com/example/rules/${branchSha}/policy.md`);
      return new Response('The intended branch policy.');
    },
  });
  assert.equal(result.source.sha, branchSha);
  assert.equal(result.text, 'The intended branch policy.');
});

test('rerun uses updated external policy with the same release snapshot/PR and preserves installed-validator compatibility', async t => {
  const f = await fixture(); t.after(f.close);
  const url = 'https://github.com/example/rules/blob/main/changelog-policy.md';
  const tree = f.github.trees.get(f.to)!;
  tree['release-assistant.yml'] = tree['release-assistant.yml']!.replace('policy: policy.md', `policy: ${url}`);
  let revision = 'a'.repeat(40), text = 'Policy revision one: describe the original user problem.';
  const prompts: string[] = [];
  const dependencies = { ...f, policyFetch: (async (input: RequestInfo | URL) => {
    if (String(input).startsWith('https://api.github.com/')) return new Response(revision);
    assert.equal(String(input), `https://raw.githubusercontent.com/example/rules/${revision}/changelog-policy.md`);
    return new Response(text);
  }) as typeof fetch, provider: { generate: async (prompt: string) => {
    prompts.push(prompt); return f.provider.generate(prompt);
  } } };
  const first = await prepare(f.options, dependencies);
  const firstHead = await f.github.requiredRef('heads', first.branch);
  revision = 'b'.repeat(40); text = 'Policy revision two: explain the practical benefit.';
  const second = await prepare({ ...f.options, changelogPolicy: '' }, dependencies);
  const secondHead = await f.github.requiredRef('heads', second.branch);
  assert.equal(second.pull?.number, first.pull?.number);
  assert.equal(f.github.pulls.length, 1);
  assert.deepEqual(second.manifest.snapshot, first.manifest.snapshot);
  assert.deepEqual(f.github.parents.get(secondHead), [firstHead]);
  assert.equal(second.manifest.policySource.sha, revision);
  assert.equal(second.manifest.policyHash, hash(text));
  assert.notEqual(second.manifest.policyHash, first.manifest.policyHash);
  assert.ok(prompts[0]?.includes('Policy revision one')); assert.ok(prompts[1]?.includes(text));
  assert.equal(await readFile(join(f.options.outputDir, 'policy.md'), 'utf8'), text);
  const source = JSON.parse(await readFile(join(f.options.outputDir, 'policy-source.json'), 'utf8'));
  assert.deepEqual(source, { kind: 'github', location: url, sha: revision, sha256: hash(text) });
  assert.ok(second.pull?.body?.includes(url)); assert.ok(second.pull?.body?.includes(revision));
  const stored = JSON.parse(await f.github.requiredFile(manifestPath, secondHead));
  assert.equal(stored.policyHash, hash(text)); assert.equal('policySource' in stored, false);
  await validateRelease(f.github, second.branch, f.options.targetBranch);
  const third = await prepare({ ...f.options, changelogPolicy: 'policy.md' }, dependencies);
  assert.equal(third.pull?.number, first.pull?.number);
  assert.ok(prompts[2]?.includes('Explain code changes.'));
  assert.equal(third.manifest.policySource.kind, 'repository');
  const bundled = await loadPolicy(undefined, { github: f.github, configSha: f.to });
  assert.equal(bundled.source.kind, 'bundled'); assert.ok(bundled.text.includes('Changelog policy'));
});
