# Release Assistant

Generate a reviewable release pull request from Git history using GitHub Copilot or your own model endpoint. The tool collects the exact commit range, associated merged PRs, backport context and final diff; the model explains behavior and user impact. Structured output is checked before any generated notes are published.

The product contract is in [docs/specification.md](docs/specification.md). Changes to the contract should be reviewed alongside implementation changes.

## Prepare a release

1. Copy [examples/release-assistant.yml](examples/release-assistant.yml) into the target repository as `release-assistant.yml`. Set the Chart path and model. For Operator, use `helm/operator/Chart.yaml`.
2. Copy `templates/changelog-policy.md` and `templates/changelog.md` into that repository's `.release-assistant/` directory. Both are versioned and can be edited independently of the tool.
3. Install [Prepare release](examples/prepare-release.yml) and [Validate release PR](examples/validate-release.yml) in `.github/workflows/`. Pin the Action to a reviewed full commit SHA. Install validation on each release branch too.
4. Configure the credentials below. Enable the validation check and require the release branch to be up to date before merging.
5. Run **Prepare release**, choosing the target branch, version, starting tag, optional ending ref and model. The result is a draft PR. Review its notes, excluded changes and Chart version before marking it ready.

For example, `target_branch=release/v1.1`, `version=v1.1.2-alpha1`, `from_tag=v1.1.1` produces notes for changes after `v1.1.1` through the resolved target HEAD. Version and range are independent inputs. Release PRs must cover the target HEAD; use preview mode for older tag-to-tag intervals.

The generated PR updates only the configured cumulative Changelog, version log, Chart `version`/`appVersion`, and `.release-assistant/{snapshot,manifest}.json`. Dependency and tool image versions, including JuiceFS, are not changed.

## Select a model

Prepare release and Preview release notes offer five choices in this order: `gpt-6.1-sol` (default), `gpt-6-astra`, `gemini-4-argon`, `gpt-5.3-codex`, and `gemini-3.8-flash`. This is a selection order, not an automatic fallback chain. Availability depends on the configured provider and account.

The Action's optional `model` input and CLI `--model` override `ai.model` for that run. Without an override, the latest repository configuration supplies the model. The selected ID reaches the configured provider unchanged and is recorded in the manifest and PR body. CLI/configuration accept other model IDs, including those exposed by a custom endpoint; the five-item dropdown is not a tool allowlist. Provider errors fail the job without silently selecting another model.

## Regenerate with Re-run jobs

Use **Re-run all jobs** on the original workflow run. Every rerun calls the model again and reads the latest configuration, policy and template from `template-ref` (default: the repository's default branch).

GitHub retains the original workflow inputs on rerun, including the selected model, which takes precedence over `ai.model`. To compare another model, start a new run with the same release inputs and a different model. It updates the same open PR and reuses the frozen source range while the target remains current.

The same repository, target branch and version reuse one PR. **Generated files are replaced, including manual edits to those files.** Each update adds a normal commit, so previous results remain in history. The first range snapshot is stored before inference: an initial model failure does not lose it. PR creation failure can also be retried.

Rerunning does not advance the source range. If the target branch has advanced, start a new workflow execution and explicitly set `to_ref` to the new full commit SHA. That refreshes the range in the same open PR. Closed/merged release PRs and existing target tags stop generation. Changing output paths during an ordinary rerun is rejected; changing wording, policy or model is supported.

## Credentials and execution location

| Credential | Purpose |
| --- | --- |
| `RELEASE_ASSISTANT_TOKEN` Action secret | GitHub App installation token or fine-grained PAT with Contents read/write and Pull requests read/write for the target repository. An App/PAT is needed if the resulting PR should trigger other Actions workflows. |
| `COPILOT_GITHUB_TOKEN` | Separate token with Copilot Requests access and an eligible Copilot account. The tool does not fall back to the publishing credential. |
| `RELEASE_ASSISTANT_API_KEY` | Credential for your compatible model endpoint; optional for unauthenticated local servers. |
| `GH_TOKEN` or `GITHUB_TOKEN` CLI environment | Repository read/write credential. `GH_TOKEN` takes precedence. |

For Copilot credentials and billing, see GitHub's [SDK authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate) and [Actions billing documentation](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/copilot-cli-in-github-actions). Having subscription quota alone does not configure authentication for a runner. Follow your organization's token policy.

Create a fine-grained PAT with **Copilot Requests** permission using your Copilot-enabled account, then save its value under **Settings → Secrets and variables → Actions → New repository secret**, named `COPILOT_GITHUB_TOKEN`, in the repository running the workflow. Creating the PAT (including selecting Public repositories) does not create this Actions secret. This repository's preview requires only the Copilot secret; its read-only GitHub access uses the built-in workflow token.

Use an ordinary GitHub-hosted runner, a trusted self-hosted runner, or your own machine with Node.js 24 and Git. Calling a cloud model needs no GPU. This Action supports Linux/macOS runners. Model tools, shell access, configuration discovery and automatic context compaction are disabled. The pinned SDK includes its matching runtime; a global Copilot CLI installation is not required.

For a custom endpoint, change `ai` in the repository configuration:

```yaml
ai:
  provider: compatible
  model: your-model-name
  baseUrl: https://your-model.example/v1
  responseFormat: json_schema
  timeoutSeconds: 180
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

The generation tool does not merge PRs, create tags, build images or publish releases. The current integration adds Prepare/Validate workflows and repository configuration; merging a generated Release PR follows the existing publication workflow and triggers. [docs/integration.md](docs/integration.md) also discusses optional, separately reviewed changes for reusing the notes as the GitHub Release body and controlling prerelease/latest flags. The [publication companion](examples/publish-chart.py) is a reference for those future changes and is not installed by the current integration.

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
