import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'release-preview-config-'));
try {
  const path = join(directory, 'config.yml');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, language: 'English', ai: { provider: 'copilot', model: process.env.RA_MODEL }, output: { charts: [] }, limits: { maxPromptBytes: 256000 } }));
  execFileSync(process.execPath, ['dist/cli.js', 'generate', '--local-config', path,
    '--repository', process.env.RA_REPOSITORY, '--target-branch', process.env.RA_TARGET_BRANCH,
    '--version', process.env.RA_VERSION,
    ...(process.env.RA_FROM_TAG ? ['--from-tag', process.env.RA_FROM_TAG] : []),
    ...(process.env.RA_FROM_TAG_CHOICE ? ['--from-tag-choice', process.env.RA_FROM_TAG_CHOICE] : []),
    '--to-ref', process.env.RA_TO_REF || `refs/heads/${process.env.RA_TARGET_BRANCH}`,
    ...(process.env.RA_CHANGELOG_POLICY ? ['--changelog-policy', process.env.RA_CHANGELOG_POLICY] : [])], { stdio: 'inherit' });
} catch (error) { process.exitCode = typeof error.status === 'number' ? error.status : 1; }
finally { await rm(directory, { recursive: true, force: true }); }
