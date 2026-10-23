import semver from 'semver';
import type { GitSource } from './git.js';
import type { RecentTagChoice, TagCandidate } from './model.js';

export async function recentTags(git: GitSource, toSha: string, version: string): Promise<TagCandidate[]> {
  if (!/^[a-f0-9]{40}$/i.test(toSha) || !semver.valid(version)) throw new Error('Invalid tag discovery range');
  const names = (await git.git(['for-each-ref', `--merged=${toSha}`, '--format=%(refname:strip=2)', 'refs/tags']))
    .trim().split('\n').filter(name => /^v?\d/.test(name) && semver.valid(name) && semver.lt(name, version))
    .sort((a, b) => semver.rcompare(a, b) || a.localeCompare(b)).slice(0, 3);
  return Promise.all(names.map(async name => ({
    name, sha: (await git.git(['rev-parse', '--verify', `refs/tags/${name}^{commit}`])).trim(),
  })));
}

export function chooseTag(candidates: TagCandidate[], choice: RecentTagChoice): TagCandidate {
  const index = { latest: 0, 'second-latest': 1, 'third-latest': 2 }[choice];
  const selected = candidates[index];
  if (!selected) throw new Error(`Cannot select ${choice}: found ${candidates.length} eligible tags (${candidates.map(tag => tag.name).join(', ') || 'none'}). Choose an available rank or enter from-tag manually`);
  return selected;
}
