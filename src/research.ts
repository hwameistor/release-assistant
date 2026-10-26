import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import type { Tool } from '@github/copilot-sdk';
import type { Evidence, Notes, Snapshot } from './model.js';
import { EvidenceStore, fragment } from './evidence.js';

const repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const sha = /^[a-f0-9]{40}$/i;
export const researchLimitsSchema = z.object({
  maxCalls: z.number().int().min(1).max(5000).default(300),
  maxBytes: z.number().int().min(10000).max(100000000).default(4000000),
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
const findingSchema = findingsSchema.shape.findings.element;
type Finding = z.infer<typeof findingSchema>;
const evidenceArgs = z.object({
  operation: z.enum(['index', 'read', 'status']), documentId: z.string().max(200).optional(),
  page: z.number().int().min(1).max(10000).default(1), offset: z.number().int().min(0).default(0),
}).strict();
const notebookArgs = z.object({
  operation: z.enum(['save', 'list', 'read', 'remove']),
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(), finding: findingSchema.optional(),
  page: z.number().int().min(1).max(10000).default(1), offset: z.number().int().min(0).default(0),
}).strict();
type Target = { repository: string; kind: 'issue' | 'pull_request'; number: number; depth: number };
class ResearchHttpError extends Error {
  constructor(readonly status: number, readonly path: string) {
    super(`GitHub research request failed (HTTP ${status}); no evidence was obtained`);
  }
}
type UnavailableReference = Target & { status: number; sources: string[] };
interface Document { url: string; fetchedAt: string; content: string; sha256: string; revision?: string }
export interface ResearchRecord {
  arguments: Args | Record<string, unknown>; status: 'success' | 'error'; result: unknown;
}
const key = (target: Pick<Target, 'repository' | 'kind' | 'number'>) => `${target.repository.toLowerCase()}:${target.kind}:${target.number}`;

/** Host-owned GET-only tools. No publishing token, arbitrary URL, shell or local file access. */
export class Research {
  readonly records: ResearchRecord[] = [];
  private targets = new Map<string, Target>();
  private required = new Map<string, Target>();
  private sourcePulls = new Set<string>();
  private requiredSources = new Map<string, Set<string>>();
  private unavailable = new Map<string, UnavailableReference>();
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
  readonly evidence: EvidenceStore;
  private notebook = new Map<string, Finding>();
  private chunkBytes = 12000;
  private progress?: () => Promise<void>;
  private documentReads = new Map<string, [number, number][]>();
  private policy?: string;
  constructor(readonly snapshot: Snapshot, evidence: Evidence, readonly limits: ResearchLimits,
    private token?: string, private fetcher: typeof fetch = fetch,
    private sourceFile?: (ref: string, path: string) => Promise<string>) {
    this.evidence = new EvidenceStore(snapshot, evidence);
    this.sourceIds = new Set(evidence.changes.map(change => change.id));
    this.revisions.set(snapshot.repository.toLowerCase(), new Set([snapshot.fromSha, snapshot.toSha]));
    for (const change of evidence.changes) {
      if (change.pull) {
        const target: Target = { repository: snapshot.repository, kind: 'pull_request', number: change.pull.number, depth: 0 };
        this.sourcePulls.add(key(target));
        this.allow(target, true, change.id);
      }
      if (change.originalPull) this.allow({ repository: snapshot.repository, kind: 'pull_request', number: change.originalPull.number, depth: 0 });
      this.discover([change.pull?.body ?? '', change.originalPull?.body ?? '', ...change.commits.map(c => c.message)].join('\n'), snapshot.repository, 0, true, change.id);
    }
    for (const target of this.required.values()) {
      if (target.kind === 'pull_request') this.required.delete(key({ ...target, kind: 'issue' }));
    }
    this.evidence.add('targets', 'Required GitHub reads and initially linked references',
      `https://github.com/${snapshot.repository}/compare/${snapshot.fromSha}...${snapshot.toSha}`,
      JSON.stringify({ required: [...this.required.values()], linked: [...this.targets.values()] }));
  }
  private allow(target: Target, required = false, source?: string): void {
    if (target.depth > this.limits.maxDepth) return;
    const id = key(target), previous = this.targets.get(id);
    if (!previous || target.depth < previous.depth) this.targets.set(id, target);
    if (required) {
      this.required.set(id, target);
      if (source) {
        const sources = this.requiredSources.get(id) ?? new Set<string>();
        sources.add(source);
        this.requiredSources.set(id, sources);
      }
    }
  }
  private discover(text: string, repo: string, depth: number, required = false, source?: string): void {
    for (const match of text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)\b/gi)) {
      this.allow({ repository: match[1]!, kind: match[2]!.toLowerCase() === 'issues' ? 'issue' : 'pull_request', number: Number(match[3]), depth }, required && match[2]!.toLowerCase() === 'issues', source);
    }
    // GitHub shorthand can name either an issue or a PR. The issue endpoint identifies which.
    for (const match of text.matchAll(/(?:^|[\s(])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g)) {
      this.allow({ repository: match[1] ?? repo, kind: 'issue', number: Number(match[2]), depth }, required, source);
      this.allow({ repository: match[1] ?? repo, kind: 'pull_request', number: Number(match[2]), depth });
    }
  }
  instructions(): string {
    return `You are an investigating release editor. Actively use github_research to read PRs and linked issues, then follow relevant discussions, companion PRs, changed files and tests as needed. Do not merely restate the pre-collected evidence.
Read every required target in the targets document before finalizing. If a GitHub shorthand reference is ambiguous, read it as an issue first; its pull_request field identifies a PR. Issue reports establish symptoms, not proof of a fix. Compare actual code and tests with the frozen netDiff to establish what this release changes. External PRs and other revisions are context, never additional shipped source IDs.
Source PRs must be read successfully. A required auxiliary reference returning HTTP 404/410 is recorded as unavailable, not read evidence: do not repeatedly retry or cite it. Investigate correctly qualified references if available, document the limitation and qualify the affected findings. The host marks affected sources for review. Authentication, rate-limit and server failures do not satisfy required reads.
When a PR has no issue, reason from its actual before/after code and inspect surrounding code if needed. Explain the affected user scenario, supported solution, outcome and limitations; consolidate related PRs. Never invent a defect or guarantee.
Only the source repository and explicit GitHub references reachable within ${this.limits.maxDepth} link levels are accessible. Source file reads use frozen from/to SHAs; PR reads expose immutable base/head/merge revisions for further file reads. Use only those revisions. The tool returns paginated, chunked evidence with nextPage/nextOffset; a fragment is not the complete document. If relevant evidence is inaccessible, qualify conclusions and set needsReview.
Budget: ${this.limits.maxCalls} calls, ${this.limits.maxBytes} returned bytes. Tool errors and budgets are explicit; do not claim you read material you did not receive.
Frozen repository: ${this.snapshot.repository}; from: ${this.snapshot.fromSha}; to: ${this.snapshot.toSha}.
Full evidence is stored outside the conversation. Start with release_evidence index and read targets for required GitHub reads. Index pages and document fragments are bounded; follow nextPage and nextOffset. Read all required documents, especially the COMPLETE net-diff, including deletions, and every source's metadata. Per-source diff documents are available for deeper investigation without repeating the entire range in the initial prompt.
Use research_notebook save to checkpoint each problem's findings AS YOU INVESTIGATE, with a stable id. Saving that id replaces its old conclusion; remove obsolete ids when consolidating related findings. Saved findings survive context compaction and can be listed/read in pages. Never rely only on conversation memory. Every source must be covered by saved findings, including internal changes and reverted behavior (explain their exclusion in outcome).
Before writing, reconcile related findings against the frozen endpoints. A regression introduced and fixed within this unreleased range is not a shipped breaking change. Save the corrected combined finding, retaining all relevant source IDs and evidence. Use release_evidence status to check what is still missing.
Source count: ${this.sourceIds.size}. Required GitHub target count: ${this.required.size}.`;
  }
  tools(): Tool[] {
    return [{ name: 'github_research', description: 'Actively read a scoped GitHub issue, PR, discussion page, changed-file patches or file at an authorized immutable SHA. GET only. Follow nextOffset for more of a document and nextPage for more API results. Returns evidence URLs and hashes.',
      parameters: z.toJSONSchema(argsSchema), skipPermission: true, defer: 'never',
      handler: (input) => this.execute(input) },
    { name: 'release_evidence', description: 'List or read complete frozen release evidence in bounded pages. Documents include source metadata, individual diffs, final net-diff, and required GitHub targets. status reports missing coverage. Follow nextPage/nextOffset; no content is silently truncated.',
      parameters: z.toJSONSchema(evidenceArgs), skipPermission: true, defer: 'never',
      handler: input => this.local('release_evidence', input) },
    { name: 'research_notebook', description: 'Save, replace, remove, list or read structured findings in host-owned storage. Checkpoint before context compaction. One finding may combine several PRs; one PR may contribute to multiple findings. List/read are paginated. No arbitrary filesystem writes.',
      parameters: z.toJSONSchema(notebookArgs), skipPermission: true, defer: 'never',
      handler: input => this.local('research_notebook', input) }];
  }
  setProgressWriter(writer: () => Promise<void>): void { this.progress = writer; }
  setPolicy(policy: string): void {
    if (this.policy === policy) return;
    if (this.policy !== undefined) throw new Error('Research policy cannot change within an investigation');
    this.policy = policy;
    // Editorial instructions remain retrievable after compaction, but are not implementation evidence.
    this.evidence.add('policy', 'Editorial policy for this run', '', policy);
  }
  setChunkBytes(bytes: number): void { this.chunkBytes = Math.max(512, Math.min(12000, Math.floor(bytes))); }
  private charge(result: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (this.bytes + bytes > this.limits.maxBytes) {
      this.failure = 'Research byte budget exhausted; raise research.maxBytes or narrow the range';
      throw new Error(this.failure);
    }
    this.bytes += bytes;
  }
  private countCall(): void {
    if (this.closed) throw new Error('Research session is closed');
    if (++this.calls > this.limits.maxCalls) {
      this.failure = 'Research call budget exhausted; raise research.maxCalls or narrow the range';
      throw new Error(this.failure);
    }
  }
  private local(tool: string, input: unknown): Promise<unknown> {
    const task = this.queue.then(async () => {
      let result: any;
      try {
        this.countCall();
        if (tool === 'release_evidence') {
          const args = evidenceArgs.parse(input);
          if (args.operation === 'read') {
            result = this.evidence.read(args.documentId ?? '', args.offset, this.chunkBytes);
            this.charge(result);
            this.evidence.acknowledge(result.documentId, result.offset, result.content.length);
          } else {
            result = args.operation === 'index' ? this.evidence.index(args.page) : this.status(args.page);
            this.charge(result);
          }
        } else {
          const args = notebookArgs.parse(input);
          const id = args.id ?? '';
          if (args.operation !== 'list' && !id) throw new Error('Research notebook operation requires an id');
          if (args.operation === 'save') {
            const finding = findingSchema.parse(args.finding);
            // Validate citations before acknowledging a checkpoint. Bounded findings stay readable after compaction.
            if (Buffer.byteLength(JSON.stringify(finding)) > 12000) throw new Error('Research finding is too large; split independent outcomes into separate findings');
            this.validateFindings([finding], false);
            result = { saved: id, sources: finding.sources };
            this.charge(result);
            this.notebook.set(id, finding);
            this.findings = undefined;
          } else if (args.operation === 'remove') {
            result = { removed: id };
            this.charge(result);
            this.notebook.delete(id);
            this.findings = undefined;
          } else if (args.operation === 'read') {
            const finding = this.notebook.get(id);
            if (!finding) throw new Error('Research finding not found');
            const content = JSON.stringify(finding);
            result = { id, offset: args.offset, totalCharacters: content.length, ...fragment(content, args.offset, this.chunkBytes) };
            this.charge(result);
          } else {
            const entries = [...this.notebook];
            const start = (args.page - 1) * 10;
            result = { page: args.page, total: entries.length, nextPage: start + 10 < entries.length ? args.page + 1 : null,
              findings: entries.slice(start, start + 10).map(([id, f]) => ({ id, sourceCount: f.sources.length, sourcesPreview: f.sources.slice(0, 10), outcomePreview: f.outcome.slice(0, 180) })) };
            this.charge(result);
          }
        }
        this.records.push({ arguments: { tool, ...input as object }, status: 'success', result });
        if (this.progress) {
          try { await this.progress(); }
          catch { this.failure = 'Research checkpoint could not be persisted'; throw new Error(this.failure); }
        }
      } catch (error) {
        result = { error: error instanceof z.ZodError ? 'Invalid research tool arguments' : error instanceof Error ? error.message : 'Research failed' };
        if (!this.closed && this.calls <= this.limits.maxCalls + 1) this.records.push({ arguments: { tool }, status: 'error', result });
      }
      return result;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
  status(page = 1): object {
    const covered = new Set([...this.notebook.values()].flatMap(f => f.sources));
    const missingSources = [...this.sourceIds].filter(id => !covered.has(id));
    const missingTargets = [...this.required].filter(([id]) => !this.read.has(id) && !this.unavailable.has(id)).map(([, t]) => t);
    const missingDocuments = this.evidence.coverage().filter(d => d.required && d.nextUnreadOffset !== null);
    const start = (page - 1) * 10, total = Math.max(missingSources.length, missingTargets.length, missingDocuments.length);
    return { page, nextPage: start + 10 < total ? page + 1 : null, missingSourceCount: missingSources.length,
      missingSources: missingSources.slice(start, start + 10), missingTargetCount: missingTargets.length,
      missingTargets: missingTargets.slice(start, start + 10), missingDocumentCount: missingDocuments.length,
      missingDocuments: missingDocuments.slice(start, start + 10), calls: this.calls, returnedBytes: this.bytes, failure: this.failure };
  }
  checkpoint(): object {
    return { schemaVersion: 1, snapshot: this.snapshot, findings: Object.fromEntries(this.notebook), coverage: this.evidence.coverage(), status: this.status() };
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
      this.countCall();
      const target = this.authorize(value);
      const cacheKey = JSON.stringify({ ...value, offset: 0 });
      if (!this.documents.has(cacheKey)) this.documents.set(cacheKey, this.document(value, target));
      const doc = await this.documents.get(cacheKey)!;
      const part = fragment(doc.content, value.offset, this.chunkBytes);
      result = { url: doc.url, fetchedAt: doc.fetchedAt, sha256: doc.sha256, revision: doc.revision,
        offset: value.offset, totalCharacters: doc.content.length,
        ...part };
      this.charge(result);
      if (value.operation === 'issue' || value.operation === 'pull_request') {
        const id = key({ repository: value.repository, kind: value.operation, number: value.number! });
        const spans = [...this.documentReads.get(cacheKey) ?? [], [value.offset, value.offset + part.content.length] as [number, number]].sort((a, b) => a[0] - b[0]);
        this.documentReads.set(cacheKey, spans);
        let end = 0;
        for (const span of spans) { if (span[0] > end) break; end = Math.max(end, span[1]); }
        if (end >= doc.content.length) this.read.add(id);
        this.unavailable.delete(id);
      }
      this.records.push({ arguments: value, status: 'success', result });
    } catch (error) {
      result = { error: error instanceof Error ? error.message : 'Research failed' };
      if (error instanceof ResearchHttpError && [404, 410].includes(error.status)
        && (value.operation === 'issue' || value.operation === 'pull_request')
        && error.path === `/repos/${value.repository}/${value.operation === 'issue' ? 'issues' : 'pulls'}/${value.number}`) {
        const id = key({ repository: value.repository, kind: value.operation, number: value.number! });
        const target = this.required.get(id);
        // A failed repository lookup, source PR read or unrelated tool call cannot waive a required read.
        if (target && !this.sourcePulls.has(id)) {
          const reference = { ...target, status: error.status, sources: [...this.requiredSources.get(id) ?? []] };
          this.unavailable.set(id, reference);
          result = { ...result as object, unavailableReference: reference,
            guidance: 'This auxiliary reference could not be read. Do not cite it or retry the same address. Follow correctly qualified references if available; affected findings will retain this limitation and require review.' };
        }
      }
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
    if (!response.ok) throw new ResearchHttpError(response.status, path);
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
      let content: string;
      if (this.sourceFile && args.repository.toLowerCase() === this.snapshot.repository.toLowerCase()
        && [this.snapshot.fromSha, this.snapshot.toSha].includes(args.ref!)) {
        content = await this.sourceFile(args.ref!, args.path!);
      } else {
        const blob = await this.get(`${root}/contents/${args.path!.split('/').map(encodeURIComponent).join('/')}?ref=${args.ref}`);
        if (blob.type !== 'file' || blob.encoding !== 'base64') throw new Error('Only regular text files supported; the API did not return file content');
        content = Buffer.from(blob.content, 'base64').toString('utf8');
      }
      if (content.includes('\0')) throw new Error('Binary files are not supported');
      data = { path: args.path, content }; revision = args.ref;
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
    const missing = [...this.required].filter(([id]) => !this.read.has(id) && !this.unavailable.has(id)).map(([, t]) => `${t.repository}/${t.kind}/${t.number}`);
    if (missing.length) throw new Error(`Copilot did not read required release evidence: ${missing.join(', ')}`);
  }
  recordFindings(value: unknown): void {
    const parsed = findingsSchema.safeParse(value);
    if (!parsed.success) throw new Error('Research findings have an invalid schema');
    const report = parsed.data;
    this.rejectedFindings = report;
    this.validateFindings(report.findings, true);
    this.findings = report;
    this.rejectedFindings = undefined;
  }
  private validateFindings(findings: Finding[], requireAll: boolean): void {
    const covered = new Set<string>();
    const urls = new Set(this.citationUrls());
    const resource = (value: string) => {
      try { const url = new URL(value); url.hash = ''; return url.href; } catch { return ''; }
    };
    for (const finding of findings) {
      for (const id of finding.sources) {
        if (!this.sourceIds.has(id)) throw new Error('Research finding cites a source outside the release range');
        covered.add(id);
      }
      if (finding.evidenceUrls.some(url => !urls.has(resource(url)))) throw new Error('Research finding cites evidence not returned by a tool');
    }
    if (requireAll && [...this.sourceIds].some(id => !covered.has(id))) throw new Error('Research findings do not account for every release change');
    for (const reference of this.unavailable.values()) {
      for (const finding of findings.filter(f => f.sources.some(id => reference.sources.includes(id)))) {
        finding.needsReview = true;
        const limitation = `Auxiliary reference ${reference.repository}#${reference.number} returned HTTP ${reference.status}; no evidence was obtained. Verify the reference or qualify conclusions using other successfully read evidence.`;
        if (!finding.limitations.includes(limitation)) finding.limitations.push(limitation);
      }
    }
  }
  assertComplete(): void {
    this.assertInvestigated();
    this.evidence.assertComplete();
    if (!this.notebook.size) throw new Error('Research notebook is empty; save findings before composing');
    this.recordFindings({ findings: [...this.notebook.values()] });
  }
  citationUrls(): string[] {
    return [...new Set(this.records.filter(r => r.status === 'success').map(r => (r.result as { url?: string }).url).filter((url): url is string => typeof url === 'string' && url.startsWith('https://github.com/')))];
  }
  findingsReport(): unknown { return this.findings; }
  markReviewRequired(notes: Notes): void {
    const sources = new Set([
      ...this.findings?.findings.filter(f => f.needsReview).flatMap(f => f.sources) ?? [],
      ...[...this.unavailable.values()].flatMap(r => r.sources),
    ]);
    for (const entry of notes.entries) if (entry.sources.some(id => sources.has(id))) entry.needsReview = true;
  }
  recordDiagnostic(phase: string, data: { errorType?: string; errorCode?: string; statusCode?: number; providerErrorType?: string; providerErrorParam?: string }): void {
    // Never retain model response bodies, arbitrary messages, stacks or credential-bearing URLs.
    const label = (value?: string) => value && /^[a-zA-Z0-9_.\[\]-]{1,120}$/.test(value) ? value : undefined;
    this.diagnostics.push({ phase, errorType: label(data.errorType), errorCode: label(data.errorCode), statusCode: data.statusCode,
      providerErrorType: label(data.providerErrorType), providerErrorParam: label(data.providerErrorParam) });
  }
  recordMetrics(event: string, data: object): void {
    const allowed = ['inputTokens', 'outputTokens', 'currentTokens', 'tokenLimit', 'preCompactionTokens', 'postCompactionTokens', 'tokensRemoved', 'success', 'max_prompt_tokens', 'max_context_window_tokens', 'max_output_tokens'];
    this.diagnostics.push({ event, ...Object.fromEntries(Object.entries(data).filter(([key, value]) => allowed.includes(key)
      && ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean'))) });
  }
  async close(): Promise<void> { this.closed = true; await this.queue; }
  artifact(): object {
    return { schemaVersion: 1, snapshot: this.snapshot, limits: this.limits, calls: this.calls, returnedBytes: this.bytes,
      requiredTargets: [...this.required.values()], unavailableReferences: [...this.unavailable.values()],
      findings: this.findings, notebook: Object.fromEntries(this.notebook), coverage: this.evidence.coverage(),
      rejectedFindings: this.rejectedFindings, diagnostics: this.diagnostics, records: this.records };
  }
}
