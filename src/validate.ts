import { parse } from 'yaml';
import { z } from 'zod';
import { GitHub } from './github.js';
import { safePath } from './config.js';
import { hash, manifestPath, normalizeVersion, releaseBranch, statePath } from './prepare.js';
import { notesSchema, snapshotSchema } from './model.js';
import { validateNotes } from './render.js';
import { validateVersionFile } from './version-files.js';

const storedManifest = z.object({
  snapshot: snapshotSchema, templateSha: z.string().regex(/^[a-f0-9]{40}$/), generatedAt: z.string(),
  policyHash: z.string(), templateHash: z.string(), provider: z.string(), model: z.string(), notes: notesSchema,
  sources: z.array(z.string()), files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
}).strict();

export async function validateRelease(github: GitHub, headRef: string, targetBranch: string): Promise<void> {
  const head = await github.resolve(headRef);
  const snapshot = snapshotSchema.parse(JSON.parse(await github.requiredFile(statePath, head)));
  if (snapshot.repository !== github.repository || snapshot.targetBranch !== targetBranch) throw new Error('Release identity does not match this repository/target branch');
  if (normalizeVersion(snapshot.version) !== snapshot.version) throw new Error('Noncanonical version in release snapshot');
  const expectedBranch = releaseBranch(github.repository, targetBranch, snapshot.version);
  if (headRef.replace(/^refs\/heads\//, '') !== expectedBranch) throw new Error('Validation must use the generated release branch');
  if (await github.requiredRef('heads', targetBranch) !== snapshot.targetSha || snapshot.toSha !== snapshot.targetSha) throw new Error('Release range is stale; regenerate with an explicit new to-ref SHA');
  if (await github.ref('tags', snapshot.version) || await github.ref('tags', snapshot.version.slice(1))) throw new Error('Release tag already exists');
  const manifest = storedManifest.parse(JSON.parse(await github.requiredFile(manifestPath, head)));
  if (JSON.stringify(manifest.snapshot) !== JSON.stringify(snapshot)) throw new Error('Manifest and snapshot differ');
  validateNotes(manifest.notes, { changes: manifest.sources.map(id => ({ id, commits: [], diff: '' })), netDiff: '', warnings: [] });
  if (JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...snapshot.generatedPaths].sort())) throw new Error('Generated files do not match snapshot');
  const allowed = new Set([...snapshot.generatedPaths, statePath, manifestPath]);
  if ((await github.changedPaths(snapshot.targetSha, head)).some(path => !allowed.has(path))) throw new Error('Release PR contains changes outside generated files');
  for (const [path, expected] of Object.entries(manifest.files)) {
    const content = await github.requiredFile(safePath(path), head);
    if (hash(content) !== expected) throw new Error(`Generated file changed after validation: ${path}. Rerun generation to replace manual edits`);
  }
  const versionPaths = new Set((snapshot.versionFiles ?? []).map(file => file.path));
  if (versionPaths.size !== (snapshot.versionFiles ?? []).length
      || [...versionPaths].some(path => !snapshot.generatedPaths.slice(2).includes(path))) {
    throw new Error('Version files must be unique generated files');
  }
  for (const path of snapshot.generatedPaths.slice(2).filter(path => !versionPaths.has(path))) {
    const chart = parse(await github.requiredFile(path, head));
    if (chart?.version !== snapshot.version || chart?.appVersion !== snapshot.version) throw new Error(`Chart version mismatch: ${path}`);
  }
  for (const file of snapshot.versionFiles ?? []) {
    validateVersionFile(await github.requiredFile(safePath(file.path), head), file, snapshot.version);
  }
}
