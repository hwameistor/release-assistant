import type { Pull } from './model.js';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function pullContext(pull: Pull): Pull {
  return { number: pull.number, title: pull.title, body: pull.body, html_url: pull.html_url, state: pull.state,
    merged_at: pull.merged_at, merge_commit_sha: pull.merge_commit_sha, base: { ref: pull.base.ref },
    head: { ref: pull.head.ref, repo: pull.head.repo ? { full_name: pull.head.repo.full_name } : null } };
}
export class GitHub {
  readonly root: string;
  constructor(readonly repository: string, private token?: string, private apiUrl = 'https://api.github.com') {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Repository must be owner/name');
    this.root = `/repos/${repository}`;
  }
  async request<T>(method: string, path: string, data?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.apiUrl}${path}`, {
        method, signal: AbortSignal.timeout(60000),
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      if (method === 'GET' && [429, 502, 503, 504].includes(res.status) && attempt < 2) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue;
      }
      if (!res.ok) throw new ApiError(res.status, `GitHub ${method} ${path} failed (${res.status})`);
      if (res.status === 204) return undefined as T;
      return await res.json() as T;
    }
  }
  async pages<T>(path: string): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const items = await this.request<T[]>('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      result.push(...items);
      if (items.length < 100) return result;
    }
    throw new Error(`Pagination exceeded 100 pages: ${path}`);
  }
  async ref(kind: 'heads' | 'tags', name: string): Promise<string | null> {
    try {
      let object = (await this.request<{ object: { sha: string; type: string } }>('GET', `${this.root}/git/ref/${kind}/${encodeURIComponent(name)}`)).object;
      for (let i = 0; object.type === 'tag' && i < 8; i++) {
        object = (await this.request<{ object: { sha: string; type: string } }>('GET', `${this.root}/git/tags/${object.sha}`)).object;
      }
      if (object.type !== 'commit') throw new Error('Reference does not resolve to a commit');
      return object.sha;
    } catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
  }
  async resolve(ref: string): Promise<string> {
    if (/^[a-f0-9]{40}$/i.test(ref)) return (await this.request<{ sha: string }>('GET', `${this.root}/commits/${ref}`)).sha;
    if (ref.startsWith('refs/heads/')) return this.requiredRef('heads', ref.slice(11));
    if (ref.startsWith('refs/tags/')) return this.requiredRef('tags', ref.slice(10));
    const [branch, tag] = await Promise.all([this.ref('heads', ref), this.ref('tags', ref)]);
    if (branch && tag) throw new Error(`Ambiguous ref ${ref}: use refs/heads/ or refs/tags/`);
    if (!branch && !tag) throw new Error(`Reference not found: ${ref}`);
    return (branch || tag)!;
  }
  async requiredRef(kind: 'heads' | 'tags', name: string): Promise<string> {
    const sha = await this.ref(kind, name);
    if (!sha) throw new Error(`${kind}/${name} does not exist`);
    return sha;
  }
  async file(path: string, ref: string): Promise<string | null> {
    try {
      const data = await this.request<{ encoding: string; content: string }>('GET', `${this.root}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
      if (data.encoding !== 'base64') throw new Error(`File is not a supported text blob: ${path}`);
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
  }
  async requiredFile(path: string, ref: string): Promise<string> {
    const file = await this.file(path, ref);
    if (file === null) throw new Error(`Missing ${path} at ${ref}`);
    return file;
  }
  async defaultBranch(): Promise<string> { return (await this.request<{ default_branch: string }>('GET', this.root)).default_branch; }
  async commitPulls(sha: string): Promise<Pull[]> { return (await this.pages<Pull>(`${this.root}/commits/${sha}/pulls`)).map(pullContext); }
  async pull(number: number): Promise<Pull> { return pullContext(await this.request('GET', `${this.root}/pulls/${number}`)); }
  async findPull(branch: string, base: string): Promise<Pull | undefined> {
    const pulls = await this.pages<Pull>(`${this.root}/pulls?state=all&head=${encodeURIComponent(`${this.repository.split('/')[0]}:${branch}`)}&base=${encodeURIComponent(base)}`);
    const matching = pulls.filter(p => p.head.repo?.full_name === this.repository && p.head.ref === branch && p.base.ref === base);
    if (matching.length > 1) throw new Error('Multiple Release PRs match this identity; resolve duplicates first');
    return matching[0] ? pullContext(matching[0]) : undefined;
  }
  async changedPaths(from: string, to: string): Promise<string[]> {
    const data = await this.request<{ files?: { filename: string; previous_filename?: string }[] }>('GET', `${this.root}/compare/${from}...${to}?per_page=1`);
    if (!data.files || data.files.length >= 300) throw new Error('Cannot verify release branch changes: comparison is missing or exceeds the API file limit');
    return data.files.flatMap(file => file.previous_filename ? [file.filename, file.previous_filename] : [file.filename]);
  }
  async writeCommit(parent: string, files: Record<string, string | null>, message: string, treeBase = parent, extraParents: string[] = []): Promise<string> {
    const commit = await this.request<{ tree: { sha: string } }>('GET', `${this.root}/git/commits/${treeBase}`);
    const tree = await this.request<{ sha: string }>('POST', `${this.root}/git/trees`, {
      base_tree: commit.tree.sha,
      tree: Object.entries(files).map(([path, content]) => content === null
        ? { path, mode: '100644', type: 'blob', sha: null }
        : { path, mode: '100644', type: 'blob', content }),
    });
    const author = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };
    return (await this.request<{ sha: string }>('POST', `${this.root}/git/commits`, {
      message: `${message}\n\nSigned-off-by: ${author.name} <${author.email}>`, parents: [...new Set([parent, ...extraParents])], tree: tree.sha, author, committer: author,
    })).sha;
  }
  async createRef(branch: string, sha: string): Promise<void> {
    await this.request('POST', `${this.root}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }
  async advanceRef(branch: string, expected: string, sha: string): Promise<void> {
    if (await this.ref('heads', branch) !== expected) throw new Error('Release branch changed concurrently; rerun the workflow');
    await this.request('PATCH', `${this.root}/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: false });
  }
  async upsertPull(existing: Pull | undefined, branch: string, base: string, title: string, body: string): Promise<Pull> {
    if (existing) {
      const current = await this.pull(existing.number);
      if (current.state !== 'open' || current.merged_at) throw new Error('Release PR was closed or merged during generation');
      return this.request('PATCH', `${this.root}/pulls/${existing.number}`, { title, body });
    }
    return this.request('POST', `${this.root}/pulls`, { title, body, head: branch, base, draft: true, maintainer_can_modify: true });
  }
}
