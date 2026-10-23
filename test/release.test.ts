import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseBody, releaseFlags } from '../src/release.js';
import { fixture } from './helpers.js';
import { prepare } from '../src/prepare.js';
import { ApiError } from '../src/github.js';

test('prereleases and older stable maintenance releases never replace latest stable', () => {
  assert.deepEqual(releaseFlags('v1.1.2-alpha1', null), { prerelease: true, makeLatest: false });
  assert.deepEqual(releaseFlags('v1.0.3', 'v1.1.1'), { prerelease: false, makeLatest: false });
  assert.deepEqual(releaseFlags('v1.1.2', 'v1.1.1'), { prerelease: false, makeLatest: true });
  assert.deepEqual(releaseFlags('v1.1.2', 'unrecognized-tag'), { prerelease: false, makeLatest: false });
});

test('initial publication reads exact reviewed notes and chart at the specified source, without model or writes', async t => {
  const f = await fixture(); t.after(f.close);
  const generated = await prepare(f.options, f);
  const sourceRef = await f.github.requiredRef('heads', generated.branch);
  f.github.request = async () => { throw new ApiError(404, 'no latest release'); };
  const writes = f.github.writes;
  const options = { sourceRef, chartPath: 'Chart.yaml', notesPath: 'changelogs/released/{version}/changelog' };
  const release = await releaseBody(f.github, options);
  assert.equal(release.version, f.options.version); assert.equal(release.sha, sourceRef); assert.equal(release.prerelease, true);
  assert.equal(f.github.writes, writes); assert.equal(f.github.inferenceCalls, 1);
  f.github.trees.get(sourceRef)!['changelogs/released/v1.1.2-alpha1/changelog'] = 'unreviewed notes';
  await assert.rejects(releaseBody(f.github, options), /reviewed release manifest/);
});
