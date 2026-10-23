import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const command = process.env.RA_COMMAND || 'generate';
if (!['generate', 'validate', 'release-body'].includes(command)) throw new Error('Unknown action command');
const args = [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), command];
const flags = { repository: 'REPOSITORY', 'target-branch': 'TARGET_BRANCH', version: 'VERSION', 'from-tag': 'FROM_TAG', 'from-tag-choice': 'FROM_TAG_CHOICE',
  'to-ref': 'TO_REF', 'template-ref': 'TEMPLATE_REF', config: 'CONFIG', 'head-ref': 'HEAD_REF', 'notes-path': 'NOTES_PATH',
  'source-ref': 'SOURCE_REF', 'chart-path': 'CHART_PATH', model: 'MODEL', 'changelog-policy': 'CHANGELOG_POLICY', output: 'OUTPUT' };
for (const [flag, key] of Object.entries(flags)) {
  const value = process.env[`RA_${key}`];
  if (value) args.push(`--${flag}`, value);
}
if (!['true', 'false', undefined, ''].includes(process.env.RA_PUBLISH)) throw new Error('publish must be true or false');
if (process.env.RA_PUBLISH === 'true') args.push('--publish');
try { execFileSync(process.execPath, args, { stdio: 'inherit' }); }
catch (error) { process.exitCode = typeof error.status === 'number' ? error.status : 1; }
