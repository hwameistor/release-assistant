import { z } from 'zod';
import type { PolicySource } from './policy.js';

export const categories = ['breaking', 'features', 'fixes', 'changes', 'documentation', 'maintenance'] as const;
export const notesSchema = z.object({
  entries: z.array(z.object({
    category: z.enum(categories),
    summary: z.string().trim().min(1),
    impact: z.string().trim(),
    sources: z.array(z.string()).min(1),
    upgradeNotes: z.array(z.string().trim().min(1)),
    needsReview: z.boolean(),
  }).strict()),
  excluded: z.array(z.object({ sources: z.array(z.string()).min(1), reason: z.string().trim().min(1) }).strict()),
}).strict();
export type Notes = z.infer<typeof notesSchema>;
export interface Pull {
  number: number; title: string; body: string | null; html_url: string;
  state: string; merged_at: string | null; merge_commit_sha: string | null;
  base: { ref: string }; head: { ref: string; repo: { full_name: string } | null };
}
export interface Commit { sha: string; subject: string; message: string; parents: string[] }
export interface Change {
  id: string; commits: Commit[]; pull?: Pull;
  originalPull?: Pick<Pull, 'number' | 'title' | 'body' | 'html_url'>;
  diff: string;
}
export interface Evidence { changes: Change[]; netDiff: string; warnings: string[] }
export const recentTagChoiceSchema = z.enum(['latest', 'second-latest', 'third-latest']);
export type RecentTagChoice = z.infer<typeof recentTagChoiceSchema>;
export interface TagCandidate { name: string; sha: string }
export const snapshotSchema = z.object({
  schemaVersion: z.literal(1), repository: z.string(), targetBranch: z.string(), version: z.string(),
  fromTag: z.string(), toRef: z.string(), fromSha: z.string().regex(/^[a-f0-9]{40}$/),
  toSha: z.string().regex(/^[a-f0-9]{40}$/), targetSha: z.string().regex(/^[a-f0-9]{40}$/),
  createdAt: z.string(), generatedPaths: z.array(z.string()).default([]),
  fromTagSelection: z.object({
    choice: recentTagChoiceSchema,
    candidates: z.array(z.object({ name: z.string(), sha: z.string().regex(/^[a-f0-9]{40}$/) })).min(1).max(3),
  }).optional(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export interface Provider { generate(prompt: string, schema: object): Promise<unknown> }
export interface GenerateOptions {
  repository: string; targetBranch: string; version: string; fromTag?: string; fromTagChoice?: string; toRef: string;
  configPath: string; templateRef?: string; model?: string; changelogPolicy?: string; outputDir: string; publish: boolean;
}
export interface Manifest {
  snapshot: Snapshot; templateSha: string; generatedAt: string;
  policyHash: string; templateHash: string; provider: string; model: string;
  policySource: PolicySource;
  notes: Notes; evidence: Evidence;
}
