import test from 'node:test';
import assert from 'node:assert/strict';
import { assertConciseNotes, composeConciseNotes, lengthViolations, measureText } from '../src/concise.js';
import type { Notes } from '../src/model.js';
import { validateNotes } from '../src/render.js';

const words = (count: number) => Array(count).fill('word').join(' ');
const notes = (summary: string): Notes => ({ entries: [{ category: 'changes', summary, impact: '', sources: ['pr:42'],
  upgradeNotes: [], needsReview: true }], excluded: [{ sources: ['pr:43'], reason: 'Internal tests only.' }] });

test('count visible prose and settings, combine summary/impact, and include action labels', () => {
  assert.equal(measureText('Set `localStorage.migrate.juicesync.version=1.2.0`; see [migration guide](https://example.com/a/very/long/path).').count, 5);
  assertConciseNotes(notes(words(30)));
  const long = notes(words(25)); long.entries[0]!.impact = words(6);
  assert.deepEqual(lengthViolations(long), ['entries[0].summary+impact: 31 words, maximum 30']);
  long.entries[0]!.impact = words(5);
  long.entries[0]!.upgradeNotes = [`**Existing users:** ${words(29)}`];
  assert.deepEqual(lengthViolations(long), ['entries[0].upgradeNotes[0]: 31 words, maximum 30']);
  // Research exclusions and renderer-added source/review metadata have no prose budget.
  const valid = notes('Enable checks.'); valid.excluded[0]!.reason = words(100);
  assertConciseNotes(valid);
});

test('Chinese and other CJK text cannot bypass limits by omitting spaces', () => {
  assert.equal(measureText('迁移检查默认开启，使用 `localStorage.migrate.check=false` 可关闭。').count, 14);
  assertConciseNotes(notes('字'.repeat(60)));
  assert.throws(() => assertConciseNotes(notes('字'.repeat(61))), /61 CJK characters\/words, maximum 60/);
  assert.throws(() => assertConciseNotes(notes('あ'.repeat(61))), /maximum 60/);
  assert.throws(() => assertConciseNotes(notes('한'.repeat(61))), /maximum 60/);
});

test('a length failure requests one complete rewrite and never silently truncates', async () => {
  const original = notes(words(31)); const corrected = notes('Checks now default to enabled.');
  const prompts: string[] = [];
  const result = await composeConciseNotes(async instruction => {
    prompts.push(instruction); return prompts.length === 1 ? original : corrected;
  });
  assert.deepEqual(result, corrected); assert.equal(prompts.length, 2);
  assert.match(prompts[0]!, /at most 30/);
  assert.match(prompts[1]!, /entries\[0\].summary\+impact: 31/);
  assert.ok(prompts[1]!.includes(JSON.stringify(original)));
  assert.match(prompts[1]!, /Preserve source coverage, categories, review flags, essential facts and material upgrade warnings/);
  assert.equal(original.entries[0]!.summary, words(31));
  let attempts = 0;
  await assert.rejects(composeConciseNotes(async () => { attempts++; return original; }), /Release notes exceed per-item length limits/);
  assert.equal(attempts, 2);
});

test('concise output needs no retry and existing manifest validation does not inherit new editorial limits', async () => {
  let attempts = 0;
  const result = await composeConciseNotes(async () => { attempts++; return notes('Enable checks.'); });
  assert.equal(attempts, 1); assert.equal(result.entries[0]!.needsReview, true);
  const legacy = notes(words(60));
  const evidence = { changes: ['pr:42', 'pr:43'].map(id => ({ id, commits: [], diff: '' })), netDiff: '', warnings: [] };
  assert.deepEqual(validateNotes(legacy, evidence), legacy);
});

test('shortening cannot remove an action, hide a change or clear its review flag', async () => {
  for (const alter of [
    (value: Notes) => { value.entries[0]!.upgradeNotes = []; },
    (value: Notes) => { value.entries[0]!.needsReview = false; },
    (value: Notes) => { value.excluded.push({ sources: value.entries.pop()!.sources, reason: 'Too long.' }); },
  ]) {
    const original = notes(words(31)); original.entries[0]!.upgradeNotes = ['**Existing users:** migrate settings before upgrading.'];
    const corrected = structuredClone(original); corrected.entries[0]!.summary = 'Checks now default to enabled.';
    alter(corrected);
    let attempts = 0;
    await assert.rejects(composeConciseNotes(async () => ++attempts === 1 ? original : corrected), /Length rewrite changed/);
    assert.equal(attempts, 2);
  }
});
