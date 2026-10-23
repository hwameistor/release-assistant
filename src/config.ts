import { parse } from 'yaml';
import { z } from 'zod';
import { posix } from 'node:path';
import { researchLimitsSchema } from './research.js';

export function safePath(value: string): string {
  if (!value || value === '.' || /[\x00-\x1f\x7f]/.test(value) || value.includes('\\') || posix.isAbsolute(value)
      || posix.normalize(value) !== value || value.split('/').includes('..')
      || value.split('/').some(part => part === '.git') || value.startsWith('.github/workflows/')) {
    throw new Error(`Unsafe generated/config path: ${value}`);
  }
  return value;
}
export function policyReference(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid Changelog policy reference');
  const reference = value.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) {
    const url = new URL(reference);
    if (url.protocol !== 'https:' || url.username || url.password || url.search) {
      throw new Error('Policy URLs must use HTTPS without credentials or query parameters');
    }
    url.hash = '';
    return url.href;
  }
  return safePath(reference);
}
const configSchema = z.object({
  schemaVersion: z.literal(1),
  language: z.string().default('English'),
  policy: z.string().optional(), template: z.string().optional(),
  output: z.object({
    changelog: z.string().default('CHANGELOG.md'),
    releaseNotes: z.string().default('changelogs/released/{version}/changelog'),
    charts: z.array(z.string()).default([]),
  }).default({ changelog: 'CHANGELOG.md', releaseNotes: 'changelogs/released/{version}/changelog', charts: [] }),
  ai: z.object({
    provider: z.enum(['copilot', 'compatible']).default('copilot'),
    model: z.string().min(1), baseUrl: z.string().url().optional(),
    responseFormat: z.enum(['json_schema', 'json_object', 'text']).optional(),
    timeoutSeconds: z.number().int().min(1).max(1800).default(600),
  }),
  research: researchLimitsSchema.prefault({}),
  limits: z.object({
    maxCommits: z.number().int().min(1).max(2000).default(300),
    maxPromptBytes: z.number().int().min(1000).max(2000000).default(160000),
  }).default({ maxCommits: 300, maxPromptBytes: 160000 }),
}).strict();
export type Config = z.infer<typeof configSchema>;
export function loadConfig(text: string): Config {
  const config = configSchema.parse(parse(text));
  if (config.policy) config.policy = policyReference(config.policy);
  if (config.template) safePath(config.template);
  if (config.ai.provider === 'compatible' && !config.ai.baseUrl) throw new Error('compatible provider requires ai.baseUrl');
  return config;
}
export function outputPaths(config: Config, version: string): string[] {
  const paths = [config.output.changelog, config.output.releaseNotes.replaceAll('{version}', version), ...config.output.charts].map(safePath);
  if (new Set(paths).size !== paths.length || paths.some(p => p.startsWith('.release-assistant/'))) {
    throw new Error('Output paths must be unique and outside .release-assistant/');
  }
  return paths;
}
