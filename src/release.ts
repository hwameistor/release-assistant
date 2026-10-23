import semver from 'semver';
import { parse } from 'yaml';
import { ApiError, GitHub } from './github.js';
import { safePath } from './config.js';
import { hash, manifestPath, normalizeVersion } from './prepare.js';

export function releaseFlags(version: string, latest: string | null): { prerelease: boolean; makeLatest: boolean } {
  const prerelease = semver.prerelease(version) !== null;
  return { prerelease, makeLatest: !prerelease && (latest === null || Boolean(semver.valid(latest) && semver.gte(version, latest))) };
}

export async function releaseBody(github: GitHub, options: { version?: string; sourceRef?: string; chartPath?: string; notesPath: string }) {
  if (!options.sourceRef && !options.version) throw new Error('release-body requires --version or --source-ref with --chart-path');
  const sha = options.sourceRef ? await github.resolve(options.sourceRef) : await github.requiredRef('tags', normalizeVersion(options.version!));
  const chart = options.chartPath ? parse(await github.requiredFile(safePath(options.chartPath), sha)) : undefined;
  const version = normalizeVersion(options.version ?? chart?.version ?? '');
  if (chart && (chart.version !== version || chart.appVersion !== version)) throw new Error('Chart version/appVersion do not match the requested release');
  const path = safePath(options.notesPath.replaceAll('{version}', version));
  const content = await github.requiredFile(path, sha);
  if (!content.trim()) throw new Error('Reviewed release notes are empty');
  if (options.sourceRef) {
    // Newly generated releases must publish the reviewed file, never a regenerated body.
    const manifest = JSON.parse(await github.requiredFile(manifestPath, sha));
    if (manifest.snapshot?.repository !== github.repository || manifest.snapshot?.version !== version || manifest.files?.[path] !== hash(content)) {
      throw new Error('Release notes do not match the reviewed release manifest');
    }
  }
  let latest: string | null = null;
  try { latest = (await github.request<{ tag_name: string }>('GET', `${github.root}/releases/latest`)).tag_name; }
  catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
  return { sha, version, content, ...releaseFlags(version, latest) };
}
