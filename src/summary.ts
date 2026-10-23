import type { Manifest, Pull, Snapshot } from './model.js';

export function sourceRangeSummary(snapshot: Snapshot): string {
  const selection = snapshot.fromTagSelection;
  return `Starting tag: \`${snapshot.fromTag.replaceAll('`', '%60')}\` (\`${snapshot.fromSha}\`).\n\n` +
    (selection
      ? `Automatic choice: \`${selection.choice}\`. Candidates at initial range resolution (highest SemVer first):\n\n` +
        selection.candidates.map((tag, index) => `${index + 1}. \`${tag.name}\` (\`${tag.sha.slice(0, 7)}\`)${tag.name === snapshot.fromTag ? ' — selected' : ''}`).join('\n') +
        '\n\nThe selected tag and commits are frozen for reruns.\n'
      : 'Starting tag was specified manually.\n');
}

export function prepareSummary(pull: Pull | undefined, manifest: Manifest): string {
  const source = manifest.policySource;
  return (pull
    ? `## Release PR\n\n[Review ${manifest.snapshot.version} in PR #${pull.number}](${pull.html_url})\n\n`
    : '## Release notes preview\n\nPreview generated. No pull request was created.\n\n') +
    `<details>\n<summary>Release range</summary>\n\n${sourceRangeSummary(manifest.snapshot)}\n</details>\n\n` +
    `<details>\n<summary>Changelog policy</summary>\n\n` +
    `Source (${source.kind}): \`${source.location.replaceAll('`', '%60')}\`\n\n` +
    (source.sha ? `Resolved commit: \`${source.sha}\`\n\n` : '') +
    `SHA-256: \`${manifest.policyHash}\`\n\nThe exact policy is included in the run artifacts.\n\n</details>\n`;
}
