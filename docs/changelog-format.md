# Changelog format

The default format serves users and operators deciding whether and how to upgrade. It combines these practices without copying another project's release text:

| Reference | Practice adopted |
| --- | --- |
| [Kubernetes v1.34](https://github.com/kubernetes/kubernetes/blob/master/CHANGELOG/CHANGELOG-1.34.md#urgent-upgrade-notes) | Keep upgrade actions in a dedicated section; our default places concrete changes first. |
| [Helm v3.19.0](https://github.com/helm/helm/releases/tag/v3.19.0) | Prioritize notable behavior changes and practical upgrade information. |
| [GitHub CLI v2.80.0](https://github.com/cli/cli/releases/tag/v2.80.0) | Use concise categories and link changes to their PRs. |
| [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) | Curate changes for people, group related entries, omit empty sections and put newer versions first. |
| [PostgreSQL 17.6](https://www.postgresql.org/docs/release/17.6/) | Explain the affected scenario, previous failure or limitation, and practical result; include upgrade action where warranted. |

## Structure

```markdown
## {{version}}

{{sections}}

{{upgrade_notes}}

{{compare_link}}
```

`upgrade_notes` renders an **Upgrade Notes** section only when a concrete action is supported by the evidence. `sections` renders the existing categories **Breaking Changes**, **Features**, **Fixes**, **Changes**, **Documentation** and **Maintenance**, omitting empty categories. This borrows Keep a Changelog's editorial principles; it does not claim to implement that format's exact category vocabulary.

Each entry states a behavior change in one or two sentences, followed by source links. Exact configuration names use inline code. Larger implementation explanations belong in the linked PR or documentation. There is no mandatory highlights block repeating a short release's entries, and no generated downloads, signatures, release date or known-issues assertions.

## State the released change, then explain its context

Policy v5 makes the categorized version log self-contained: **component + concrete addition/change/fix/removal → evidenced problem, consequence or condition where useful**. Readers must be able to tell what changed with Upgrade Notes hidden. State old and new defaults or versions, added public settings and affected scope when relevant. These facts must not disappear during compression or survive only as upgrade instructions.

For example: "Changed the default Local Storage migration-check setting from `false` to `true`; reconciliation updates `--migrate-check` on new and existing member DaemonSets." This is a factual configuration change. The opt-out belongs in Upgrade Notes; claims that the downstream tool verifies every file require separate implementation evidence. A subjective benefit such as "more reliable migration" is not a substitute for the actual change.

Likewise, state the migration image's old and new default tags and the added version-selection key. Briefly explain a verified companion fix and its prerequisite when relevant, without implying that changing the Operator configuration alone ships the downstream implementation. Fix entries still explain the triggering condition, previous failure and corrected behavior. Do not invent a bug or benefit to fit every intentional change.

Keep public configuration details needed to understand what changed. Environment declaration order, internal mappings and validation branches usually belong in linked documentation unless they explain a specific user problem. Incompatible changes still require a Breaking Changes entry even when Upgrade Notes already explain the required action. A separate new configuration capability can have its own entry citing the same PR; do not repeat the same behavior under different categories.

Group related PRs by outcome, not every change to one component into a single dense paragraph. Check the length and repetition of the entire public text: shrinking entries while expanding Upgrade Notes does not make the release concise. Preserve real compatibility and data-loss limitations, but do not turn missing investigation evidence into claims that the project never tested something.

The default heading contains only the version: the snapshot creation date is not the eventual publication date. Custom templates can still use `{{date}}`, which means the snapshot's UTC creation date. Generation timestamps remain available in the manifest.

Pure CI, test and refactoring changes are recorded in `excluded` with reasons rather than expanded into user-facing release notes. Changes to installation, delivered artifacts, supported platforms or runtime behavior remain eligible. The source coverage check still requires every change ID to be included or explicitly excluded.

Both the standalone version log and its block in the root Changelog receive the same rendered content. Regeneration replaces the current version's content and preserves historical versions.

## Concrete example

The [Operator v1.1.2-alpha1 example](../examples/changelog-operator-v1.1.2-alpha1.md) is a format demonstration, not an announcement of a published release. It uses the real range from tag `v1.1.1` (`e0b6bc166135f42c4afe5080983dd3e2e9d71949`) through `6bb145fd0dc082f2d8ca9d77f72a8d978a65a5e8` on `release/v1.1`.

The example was manually revised against the frozen diff and the subsequent local Copilot investigation to demonstrate policy v5; it is not unedited model output or a new production workflow result. It covers PRs #399 and #400. The other source PRs concern internal CI/release automation and are excluded from this public example. The earlier [live Copilot preview](https://github.com/hwameistor/release-assistant/actions/runs/39943835943) is historical context, not a validation run for this revision.

The example deliberately describes the Operator's migration-check flag and defaults without claiming that this repository alone proves the downstream copy tool's data-integrity behavior. Review of generated claims remains part of the release PR process.

## Editing and previewing

Edit `templates/changelog.md` for layout and `templates/changelog-policy.md` for editorial rules. Installed repositories own their copies under `.release-assistant/`; changing the bundled defaults does not overwrite those copies. Policy v5 puts categorized changes before Upgrade Notes in the default template; the renderer and JSON schema are unchanged. A shared policy URL updates editorial rules only: a consumer with its own layout must update that template separately to adopt the new section order.

Repositories can instead use a shared public policy file through the optional workflow `changelog_policy` input or a URL in the configuration's `policy` setting. See [shared policy configuration](../README.md#use-a-shared-changelog-policy). Each run reads the configured source again and records the exact content; editing the shared file does not require workflow changes.

Use the tool repository's **Preview release notes** workflow to preview bundled templates against a fixed range. It checks out the workflow run's commit, so use a new run after changing these defaults. An installed **Prepare release** rerun instead reads the latest configured template ref and updates the same release PR, subject to the existing frozen-range checks.
