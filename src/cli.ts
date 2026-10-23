#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GitHub } from './github.js';
import { GitSource } from './git.js';
import { prepare } from './prepare.js';
import { releaseBody } from './release.js';
import { validateRelease } from './validate.js';
import { writeOutput } from './storage.js';
import { prepareSummary } from './summary.js';

const help = `Release Assistant

generate --repository owner/repo --target-branch release/v1.1 --version v1.1.2-alpha1
         --from-tag v1.1.1 [--to-ref refs/heads/release/v1.1] [--publish]
         [--config release-assistant.yml] [--template-ref refs/heads/main] [--model MODEL]
         [--changelog-policy PATH_OR_HTTPS_URL]
         [--output .release-assistant-output] [--local-config path] [--git-dir path]
validate --repository owner/repo --target-branch release/v1.1 --head-ref release-assistant/...
release-body --repository owner/repo --version v1.1.2-alpha1
             [--source-ref COMMIT --chart-path helm/example/Chart.yaml]
             [--notes-path changelogs/released/{version}/changelog] [--output .release-assistant-output]

generate defaults to local preview. --publish persists a range snapshot and creates/updates a draft PR.
Credentials: GH_TOKEN or GITHUB_TOKEN; separate COPILOT_GITHUB_TOKEN or RELEASE_ASSISTANT_API_KEY.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    repository: { type: 'string' }, 'target-branch': { type: 'string' }, version: { type: 'string' },
    'from-tag': { type: 'string' }, 'to-ref': { type: 'string' }, config: { type: 'string', default: 'release-assistant.yml' },
    'template-ref': { type: 'string' }, output: { type: 'string', default: '.release-assistant-output' },
    publish: { type: 'boolean', default: false }, 'local-config': { type: 'string' }, 'git-dir': { type: 'string' },
    'head-ref': { type: 'string' }, 'notes-path': { type: 'string', default: 'changelogs/released/{version}/changelog' },
    'source-ref': { type: 'string' }, 'chart-path': { type: 'string' }, model: { type: 'string' }, 'changelog-policy': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || !positionals.length) { console.log(help); return; }
  const required = (key: keyof typeof values): string => {
    const value = values[key];
    if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) throw new Error(`Missing or invalid --${key}`);
    return value;
  };
  const github = new GitHub(required('repository'), process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN);
  const command = positionals[0];
  if (positionals.length !== 1) throw new Error('Unexpected positional arguments');
  const outputs: Record<string, string> = {};
  if (command === 'generate') {
    const targetBranch = required('target-branch');
    const git = values['git-dir'] ? new GitSource(resolve(values['git-dir'])) : await GitSource.clone(github.repository, process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN);
    try {
      const result = await prepare({ repository: github.repository, targetBranch, version: required('version'), fromTag: required('from-tag'),
        toRef: values['to-ref'] || `refs/heads/${targetBranch}`, configPath: values.config, templateRef: values['template-ref'],
        model: values.model, changelogPolicy: values['changelog-policy'], outputDir: values.output, publish: values.publish }, { github, git, localConfig: values['local-config'] });
      outputs.branch = result.branch;
      outputs['pull-request-url'] = result.pull?.html_url ?? '';
      outputs['output-directory'] = resolve(values.output);
      console.log(result.pull ? `Updated release PR: ${result.pull.html_url}` : `Preview generated: ${resolve(values.output)}`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(process.env.GITHUB_STEP_SUMMARY, prepareSummary(result.pull, result.manifest));
      }
    } finally { await git.close(); }
  } else if (command === 'validate') {
    await validateRelease(github, required('head-ref'), required('target-branch'));
    console.log('Release files, version, source coverage and target snapshot are valid.');
  } else if (command === 'release-body') {
    const result = await releaseBody(github, { version: values.version, sourceRef: values['source-ref'], chartPath: values['chart-path'], notesPath: values['notes-path'] });
    await writeOutput(values.output, 'release-body.md', result.content);
    outputs['body-path'] = resolve(values.output, 'release-body.md');
    outputs.prerelease = String(result.prerelease);
    outputs['make-latest'] = String(result.makeLatest);
    outputs['source-sha'] = result.sha;
    outputs.version = result.version;
    console.log(`Reviewed release body: ${outputs['body-path']}`);
  } else throw new Error(`Unknown command: ${command}`);
  if (process.env.GITHUB_OUTPUT) {
    for (const [key, value] of Object.entries(outputs)) {
      if (/[\r\n]/.test(value)) throw new Error('Invalid action output');
      await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
  }
}

main().catch(error => { console.error(`release-assistant: ${error instanceof Error ? error.message : 'Unexpected failure'}`); process.exitCode = 1; });
