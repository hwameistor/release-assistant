import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Commit } from './model.js';
const exec = promisify(execFile);

export class GitSource {
  constructor(readonly directory: string, private temporary = false, private authEnv: NodeJS.ProcessEnv = {}) {}
  static async clone(repository: string, token?: string): Promise<GitSource> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
    const directory = await mkdtemp(join(tmpdir(), 'release-assistant-git-'));
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: token ? `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` : '' };
    const source = new GitSource(directory, true, env);
    try {
      await exec('git', ['clone', '--bare', '--filter=blob:none', `https://github.com/${repository}.git`, directory], { env, timeout: 300000, maxBuffer: 1000000 });
      return source;
    } catch { await source.close(); throw new Error('Unable to clone source repository; check repository access'); }
  }
  async git(args: string[]): Promise<string> {
    return (await exec('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: this.directory, timeout: 120000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...this.authEnv, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' },
    })).stdout;
  }
  async ancestor(from: string, to: string): Promise<boolean> {
    try { await this.git(['merge-base', '--is-ancestor', from, to]); return true; }
    catch (error) { if ((error as { code?: number }).code === 1) return false; throw error; }
  }
  async commits(from: string, to: string, limit: number): Promise<Commit[]> {
    const shas = (await this.git(['rev-list', '--reverse', '--topo-order', `${from}..${to}`])).trim().split('\n').filter(Boolean);
    if (shas.length > limit) throw new Error(`Range has ${shas.length} commits, exceeding maxCommits=${limit}; narrow the range or explicitly raise the limit`);
    const commits: Commit[] = [];
    for (const sha of shas) {
      const [parents = '', subject = '', message = ''] = (await this.git(['show', '-s', '--format=%P%x00%s%x00%B', sha])).split('\0');
      commits.push({ sha, parents: parents.split(' ').filter(Boolean), subject, message: message.trim() });
    }
    return commits;
  }
  async diff(from: string, to: string): Promise<string> {
    return this.git(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', from, to, '--']);
  }
  async commitDiff(commit: Commit): Promise<string> {
    return commit.parents[0] ? this.diff(commit.parents[0], commit.sha) : this.git(['show', '--format=', '--no-ext-diff', '--no-textconv', commit.sha, '--']);
  }
  async close(): Promise<void> { if (this.temporary) await rm(this.directory, { recursive: true, force: true }); }
}
