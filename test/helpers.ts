import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitHub } from '../src/github.js';
import { GitSource } from '../src/git.js';
import type { GenerateOptions, Pull } from '../src/model.js';

export class FakeGitHub extends GitHub {
  refs = new Map<string, string>();
  trees = new Map<string, Record<string, string>>();
  parents = new Map<string, string[]>();
  pulls: Pull[] = [];
  associated = new Map<string, Pull[]>();
  writes = 0;
  inferenceCalls = 0;
  failCreate = false;
  constructor() { super('example/storage'); }
  override async ref(kind: 'heads' | 'tags', name: string) { return this.refs.get(`${kind}/${name}`) ?? null; }
  override async resolve(ref: string) {
    if (this.trees.has(ref)) return ref;
    return super.resolve(ref);
  }
  override async file(path: string, ref: string) { return this.trees.get(ref)?.[path] ?? null; }
  override async defaultBranch() { return 'main'; }
  override async commitPulls(sha: string) { return this.associated.get(sha) ?? []; }
  override async pull(number: number) {
    const result = this.pulls.find(p => p.number === number);
    if (!result) throw new Error(`Missing PR ${number}`);
    return result;
  }
  override async findPull(branch: string, base: string) { return this.pulls.find(p => p.head.ref === branch && p.base.ref === base); }
  override async changedPaths(from: string, to: string) {
    const left = this.trees.get(from) ?? {}, right = this.trees.get(to) ?? {};
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(path => left[path] !== right[path]);
  }
  override async writeCommit(parent: string, files: Record<string, string | null>, _message: string, treeBase = parent, extraParents: string[] = []) {
    const sha = (++this.writes).toString(16).padStart(40, '0');
    const tree = { ...this.trees.get(treeBase) };
    for (const [path, value] of Object.entries(files)) if (value === null) delete tree[path]; else tree[path] = value;
    this.trees.set(sha, tree); this.parents.set(sha, [parent, ...extraParents]);
    return sha;
  }
  override async createRef(branch: string, sha: string) {
    if (await this.ref('heads', branch)) throw new Error('Ref already exists');
    this.refs.set(`heads/${branch}`, sha);
  }
  override async advanceRef(branch: string, expected: string, sha: string) {
    if (await this.ref('heads', branch) !== expected) throw new Error('Release branch changed concurrently');
    this.refs.set(`heads/${branch}`, sha);
  }
  override async upsertPull(existing: Pull | undefined, branch: string, base: string, title: string, body: string) {
    if (this.failCreate) { this.failCreate = false; throw new Error('Simulated PR creation failure'); }
    if (existing) { Object.assign(existing, { title, body }); return existing; }
    const pull: Pull = { number: 100, title, body, html_url: 'https://github.com/example/storage/pull/100',
      state: 'open', merged_at: null, merge_commit_sha: null, base: { ref: base }, head: { ref: branch, repo: { full_name: this.repository } } };
    this.pulls.push(pull); return pull;
  }
}

export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'release-assistant-test-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  run('init', '-b', 'release/v1.1'); run('config', 'user.name', 'Test'); run('config', 'user.email', 'test@example.invalid');
  const commit = async (file: string, content: string, message: string) => {
    await writeFile(join(directory, file), content); run('add', '--', file); run('commit', '-m', message); return run('rev-parse', 'HEAD');
  };
  const from = await commit('file.txt', 'before\n', 'initial'); run('tag', 'v1.1.1');
  const to = await commit('file.txt', 'after\n', 'Fix file handling');
  const github = new FakeGitHub();
  const config = `schemaVersion: 1\npolicy: policy.md\ntemplate: template.md\nai:\n  provider: compatible\n  model: fixture-model\n  baseUrl: https://model.example/v1\noutput:\n  charts: [Chart.yaml]\n`;
  const tree = { 'file.txt': 'after\n', 'release-assistant.yml': config, 'policy.md': 'Explain code changes.',
    'template.md': '## {{version}}\n\n{{sections}}\n\n{{upgrade_notes}}\n\n{{compare_link}}',
    'Chart.yaml': 'version: v1.1.1\nappVersion: v1.1.1\ndependencies:\n  - name: juice\n    version: v1.2.0\n', 'CHANGELOG.md': '# Changelog\n\nOld notes\n' };
  github.trees.set(from, { ...tree, 'file.txt': 'before\n' }); github.trees.set(to, tree);
  github.refs.set('tags/v1.1.1', from); github.refs.set('heads/release/v1.1', to); github.refs.set('heads/main', to);
  const options: GenerateOptions = { repository: github.repository, targetBranch: 'release/v1.1', version: 'v1.1.2-alpha1',
    fromTag: 'v1.1.1', toRef: 'refs/heads/release/v1.1', configPath: 'release-assistant.yml', outputDir: join(directory, 'output'), publish: true };
  const provider = { generate: async (prompt: string) => {
    github.inferenceCalls++;
    const evidence = JSON.parse(prompt.split('EVIDENCE:\n')[1]!);
    return { entries: evidence.changes.map((change: { id: string }) => ({ category: 'fixes', summary: `Correct file handling ${github.inferenceCalls}.`,
      impact: 'Users receive the updated file.', sources: [change.id], upgradeNotes: [], needsReview: false })), excluded: [] };
  } };
  return { directory, run, commit, from, to, github, options, provider, git: new GitSource(directory), close: () => rm(directory, { recursive: true, force: true }) };
}
