import { parseDocument } from 'yaml';
import { categories, notesSchema, type Evidence, type Notes, type Snapshot } from './model.js';

export function validateNotes(value: unknown, evidence: Evidence): Notes {
  const notes = notesSchema.parse(value);
  const known = new Set(evidence.changes.map(change => change.id));
  const included = new Set<string>(), excluded = new Set<string>();
  for (const [items, seen] of [[notes.entries, included], [notes.excluded, excluded]] as const) {
    for (const item of items) for (const source of item.sources) {
      if (!known.has(source)) throw new Error(`Unknown evidence source: ${source}`);
      seen.add(source);
    }
  }
  for (const id of known) {
    if (included.has(id) && excluded.has(id)) throw new Error(`Source both included and excluded: ${id}`);
    if (!included.has(id) && !excluded.has(id)) throw new Error(`Missing evidence coverage: ${id}`);
  }
  return notes;
}

const headings = { breaking: 'Breaking Changes', features: 'Features', fixes: 'Fixes', changes: 'Changes', documentation: 'Documentation', maintenance: 'Maintenance' };
const inline = (value: string) => value.replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
export function renderNotes(notes: Notes, snapshot: Snapshot, template: string): string {
  for (const required of ['version', 'sections']) if (!template.includes(`{{${required}}}`)) throw new Error(`Template must contain {{${required}}}`);
  const links = (sources: string[]) => [...new Set(sources)].map(source => {
    const [kind, id] = source.split(':');
    return kind === 'pr' ? `[#${id}](https://github.com/${snapshot.repository}/pull/${id})`
      : `[${id!.slice(0, 7)}](https://github.com/${snapshot.repository}/commit/${id})`;
  }).join(', ');
  const sections = categories.flatMap(category => {
    const entries = notes.entries.filter(entry => entry.category === category);
    return entries.length ? [`### ${headings[category]}\n\n${entries.map(entry => `- ${inline(entry.summary)}${entry.impact ? ` ${inline(entry.impact)}` : ''} (${links(entry.sources)})${entry.needsReview ? ' **Needs review.**' : ''}`).join('\n')}`] : [];
  }).join('\n\n') || 'No user-facing changes in this range.';
  const upgrades = notes.entries.flatMap(entry => entry.upgradeNotes);
  const values: Record<string, string> = { version: snapshot.version, date: snapshot.createdAt.slice(0, 10), sections,
    upgrade_notes: upgrades.length ? `### Upgrade Notes\n\n${[...new Set(upgrades)].map(note => `- ${inline(note)}`).join('\n')}` : '',
    compare_link: `[Full diff](https://github.com/${snapshot.repository}/compare/${snapshot.fromSha}...${snapshot.toSha})` };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`Unknown template placeholder: ${key}`);
    return values[key]!;
  }).trim() + '\n';
}

export function updateChangelog(previous: string, version: string, notes: string): string {
  const start = `<!-- release-assistant:${version}:start -->`, end = `<!-- release-assistant:${version}:end -->`;
  const block = `${start}\n${notes.trim()}\n${end}`;
  const offset = previous.indexOf(start);
  if (offset >= 0) {
    const until = previous.indexOf(end, offset);
    if (until < 0 || previous.indexOf(start, offset + start.length) >= 0) throw new Error('Malformed generated changelog markers');
    return previous.slice(0, offset) + block + previous.slice(until + end.length);
  }
  const title = /^# [^\n]*\n/.exec(previous);
  return title ? `${title[0]}\n${block}\n\n${previous.slice(title[0].length).trimStart()}` : `# Changelog\n\n${block}\n\n${previous.trimStart()}`;
}

export function updateChart(content: string, version: string): string {
  const document = parseDocument(content);
  if (document.errors.length) throw new Error('Invalid Chart YAML');
  for (const key of ['version', 'appVersion']) {
    if (typeof document.get(key) !== 'string') throw new Error(`Chart must have a string ${key}`);
    document.set(key, version);
  }
  return document.toString();
}
