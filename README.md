# Release Assistant

Generate a reviewable release pull request from Git history using GitHub Copilot or your own model endpoint. The tool collects the exact commit range, associated merged PRs, backport context and final diff; the model explains behavior and user impact. Structured output is checked before any generated notes are published.

The product contract is in [docs/specification.md](docs/specification.md). Changes to the contract should be reviewed alongside implementation changes.

## Prepare a release

1. Copy [examples/release-assistant.yml](examples/release-assistant.yml) into the target repository as `release-assistant.yml`. Set the Chart path and model. For Operator, use `helm/operator/Chart.yaml`.
2. Copy `templates/changelog-policy.md` and `templates/changelog.md` into that repository's `.release-assistant/` directory. Both are versioned and can be edited independently of the tool.
3. Install [Prepare release](examples/prepare-release.yml) and [Validate release PR](examples/validate-release.yml) in `.github/workflows/`. Pin the Action to a reviewed full commit SHA. Install validation on each release branch too.
4. Configure the credentials below. Enable the validation check and require the release branch to be up to date before merging.
5. Run **Prepare release**, choosing the target branch, version, starting tag rank (or a manual tag), optional ending ref and model. Open the draft PR from the link at the top of the run summary. Its description shows the full version Changelog, with generation details collapsed below. Review its notes, excluded changes and Chart version before marking it ready.

The Action and the example workflow's `prepare` job expose the created or updated URL as `pull-request-url`. **Re-run all jobs** refreshes the same PR's description and generated files with the latest notes. Preview mode generates artifacts without creating or linking a release PR.

For example, `target_branch=release/v1.1`, `version=v1.1.2-alpha1`, `from_tag=v1.1.1` produces notes for changes after `v1.1.1` through the resolved target HEAD. Version and range are independent inputs. Release PRs must cover the target HEAD; use preview mode for older tag-to-tag intervals.

### Choose a starting tag

Leave `from_tag` empty to discover the three highest SemVer tags reachable from the ending commit and lower than the proposed release version. Choose `latest` (default), `second-latest`, or `third-latest` in `from_tag_choice`. GitHub's native form cannot dynamically load tag names into its dropdown: the actual names, selected tag and frozen SHA appear in the run summary, PR generation details and snapshot artifact after resolution. Annotated and lightweight tags, with or without a `v` prefix, are supported; prereleases are included. Ranking uses SemVer, not tag creation dates. Tags outside the selected history, non-SemVer tags and versions at or above the proposed release are excluded. Selecting an unavailable rank fails without silently choosing another tag.

To specify any existing tag, including a non-SemVer baseline or one outside the three suggestions, fill in `from_tag`; it overrides `from_tag_choice` and still passes the ancestry checks. In the Action/CLI these inputs are `from-tag` / `--from-tag` and `from-tag-choice` / `--from-tag-choice`. The Action and example prepare job expose the resolved `from-tag`, `from-sha` and `recent-tags` (JSON candidates, empty for manual selection).

The actual tag, commit and candidate list are frozen before inference. Re-running the same selection keeps that snapshot even if tags are added, moved or deleted. To change the starting point, start a new run with a different rank or an explicit tag. An explicit new `to_ref` refreshes the range and automatic candidates while reusing the same open Release PR.

The generated PR updates only the configured cumulative Changelog, version log, Chart `version`/`appVersion`, and `.release-assistant/{snapshot,manifest}.json`. Dependency and tool image versions, including JuiceFS, are not changed.

See the [format rationale](docs/changelog-format.md) and [Operator example](examples/changelog-operator-v1.1.2-alpha1.md) for the default layout: actionable upgrade notes first, concise categorized changes and a full diff link. Internal-only changes remain in the audit manifest rather than the public notes.

## Select a model

Prepare release and Preview release notes offer five choices in this order: `gpt-6.1-sol` (default), `gpt-6-astra`, `gemini-4-argon`, `gpt-5.3-codex`, and `gemini-3.8-flash`. This is a selection order, not an automatic fallback chain. Availability depends on the configured provider and account.

The Action's optional `model` input and CLI `--model` override `ai.model` for that run. Without an override, the latest repository configuration supplies the model. The selected ID reaches the configured provider unchanged and is recorded in the manifest and PR body. CLI/configuration accept other model IDs, including those exposed by a custom endpoint; the five-item dropdown is not a tool allowlist. Provider errors fail the job without silently selecting another model.

## Regenerate with Re-run jobs

### Use a shared Changelog policy

The optional **changelog_policy** field at the bottom of the workflow form overrides the policy for that run. GitHub's native form does not support collapsible input groups. Leave the field empty to use `policy` from the repository configuration, or omit that setting too to use the bundled policy. Layout still comes from the configured `template`.

For example, enter this public GitHub file URL:

```text
https://github.com/hwameistor/release-assistant/blob/main/templates/changelog-policy.md
```

To use that shared policy by default, set it once in `release-assistant.yml`:

```yaml
policy: https://github.com/hwameistor/release-assistant/blob/main/templates/changelog-policy.md
```

Thereafter, edit the shared file and use **Re-run all jobs**: each run fetches its latest content while preserving the release's frozen source range and open PR. No workflow edit is needed. A URL pinned to a commit SHA deliberately keeps that revision. Native reruns retain the original URL input; change it in a new run with the same release inputs to update the same PR.

After first upgrading the workflow/Action to support this option, start a new workflow run. Rerunning an older run still uses its original workflow and pinned tool version.

CLI `--changelog-policy` and Action input `changelog-policy` accept a repository-relative path, a public GitHub `/blob/` or `raw.githubusercontent.com` file URL, or a directly accessible HTTPS text/Markdown URL. For local preview, relative paths resolve beside `--local-config`. External URLs must not contain credentials or query parameters; redirects, login/HTML pages, empty files and files over 128 KiB fail without falling back to a different policy. Repository and model credentials are never sent to policy hosts; GitHub ref lookups use the public API without authentication.

GitHub URLs resolve to a commit SHA before the file is read. The run artifacts retain `policy.md`, `policy-source.json` and policy provenance in the local `manifest.json`; the job summary and Release PR show the source, resolved SHA when available and content hash. The committed manifest keeps its existing `policyHash` and schema, so already installed release validators remain compatible. Generic HTTPS sources are identified by their address and content hash.

### Refresh the existing PR

Use **Re-run all jobs** on the original workflow run. Every rerun calls the model again, reads the latest configuration and layout template from `template-ref` (default: the repository's default branch), and resolves the selected policy source again.

GitHub retains the original workflow inputs on rerun, including the selected model, which takes precedence over `ai.model`. To compare another model, start a new run with the same release inputs and a different model. It updates the same open PR and reuses the frozen source range while the target remains current.

The same repository, target branch and version reuse one PR. **Generated files are replaced, including manual edits to those files.** Each update adds a normal commit, so previous results remain in history. The first range snapshot is stored before inference: an initial model failure does not lose it. PR creation failure can also be retried.

Rerunning does not advance the source range. If the target branch has advanced, start a new workflow execution and explicitly set `to_ref` to the new full commit SHA. That refreshes the range in the same open PR. Closed/merged release PRs and existing target tags stop generation. Changing output paths during an ordinary rerun is rejected; changing wording, policy or model is supported.

## Credentials and execution location

| Credential | Purpose |
| --- | --- |
| `RELEASE_ASSISTANT_TOKEN` Action secret | GitHub App installation token or fine-grained PAT with Contents read/write and Pull requests read/write for the target repository. An App/PAT is needed if the resulting PR should trigger other Actions workflows. |
| `COPILOT_GITHUB_TOKEN` | Separate token with Copilot Requests access and an eligible Copilot account. The tool does not fall back to the publishing credential. |
| `research-token` Action input / `RELEASE_ASSISTANT_READ_TOKEN` CLI environment | Read-only GitHub access for Copilot's autonomous investigation. The Action defaults to `github.token`. Grant Contents, Issues and Pull requests read; do not pass the publishing PAT. Without this token the CLI uses public API access with anonymous rate limits. |
| `RELEASE_ASSISTANT_API_KEY` | Credential for your compatible model endpoint; optional for unauthenticated local servers. |
| `GH_TOKEN` or `GITHUB_TOKEN` CLI environment | Repository read/write credential. `GH_TOKEN` takes precedence. |

For Copilot credentials and billing, see GitHub's [SDK authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate) and [Actions billing documentation](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/copilot-cli-in-github-actions). Having subscription quota alone does not configure authentication for a runner. Follow your organization's token policy.

Create a fine-grained PAT with **Copilot Requests** permission using your Copilot-enabled account, then save its value under **Settings → Secrets and variables → Actions → New repository secret**, named `COPILOT_GITHUB_TOKEN`, in the repository running the workflow. Creating the PAT (including selecting Public repositories) does not create this Actions secret. This repository's preview requires only the Copilot secret; its read-only GitHub access uses the built-in workflow token.

Use an ordinary GitHub-hosted runner, a trusted self-hosted runner, or your own machine with Node.js 24 and Git. Calling a cloud model needs no GPU. This Action supports Linux/macOS runners. Copilot receives host-owned, read-only GitHub tools; shell access, arbitrary network requests, configuration discovery and automatic context compaction remain disabled. The pinned SDK includes its matching runtime; a global Copilot CLI installation is not required.

### Autonomous Copilot research

Copilot reads release PRs and linked issues itself, follows relevant discussion and companion PRs, and inspects code/tests at immutable revisions before writing notes. It first returns reviewable findings (user problem, implementation, outcome, evidence and limitations), then writes notes in the same session with further tool access. Findings must cover the release sources and cite URLs actually returned by tools. The initial Git range remains authoritative for what ships; external references only explain context. No successful tool calls, unread required PRs/issues or exhausted research budgets stop generation. A tool trace proves which evidence was read, not that every interpretation is correct.

Set the calling workflow permissions to `contents: read`, `issues: read` and `pull-requests: read`. Existing publishing and Copilot secrets stay unchanged. Linked external repositories must be public; private cross-repository research is not currently supported. For direct CLI use, supply a separate read-only token through `RELEASE_ASSISTANT_READ_TOKEN` when authenticated queries are needed.

`research.json` in the run artifacts records queries, returned content/chunks, URLs, retrieval times, immutable revisions and content hashes, including failed runs. It contains source material and should receive the same access controls as the source repository. On rerun, discussions are re-read and code reads stay within authorized immutable revisions; the release snapshot does not advance. Review the generated notes against this evidence before merging.

Optional configuration (defaults shown):

```yaml
research:
  maxCalls: 80
  maxBytes: 512000
  maxDepth: 2
```

The default model timeout is 600 seconds. Increase an explicitly configured `ai.timeoutSeconds` if a larger investigation needs more time. Compatible model endpoints retain the supplied-evidence mode; autonomous tools are currently implemented for the Copilot provider.

For a custom endpoint, change `ai` in the repository configuration:

```yaml
ai:
  provider: compatible
  model: your-model-name
  baseUrl: https://your-model.example/v1
  responseFormat: json_schema
  timeoutSeconds: 600
```

The adapter sends Chat Completions to `<baseUrl>/chat/completions`. If your server does not support structured output, choose `responseFormat: json_object` or `text`. Local validation of the returned JSON, references and coverage always runs. Provider errors, truncation and timeout fail the job; the tool never silently changes provider or uses an older response.

## Local CLI

```bash
npm ci --ignore-scripts
npm run build
node dist/cli.js generate \
  --repository hwameistor/hwameistor-operator \
  --target-branch release/v1.1 \
  --version v1.1.2-alpha1 \
  --from-tag v1.1.1 \
  --template-ref refs/heads/main
```

Without `--publish`, GitHub is read-only. Artifacts go to `.release-assistant-output/`:

- `snapshot.json`: frozen source range; keep this directory for local reruns.
- `evidence.json`: actual commits, PR context and diffs.
- `manifest.json`: generated notes, exclusions and provenance.
- `files/`: proposed repository files.

Use `--local-config /path/to/config.yml` to preview before the target repository has configuration. Referenced policy/template paths are relative to that config; omitted paths use the bundled defaults. `--git-dir /path/to/checkout` reuses an existing source checkout containing all required commits. Use distinct output directories for different releases.

Add `--publish` when you want to create/update the draft PR. Only this mode writes to GitHub. GitHub.com repositories are supported in the first version; Enterprise hosts are not yet wired into cloning and links.

## Publishing and limits

The generation tool does not merge PRs, create tags, build images or publish releases. The integration adds Prepare/Validate workflows and connects the existing publication workflow to the reviewed version log. Publication reads the exact source commit, checks Chart version/appVersion, manifest provenance/content hash and any existing tag, then copies the notes into the Chart package as `RELEASE_NOTES.md`. Chart Releaser uses it as the GitHub Release body. Missing or mismatched notes/manifests fail before publication; manually prepared releases must also supply matching provenance. Downstream jobs use the same source SHA and version. Existing triggers are unchanged. [docs/integration.md](docs/integration.md) describes this path and the remaining prerelease/latest limitations. The [publication companion](examples/publish-chart.py) remains a reference for a future publisher with additional retry/asset checks; it is not installed by this integration.

The first version fails explicitly if commit count or prompt bytes exceed configured limits; it does not silently truncate or claim full coverage. You can raise the limit for a model with sufficient context or narrow the range. PR diffs are deduplicated while individual commit provenance is retained. GitHub's 300-file comparison limit also fails closed during release-branch validation.

Structural validation is not proof that an AI interpretation is correct. Review the resulting behavior descriptions, uncertain entries and exclusions. The default policy/categories/template can evolve through normal reviews. Versions are canonicalized with a `v` prefix; prerelease versions are supported and SemVer build metadata is currently rejected.

## Development

```bash
npm run check
npm test
npm run build
```

Tests use real temporary Git histories and simulated GitHub/model services. They cover reverts, backports, merge/squash, source coverage, repeated runs, failed inference, failed PR creation, stale targets, publication guards, concurrent edits and output paths. They do not spend Copilot quota. The manual **Preview release notes** workflow provides an optional live Copilot check after its credential is configured.

The preview workflow saves its range snapshot in an immutable Actions cache keyed by workflow run ID, and uploads result artifacts separately for each attempt. A rerun requires that exact snapshot; if it has expired or was never saved, start a new preview. Release PR generation persists its snapshot in the generated Git branch and does not depend on this preview cache.
