import { ApiError, GitHub } from './github.js';
import { GitSource } from './git.js';
import type { Change, Evidence, Pull, Snapshot } from './model.js';

export async function collect(git: GitSource, github: GitHub, snapshot: Snapshot, maxCommits: number): Promise<Evidence> {
  if (!await git.ancestor(snapshot.fromSha, snapshot.toSha)) throw new Error('Starting tag is not an ancestor of the ending ref');
  if (!await git.ancestor(snapshot.toSha, snapshot.targetSha)) throw new Error('Ending ref is outside the target branch history');
  const commits = await git.commits(snapshot.fromSha, snapshot.toSha, maxCommits);
  if (!commits.length) throw new Error('The selected range contains no commits');
  const groups = new Map<string, Change>();
  const warnings: string[] = [];
  for (const commit of commits) {
    // Only PRs actually merged into this branch describe the included change.
    const pulls = (await github.commitPulls(commit.sha)).filter(p => p.merged_at && p.base.ref === snapshot.targetBranch);
    const pull = pulls.find(p => p.merge_commit_sha === commit.sha) ?? (pulls.length === 1 ? pulls[0] : undefined);
    if (pulls.length > 1 && !pull) warnings.push(`Multiple associated PRs for ${commit.sha}; retain commit provenance`);
    const id = pull ? `pr:${pull.number}` : `commit:${commit.sha}`;
    let change = groups.get(id);
    if (!change) {
      change = { id, commits: [], pull, diff: '' };
      groups.set(id, change);
    }
    change.commits.push(commit);
  }
  for (const change of groups.values()) {
    const merge = change.commits.find(commit => commit.sha === change.pull?.merge_commit_sha && commit.parents.length > 1);
    const linear = change.commits.every((commit, index) => index === 0 || commit.parents[0] === change.commits[index - 1]!.sha);
    if (merge) change.diff = await git.commitDiff(merge);
    else if (linear && change.commits[0]!.parents[0]) change.diff = await git.diff(change.commits[0]!.parents[0]!, change.commits.at(-1)!.sha);
    else for (const commit of change.commits) change.diff += `\nCommit ${commit.sha}\n${await git.commitDiff(commit)}`;
    const text = [change.pull?.body ?? '', ...change.commits.map(c => c.message)].join('\n');
    // Recognize explicit backport provenance, never arbitrary issue references.
    const match = /(?:backport(?:\s+of)?|cherry[- ]pick(?:ed)?(?:\s+from)?|original\s+(?:pull\s+request|pr))\s*[:(]?\s*(?:#(\d+)|https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+))/i.exec(text);
    const number = match && (!match[2] || match[2] === snapshot.repository) ? Number(match[1] ?? match[3]) : undefined;
    if (number && number !== change.pull?.number) {
      try { change.originalPull = await github.pull(number); }
      catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; warnings.push(`Backport source PR #${number} is unavailable`); }
    } else {
      const picked = /cherry picked from commit ([a-f0-9]{40})/i.exec(text)?.[1];
      if (picked) {
        const originals: Pull[] = (await github.commitPulls(picked)).filter(p => p.merged_at && p.number !== change.pull?.number);
        if (originals.length === 1) change.originalPull = originals[0];
      }
    }
  }
  return { changes: [...groups.values()], netDiff: await git.diff(snapshot.fromSha, snapshot.toSha), warnings };
}
