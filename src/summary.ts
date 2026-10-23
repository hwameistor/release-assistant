import type { Manifest, Pull } from './model.js';

export function prepareSummary(pull: Pull | undefined, manifest: Manifest): string {
  const source = manifest.policySource;
  return (pull
    ? `## Release PR\n\n[Review ${manifest.snapshot.version} in PR #${pull.number}](${pull.html_url})\n\n`
    : '## Release notes preview\n\nPreview generated. No pull request was created.\n\n') +
    `<details>\n<summary>Changelog policy</summary>\n\n` +
    `Source (${source.kind}): \`${source.location.replaceAll('`', '%60')}\`\n\n` +
    (source.sha ? `Resolved commit: \`${source.sha}\`\n\n` : '') +
    `SHA-256: \`${manifest.policyHash}\`\n\nThe exact policy is included in the run artifacts.\n\n</details>\n`;
}
