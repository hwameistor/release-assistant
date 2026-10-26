import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { fixture } from './helpers.js';
import { hash, manifestPath, prepare } from '../src/prepare.js';
import { validateRelease } from '../src/validate.js';
import { loadConfig, outputPaths } from '../src/config.js';
import { updateVersionFile } from '../src/version-files.js';

const file = { path: 'values.yaml', fields: ['operator.tag'] };
const values = `# Image versions for relocation
global:
  hwameistorVersion: v1.1.1
operator:
  imageRepository: hwameistor/operator
  tag: "v1.1.1" # Explicit image tag
localStorage:
  member:
    tag: v1.1.1
  migrate:
    juicesync:
      tag: v1.2.0
      version: "1.4.1"
`;
function configure(tree: Record<string, string>) {
  tree['release-assistant.yml'] += '  versionFiles:\n    - path: values.yaml\n      fields: [operator.tag]\n';
}

test('release generation synchronizes the explicit Operator tag for stable and prerelease versions', async t => {
  for (const version of ['v1.1.2-alpha1', 'v1.1.2']) {
    const f = await fixture(); t.after(f.close);
    const tree = f.github.trees.get(f.to)!;
    tree[file.path] = values; configure(tree);
    const result = await prepare({ ...f.options, version }, f);
    const head = await f.github.requiredRef('heads', result.branch);
    const rendered = await f.github.requiredFile(file.path, head);
    assert.deepEqual(parse(rendered), { ...parse(values), operator: { imageRepository: 'hwameistor/operator', tag: version } });
    assert.match(rendered, /# Image versions for relocation/);
    assert.ok(rendered.includes(`tag: "${version}" # Explicit image tag`));
    assert.equal(parse(await f.github.requiredFile('Chart.yaml', head)).version, version);
    const manifest = JSON.parse(await f.github.requiredFile(manifestPath, head));
    assert.equal(manifest.files[file.path], hash(rendered));
    assert.deepEqual(manifest.snapshot.versionFiles, [file]);
    await validateRelease(f.github, result.branch, f.options.targetBranch);
    // File hashes alone cannot prove that the selected image matches the release.
    f.github.trees.get(head)![file.path] = rendered.replace(`"${version}"`, '"v0.9.0"');
    await assert.rejects(validateRelease(f.github, result.branch, f.options.targetBranch), /changed after validation/);
    manifest.files[file.path] = hash(f.github.trees.get(head)![file.path]!);
    f.github.trees.get(head)![manifestPath] = JSON.stringify(manifest);
    await assert.rejects(validateRelease(f.github, result.branch, f.options.targetBranch), /Release version mismatch: values.yaml:operator.tag/);
  }
});

test('an existing release PR adopts the new version file on rerun without changing its source range or identity', async t => {
  const f = await fixture(); t.after(f.close);
  f.github.trees.get(f.to)![file.path] = values;
  const first = await prepare(f.options, f);
  const templateSha = 'e'.repeat(40);
  const latestConfig = { ...f.github.trees.get(f.to)! };
  configure(latestConfig); f.github.trees.set(templateSha, latestConfig); f.github.refs.set('heads/main', templateSha);
  for (let i = 0; i < 2; i++) {
    const rerun = await prepare(f.options, f);
    assert.equal(rerun.pull?.number, first.pull?.number);
    assert.equal(rerun.manifest.snapshot.toSha, f.to);
    assert.equal(f.github.pulls.length, 1);
    await validateRelease(f.github, rerun.branch, f.options.targetBranch);
  }
  // Previously generated paths cannot be removed while keeping the old range.
  f.github.trees.get(templateSha)!['release-assistant.yml'] = f.github.trees.get(f.to)!['release-assistant.yml']!;
  await assert.rejects(prepare(f.options, f), /Output paths changed/);
});

test('adopting a version file does not discard pre-existing manual PR edits', async t => {
  const f = await fixture(); t.after(f.close);
  f.github.trees.get(f.to)![file.path] = values;
  const first = await prepare(f.options, f);
  const head = await f.github.requiredRef('heads', first.branch);
  f.github.trees.get(head)![file.path] += '# user edit\n';
  configure(f.github.trees.get(f.to)!);
  const calls = f.github.inferenceCalls, writes = f.github.writes;
  await assert.rejects(prepare(f.options, f), /New version file has existing PR edits/);
  assert.equal(f.github.inferenceCalls, calls); assert.equal(f.github.writes, writes);
});

test('missing or invalid version fields fail before inference and publication', async t => {
  for (const content of [undefined, 'operator: {}\n', 'operator:\n  tag: 123\n', 'operator: [\n']) {
    const f = await fixture(); t.after(f.close);
    const tree = f.github.trees.get(f.to)!; configure(tree);
    if (content !== undefined) tree[file.path] = content;
    await assert.rejects(prepare(f.options, f), /Missing values.yaml|existing unanchored string|Invalid version-file YAML/);
    assert.equal(f.github.inferenceCalls, 0); assert.equal(f.github.writes, 0); assert.equal(f.github.pulls.length, 0);
  }
});

test('version fields do not modify shared YAML anchors or accept unsafe or colliding output paths', () => {
  for (const content of ['operator:\n  tag: &shared v1.1.1\nother: *shared\n',
    'operator: &shared\n  tag: v1.1.1\nother: *shared\n', 'defaults: &shared\n  tag: v1.1.1\noperator: *shared\n']) {
    assert.throws(() => updateVersionFile(content, file, 'v1.1.2'), /unanchored string|plain mappings/);
  }
  assert.match(updateVersionFile('operator:\n  tag: ""\n', file, 'v1.1.2'), /v1.1.2/);
  for (const path of ['../values.yaml', '.github/workflows/release.yml', 'Chart.yaml', '.release-assistant/snapshot.json']) {
    const config = loadConfig(`schemaVersion: 1\nai: {model: test}\noutput:\n  charts: [Chart.yaml]\n  versionFiles:\n    - path: ${path}\n      fields: [operator.tag]\n`);
    assert.throws(() => outputPaths(config, 'v1.1.2'), /Unsafe|unique/);
  }
  assert.throws(() => loadConfig('schemaVersion: 1\nai: {model: test}\noutput:\n  versionFiles: [{path: values.yaml, fields: []}]'));
});
