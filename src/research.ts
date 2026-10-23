import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import type { Tool } from '@github/copilot-sdk';
import type { Evidence, Snapshot } from './model.js';

const repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const sha = /^[a-f0-9]{40}$/i;
export const researchLimitsSchema = z.object({
  maxCalls: z.number().int().min(1).max(1000).default(80),
  maxBytes: z.number().int().min(10000).max(4000000).default(512000),
  maxDepth: z.number().int().min(0).max(5).default(2),
});
export type ResearchLimits = z.infer<typeof researchLimitsSchema>;
const argsSchema = z.object({
  operation: z.enum(['issue', 'issue_comments', 'pull_request', 'pull_request_comments', 'pull_request_reviews', 'pull_request_review_comments', 'pull_request_files', 'file']),
  repository,
  number: z.number().int().positive().optional(),
  path: z.string().max(1024).optional(),
  ref: z.string().regex(sha).optional(),
  page: z.number().int().min(1).max(100).default(1),
  offset: z.number().int().min(0).default(0),
}).strict();
type Args = z.infer<typeof argsSchema>;
export const findingsSchema = z.object({
  findings: z.array(z.object({
    sources: z.array(z.string()).min(1),
    userProblem: z.string().min(1),
    implementation: z.string().min(1),
    outcome: z.string().min(1),
    evidenceUrls: z.array(z.string().min(1)).min(1),
    limitations: z.array(z.string()),
    needsReview: z.boolean(),
  }).strict()).min(1),
}).strict();
type Target = { repository: string; kind: 'issue' | 'pull_request'; number: number; depth: number };
interface Document { url: string; fetchedAt: string; content: string; sha256: string; revision?: string }
export interface ResearchRecord {
  arguments: Args | { invalid: true }; status: 'success' | 'error'; result: unknown;
}
const key = (target: Pick<Target, 'repository' | 'kind' | 'number'>) => `${target.repository.toLowerCase()}:${target.kind}:${target.number}`;

/** Host-owned GET-only tools. No publishing token, arbitrary URL, shell or local file access. */
export class Research {
  readonly records: ResearchRecord[] = [];
  private targets = new Map<string, Target>();
  private required = new Map<string, Target>();
  private read = new Set<string>();
  private revisions = new Map<string, Set<string>>();
  private documents = new Map<string, Promise<Document>>();
  private pulls = new Map<string, Promise<any>>();
  private publicRepos = new Map<string, Promise<void>>();
  private calls = 0;
  private bytes = 0;
  private failure?: string;
  private closed = false;
  private findings?: z.infer<typeof findingsSchema>;
  private rejectedFindings?: z.infer<typeof findingsSchema>;
  private pullAliases = new Set<string>();
  private diagnostics: object[] = [];
  private sourceIds: Set<string>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly snapshot: Snapshot, evidence: Evidence, readonly limits: ResearchLimits,
    private token?: string, private fetcher: typeof fetch = fetch) {
    this.sourceIds = new Set(evidence.changes.map(change => change.id));
    this.revisions.set(snapshot.repository.toLowerCase(), new Set([snapshot.fromSha, snapshot.toSha]));
    for (const change of evidence.changes) {
      if (change.pull) this.allow({ repository: snapshot.repository, kind: 'pull_request', number: change.pull.number, depth: 0 }, true);
      if (change.originalPull) this.allow({ repository: snapshot.repository, kind: 'pull_request', number: change.originalPull.number, depth: 0 });
      this.discover([change.pull?.body ?? '', change.originalPull?.body ?? '', ...change.commits.map(c => c.message)].join('\n'), snapshot.repository, 0, true);
    }
    for (const target of this.required.values()) {
      if (target.kind === 'pull_request') this.required.delete(key({ ...target, kind: 'issue' }));
    }
  }
  private allow(target: Target, required = false): void {
    if (target.depth > this.limits.maxDepth) return;
    const id = key(target), previous = this.targets.get(id);
    if (!previous || target.depth < previous.depth) this.targets.set(id, target);
    if (required) this.required.set(id, target);
  }
  private discover(text: string, repo: string, depth: number, required = false): void {
    for (const match of text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)\b/gi)) {
      this.allow({ repository: match[1]!, kind: match[2]!.toLowerCase() === 'issues' ? 'issue' : 'pull_request', number: Number(match[3]), depth }, required && match[2]!.toLowerCase() === 'issues');
    }
    // GitHub shorthand can name either an issue or a PR. The issue endpoint identifies which.
    for (const match of text.matchAll(/(?:^|[\s(])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g)) {
      this.allow({ repository: match[1] ?? repo, kind: 'issue', number: Number(match[2]), depth }, required);
      this.allow({ repository: match[1] ?? repo, kind: 'pull_request', number: Number(match[2]), depth });
    }
  }
  instructions(): string {
    return `You are an investigating release editor. Actively use github_research to read PRs and linked issues, then follow relevant discussions, companion PRs, changed files and tests as needed. Do not merely restate the pre-collected evidence.
Read every required target below before finalizing. If a GitHub shorthand reference is ambiguous, read it as an issue first; its pull_request field identifies a PR. Issue reports establish symptoms, not proof of a fix. Compare actual code and tests with the frozen netDiff to establish what this release changes. External PRs and other revisions are context, never additional shipped source IDs.
When a PR has no issue, reason from its actual before/after code and inspect surrounding code if needed. Explain the affected user scenario, supported solution, outcome and limitations; consolidate related PRs. Never invent a defect or guarantee.
Only the source repository and explicit GitHub references reachable within ${this.limits.maxDepth} link levels are accessible. Source file reads use frozen from/to SHAs; PR reads expose immutable base/head/merge revisions for further file reads. Use only those revisions. The tool returns paginated, chunked evidence with nextPage/nextOffset; a fragment is not the complete document. If relevant evidence is inaccessible, qualify conclusions and set needsReview.
Budget: ${this.limits.maxCalls} calls, ${this.limits.maxBytes} returned bytes. Tool errors and budgets are explicit; do not claim you read material you did not receive.
Frozen repository: ${this.snapshot.repository}; from: ${this.snapshot.fromSha}; to: ${this.snapshot.toSha}.
Required targets: ${JSON.stringify([...this.required.values()])}
Initially linked targets: ${JSON.stringify([...this.targets.values()])}`;
  }
  tools(): Tool[] {
    return [{ name: 'github_research', description: 'Actively read a scoped GitHub issue, PR, discussion page, changed-file patches or file at an authorized immutable SHA. GET only. Follow nextOffset for more of a document and nextPage for more API results. Returns evidence URLs and hashes.',
      parameters: z.toJSONSchema(argsSchema), skipPermission: true, defer: 'never',
      handler: (input) => this.execute(input) }];
  }
  execute(input: unknown): Promise<unknown> {
    // Serialize to make concurrent model calls obey one shared budget and stable artifact order.
    const result = this.queue.then(() => this.run(input));
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async run(input: unknown): Promise<unknown> {
    const args = argsSchema.safeParse(input);
    if (!args.success) {
      if (++this.calls > this.limits.maxCalls) this.failure = 'Research call budget exhausted; raise research.maxCalls or narrow the range';
      const result = { error: 'Invalid research arguments; use the declared schema' };
      if (!this.closed && this.calls <= this.limits.maxCalls + 1) this.records.push({ arguments: { invalid: true }, status: 'error', result });
      return result;
    }
    const value = args.data;
    let result: unknown;
    try {
      if (this.closed) throw new Error('Research session is closed');
      if (++this.calls > this.limits.maxCalls) {
        this.failure = 'Research call budget exhausted; raise research.maxCalls or narrow the range';
        throw new Error(this.failure);
      }
      const target = this.authorize(value);
      const cacheKey = JSON.stringify({ ...value, offset: 0 });
      if (!this.documents.has(cacheKey)) this.documents.set(cacheKey, this.document(value, target));
      const doc = await this.documents.get(cacheKey)!;
      if (value.offset > doc.content.length) throw new Error('Offset exceeds document length');
      const end = Math.min(value.offset + 10000, doc.content.length);
      result = { url: doc.url, fetchedAt: doc.fetchedAt, sha256: doc.sha256, revision: doc.revision,
        offset: value.offset, totalCharacters: doc.content.length,
        nextOffset: end < doc.content.length ? end : null, content: doc.content.slice(value.offset, end) };
      const bytes = Buffer.byteLength(JSON.stringify(result));
      if (this.bytes + bytes > this.limits.maxBytes) {
        this.failure = 'Research byte budget exhausted; raise research.maxBytes or narrow the range';
        throw new Error(this.failure);
      }
      this.bytes += bytes;
      if (value.operation === 'issue' || value.operation === 'pull_request') this.read.add(key({ repository: value.repository, kind: value.operation, number: value.number! }));
      this.records.push({ arguments: value, status: 'success', result });
    } catch (error) {
      result = { error: error instanceof Error ? error.message : 'Research failed' };
      if (!this.closed && this.calls <= this.limits.maxCalls + 1) this.records.push({ arguments: value, status: 'error', result });
    }
    return result;
  }
  private authorize(args: Args): Target | undefined {
    const repo = args.repository.toLowerCase();
    if (args.operation === 'file') {
      if (!args.ref || !this.revisions.get(repo)?.has(args.ref)) throw new Error('File ref is outside the authorized immutable revisions');
      if (!args.path || posix.isAbsolute(args.path) || posix.normalize(args.path) !== args.path || args.path.split('/').some(p => p === '..' || p === '.git') || /[\x00-\x1f\x7f\\]/.test(args.path)) throw new Error('Invalid repository file path');
      return undefined;
    }
    if (!args.number) throw new Error('This operation requires a number');
    const kind = args.operation.startsWith('issue') ? 'issue' : 'pull_request';
    const target = this.targets.get(key({ repository: repo, kind, number: args.number }))
      ?? (kind === 'issue' ? this.targets.get(key({ repository: repo, kind: 'pull_request', number: args.number })) : undefined);
    if (!target && repo !== this.snapshot.repository.toLowerCase()) throw new Error('Target is outside the release repository and explicit linked references');
    return target ?? { repository: args.repository, kind, number: args.number, depth: 0 };
  }
  private async get(path: string, authenticated = true): Promise<any> {
    // Paths are constructed below, never supplied by the model or repository text.
    const response = await this.fetcher(`https://api.github.com${path}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(authenticated && this.token ? { Authorization: `Bearer ${this.token}` } : {}) } });
    if (!response.ok) throw new Error(`GitHub research request failed (HTTP ${response.status}); no evidence was obtained`);
    return response.json();
  }
  private async publicRepo(repo: string): Promise<void> {
    if (repo.toLowerCase() === this.snapshot.repository.toLowerCase()) return;
    if (!this.publicRepos.has(repo.toLowerCase())) this.publicRepos.set(repo.toLowerCase(), (async () => {
      const info = await this.get(`/repos/${repo}`, false);
      if (info.private !== false) throw new Error('Linked repository must be public');
    })());
    await this.publicRepos.get(repo.toLowerCase());
  }
  private pull(repo: string, number: number): Promise<any> {
    const id = `${repo.toLowerCase()}:${number}`;
    if (!this.pulls.has(id)) this.pulls.set(id, this.get(`/repos/${repo}/pulls/${number}`));
    return this.pulls.get(id)!;
  }
  private rememberRevisions(repo: string, pull: any): void {
    const refs = this.revisions.get(repo.toLowerCase()) ?? new Set<string>();
    for (const value of [pull.base?.sha, pull.head?.sha, pull.merge_commit_sha]) if (typeof value === 'string' && sha.test(value)) refs.add(value);
    this.revisions.set(repo.toLowerCase(), refs);
  }
  private async document(args: Args, target?: Target): Promise<Document> {
    await this.publicRepo(args.repository);
    const root = `/repos/${args.repository}`, url = `https://github.com/${args.repository}`;
    let data: unknown, revision: string | undefined, link: string;
    if (args.operation === 'file') {
      const blob = await this.get(`${root}/contents/${args.path!.split('/').map(encodeURIComponent).join('/')}?ref=${args.ref}`);
      if (blob.type !== 'file' || blob.encoding !== 'base64') throw new Error('Only regular text files supported; use a smaller file if the API cannot return its content');
      const content = Buffer.from(blob.content, 'base64');
      if (content.includes(0)) throw new Error('Binary files are not supported');
      data = { path: args.path, content: content.toString('utf8') }; revision = args.ref;
      link = `${url}/blob/${args.ref}/${args.path!.split('/').map(encodeURIComponent).join('/')}`;
    } else {
      const isPull = args.operation.startsWith('pull_request');
      const alias = `${args.repository.toLowerCase()}:${args.number}`;
      link = `${url}/${isPull || target?.kind === 'pull_request' || this.pullAliases.has(alias) ? 'pull' : 'issues'}/${args.number}`;
      if (args.operation === 'issue') {
        const issue = await this.get(`${root}/issues/${args.number}`);
        data = { number: issue.number, title: issue.title, body: issue.body, state: issue.state, updated_at: issue.updated_at,
          comments: issue.comments, pull_request: issue.pull_request, labels: issue.labels?.map((l: any) => l.name) };
        if (issue.pull_request) {
          this.allow({ ...target!, kind: 'pull_request' });
          this.pullAliases.add(alias);
          link = `${url}/pull/${args.number}`;
        }
        this.discover(issue.body ?? '', args.repository, target!.depth + 1);
      } else if (args.operation === 'pull_request') {
        this.pullAliases.add(alias);
        const pull = await this.pull(args.repository, args.number!);
        this.rememberRevisions(args.repository, pull);
        data = { number: pull.number, title: pull.title, body: pull.body, state: pull.state, merged_at: pull.merged_at, updated_at: pull.updated_at,
          merge_commit_sha: pull.merge_commit_sha, base: { ref: pull.base?.ref, sha: pull.base?.sha }, head: { ref: pull.head?.ref, sha: pull.head?.sha },
          changed_files: pull.changed_files, comments: pull.comments, review_comments: pull.review_comments };
        this.discover(pull.body ?? '', args.repository, target!.depth + 1);
        revision = pull.head?.sha;
      } else {
        const endpoint = args.operation === 'pull_request_files' ? `pulls/${args.number}/files`
          : args.operation === 'pull_request_reviews' ? `pulls/${args.number}/reviews`
          : args.operation === 'pull_request_review_comments' ? `pulls/${args.number}/comments` : `issues/${args.number}/comments`;
        const prior = args.operation === 'pull_request_files' ? await this.pull(args.repository, args.number!) : undefined;
        const items = await this.get(`${root}/${endpoint}?per_page=10&page=${args.page}`);
        if (!Array.isArray(items)) throw new Error('Expected a paginated GitHub result');
        let values: unknown[];
        if (args.operation === 'pull_request_files') {
          const pull = prior!;
          const current = await this.get(`${root}/pulls/${args.number}`);
          if (current.head?.sha !== pull.head?.sha || current.base?.sha !== pull.base?.sha) throw new Error('PR revisions changed during research; rerun to obtain consistent evidence');
          this.rememberRevisions(args.repository, pull);
          revision = pull.head?.sha;
          values = items.map(f => ({ filename: f.filename, previous_filename: f.previous_filename, status: f.status,
            additions: f.additions, deletions: f.deletions, patch: f.patch,
            patchMayBeIncomplete: true, guidance: 'GitHub patches may be omitted or shortened; read the file at base/head SHA for definitive implementation evidence.' }));
        } else {
          values = items.map(c => ({ url: c.html_url, body: c.body, state: c.state, path: c.path, line: c.line, diff_hunk: c.diff_hunk,
            updated_at: c.updated_at, submitted_at: c.submitted_at }));
          for (const c of items) this.discover(c.body ?? '', args.repository, target!.depth + 1);
        }
        data = { page: args.page, nextPage: items.length === 10 ? args.page + 1 : null, items: values };
      }
    }
    const content = JSON.stringify(data);
    return { url: link, revision, fetchedAt: new Date().toISOString(), content, sha256: createHash('sha256').update(content).digest('hex') };
  }
  assertInvestigated(): void {
    if (this.failure) throw new Error(this.failure);
    if (!this.records.some(r => r.status === 'success')) throw new Error('Copilot did not use GitHub research tools; refusing to publish an uninvestigated result');
    const missing = [...this.required].filter(([id]) => !this.read.has(id)).map(([, t]) => `${t.repository}/${t.kind}/${t.number}`);
    if (missing.length) throw new Error(`Copilot did not read required release evidence: ${missing.join(', ')}`);
  }
  recordFindings(value: unknown): void {
    const parsed = findingsSchema.safeParse(value);
    if (!parsed.success) throw new Error('Research findings have an invalid schema');
    const report = parsed.data;
    this.rejectedFindings = report;
    const covered = new Set<string>();
    const urls = new Set(this.citationUrls());
    const resource = (value: string) => {
      try { const url = new URL(value); url.hash = ''; return url.href; } catch { return ''; }
    };
    for (const finding of report.findings) {
      for (const id of finding.sources) {
        if (!this.sourceIds.has(id)) throw new Error('Research finding cites a source outside the release range');
        covered.add(id);
      }
      if (finding.evidenceUrls.some(url => !urls.has(resource(url)))) throw new Error('Research finding cites evidence not returned by a tool');
    }
    if ([...this.sourceIds].some(id => !covered.has(id))) throw new Error('Research findings do not account for every release change');
    this.findings = report;
    this.rejectedFindings = undefined;
  }
  citationUrls(): string[] {
    return [...new Set(this.records.filter(r => r.status === 'success').map(r => (r.result as { url: string }).url))];
  }
  recordDiagnostic(phase: string, data: { errorType?: string; errorCode?: string; statusCode?: number; providerErrorType?: string; providerErrorParam?: string }): void {
    // Never retain model response bodies, arbitrary messages, stacks or credential-bearing URLs.
    const label = (value?: string) => value && /^[a-zA-Z0-9_.\[\]-]{1,120}$/.test(value) ? value : undefined;
    this.diagnostics.push({ phase, errorType: label(data.errorType), errorCode: label(data.errorCode), statusCode: data.statusCode,
      providerErrorType: label(data.providerErrorType), providerErrorParam: label(data.providerErrorParam) });
  }
  async close(): Promise<void> { this.closed = true; await this.queue; }
  artifact(): object {
    return { schemaVersion: 1, snapshot: this.snapshot, limits: this.limits, calls: this.calls, returnedBytes: this.bytes,
      requiredTargets: [...this.required.values()], findings: this.findings, rejectedFindings: this.rejectedFindings, diagnostics: this.diagnostics, records: this.records };
  }
}
