import { createHash } from 'node:crypto';
import type { Evidence, Snapshot } from './model.js';

type Span = [number, number];
interface Document {
  id: string; title: string; url: string; content: string; sha256: string; required: boolean;
}

/** Return a bounded JSON-safe text fragment, retaining line boundaries where possible. */
export function fragment(text: string, offset: number, maxBytes: number): { content: string; nextOffset: number | null } {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length
    || (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? ''))) throw new Error('Invalid document offset');
  let low = offset, high = Math.min(text.length, offset + maxBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(offset, middle))) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--;
  if (end < text.length) {
    const newline = text.lastIndexOf('\n', end - 1) + 1;
    if (newline > offset + (end - offset) / 2) end = newline;
  }
  if (end === offset && offset < text.length) throw new Error('Document chunk budget is too small');
  return { content: text.slice(offset, end), nextOffset: end < text.length ? end : null };
}

export class EvidenceStore {
  private documents = new Map<string, Document>();
  private spans = new Map<string, Span[]>();
  constructor(snapshot: Snapshot, evidence: Evidence) {
    const root = `https://github.com/${snapshot.repository}`;
    this.add('net-diff', 'Final changes between the frozen release endpoints',
      `${root}/compare/${snapshot.fromSha}...${snapshot.toSha}`, evidence.netDiff, true);
    this.add('changed-files', 'All final diff file headers (including deletions and binary changes)',
      `${root}/compare/${snapshot.fromSha}...${snapshot.toSha}`,
      evidence.netDiff.split('\n').filter(line => line.startsWith('diff --git ')).join('\n'));
    this.add('warnings', 'Collection warnings', `${root}/compare/${snapshot.fromSha}...${snapshot.toSha}`, JSON.stringify(evidence.warnings), true);
    for (const change of evidence.changes) {
      const url = change.pull?.html_url ?? `${root}/commit/${change.commits.at(-1)?.sha ?? snapshot.toSha}`;
      const title = change.pull?.title ?? change.commits[0]?.subject ?? change.id;
      const { diff, ...metadata } = change;
      this.add(`source:${change.id}`, title, url, JSON.stringify(metadata), true);
      this.add(`diff:${change.id}`, title, url, diff);
    }
  }
  add(id: string, title: string, url: string, content: string, required = false): void {
    if (this.documents.has(id)) throw new Error('Duplicate evidence document');
    this.documents.set(id, { id, title, url, content, required, sha256: createHash('sha256').update(content).digest('hex') });
  }
  index(page = 1): object {
    const start = (page - 1) * 10;
    const docs = [...this.documents.values()];
    return { page, totalDocuments: docs.length, nextPage: start + 10 < docs.length ? page + 1 : null,
      documents: docs.slice(start, start + 10).map(d => ({ id: d.id, titlePreview: d.title.slice(0, 180),
        characters: d.content.length, bytes: Buffer.byteLength(d.content), required: d.required,
        nextUnreadOffset: this.nextUnread(d.id), sha256: d.sha256 })) };
  }
  read(id: string, offset = 0, maxBytes = 12000) {
    const doc = this.documents.get(id);
    if (!doc) throw new Error('Unknown evidence document; use release_evidence index');
    const part = fragment(doc.content, offset, maxBytes);
    return { documentId: id, url: doc.url, sha256: doc.sha256, offset,
      totalCharacters: doc.content.length, ...part };
  }
  acknowledge(id: string, offset: number, length: number): void {
    const spans = [...this.spans.get(id) ?? [], [offset, offset + length] as Span].sort((a, b) => a[0] - b[0]);
    const merged: Span[] = [];
    for (const span of spans) {
      const last = merged.at(-1);
      if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else merged.push([...span]);
    }
    this.spans.set(id, merged);
  }
  private nextUnread(id: string): number | null {
    const first = this.spans.get(id)?.[0];
    if (!first || first[0] !== 0) return 0;
    return first[1] >= this.documents.get(id)!.content.length ? null : first[1];
  }
  coverage() {
    return [...this.documents.values()].map(d => ({ id: d.id, required: d.required,
      characters: d.content.length, nextUnreadOffset: this.nextUnread(d.id) }));
  }
  assertComplete(): void {
    const missing = this.coverage().filter(d => d.required && d.nextUnreadOffset !== null);
    if (missing.length) throw new Error(`Research has unread frozen evidence (${missing.length} documents); next: ${missing[0]!.id} at offset ${missing[0]!.nextUnreadOffset}. Continue with release_evidence; nothing was omitted.`);
  }
}
