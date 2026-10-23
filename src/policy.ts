import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { policyReference, safePath } from './config.js';
import type { GitHub } from './github.js';

export interface PolicySource {
  kind: 'bundled' | 'repository' | 'local' | 'github' | 'https';
  location: string;
  sha?: string;
}
export interface ResolvedPolicy { text: string; source: PolicySource }
const maxBytes = 128 * 1024;

function checkedText(text: string): string {
  if (!text.trim() || text.includes('\0')) throw new Error('Changelog policy must contain nonempty UTF-8 text');
  if (Buffer.byteLength(text) > maxBytes) throw new Error('Changelog policy exceeds 128 KiB');
  if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(text)) throw new Error('Policy URL returned HTML; use a text or Markdown file');
  return text;
}

async function remoteText(url: string, fetcher: typeof fetch, refLookup = false): Promise<string | null> {
  let response: Response;
  try {
    // Policy hosts never receive repository or model credentials. Redirects must
    // be resolved by the caller so the configured address is the recorded source.
    response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Accept: refLookup ? 'application/vnd.github.sha' : 'text/plain, text/markdown' } });
  } catch { throw new Error('Unable to fetch external Changelog policy; use a directly accessible public HTTPS file'); }
  if (!response.ok) {
    await response.body?.cancel();
    if (refLookup && [404, 422].includes(response.status)) return null;
    throw new Error(`External Changelog policy request failed (HTTP ${response.status})`);
  }
  if (/text\/html/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new Error('Policy URL returned HTML; use a text or Markdown file');
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('Changelog policy exceeds 128 KiB');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('External Changelog policy response is empty');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('Changelog policy exceeds 128 KiB');
      chunks.push(value);
    }
    return checkedText(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof Error && /^(Changelog policy|Policy URL)/.test(error.message)) throw error;
    throw new Error('External Changelog policy is unreadable or is not UTF-8 text');
  } finally { reader.releaseLock(); }
}

async function externalPolicy(reference: string, fetcher: typeof fetch): Promise<ResolvedPolicy> {
  const url = new URL(reference);
  if (url.hostname !== 'github.com' && url.hostname !== 'raw.githubusercontent.com') {
    return { text: (await remoteText(url.href, fetcher))!, source: { kind: 'https', location: url.href } };
  }
  const parts = url.pathname.slice(1).split('/').map(decodeURIComponent);
  const [owner, repo] = parts;
  if (!owner || !repo || !/^[\w.-]+\/[\w.-]+$/.test(`${owner}/${repo}`) || url.port) throw new Error('Invalid GitHub policy file URL');
  if (url.hostname === 'github.com' && parts[2] !== 'blob') throw new Error('Use a GitHub file URL containing /blob/ or a raw.githubusercontent.com file URL');
  const tail = parts.slice(url.hostname === 'github.com' ? 3 : 2);
  // Resolve the longest matching ref, then fetch at the immutable SHA. This
  // supports slash refs without mistaking a shorter tag for the intended branch.
  const pinnedRef = /^[a-f0-9]{40}$/i.test(tail[0] ?? '');
  if (!pinnedRef && tail.length > 20) throw new Error('GitHub policy URL is too deeply nested; use a full commit SHA URL');
  const firstSplit = pinnedRef ? 1 : tail.length - 1;
  for (let split = firstSplit; split >= 1; split--) {
    const ref = tail.slice(0, split).join('/');
    const sha = (await remoteText(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, fetcher, true))?.trim();
    if (!sha) continue;
    if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('GitHub policy ref did not resolve to a commit SHA');
    const path = safePath(tail.slice(split).join('/'));
    const pinned = `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`;
    return { text: (await remoteText(pinned, fetcher))!, source: { kind: 'github', location: url.href, sha } };
  }
  throw new Error('GitHub policy file ref was not found; check the public file URL or use a full commit SHA');
}

export async function loadPolicy(reference: string | undefined, context: {
  github: GitHub; configSha: string; localConfig?: string; fetcher?: typeof fetch;
}): Promise<ResolvedPolicy> {
  if (!reference?.trim()) return { text: checkedText(await readFile(new URL('../templates/changelog-policy.md', import.meta.url), 'utf8')),
    source: { kind: 'bundled', location: 'templates/changelog-policy.md' } };
  const source = policyReference(reference);
  if (source.startsWith('https://')) return externalPolicy(source, context.fetcher ?? fetch);
  if (context.localConfig) return { text: checkedText(await readFile(resolve(dirname(context.localConfig), source), 'utf8')),
    source: { kind: 'local', location: source } };
  return { text: checkedText(await context.github.requiredFile(source, context.configSha)),
    source: { kind: 'repository', location: source, sha: context.configSha } };
}
