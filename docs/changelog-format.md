# Changelog format

The default format serves users and operators deciding whether and how to upgrade. It combines these practices without copying another project's release text:

| Reference | Practice adopted |
| --- | --- |
| [Kubernetes v1.34](https://github.com/kubernetes/kubernetes/blob/master/CHANGELOG/CHANGELOG-1.34.md#urgent-upgrade-notes) | Place upgrade actions before categorized changes. |
| [Helm v3.19.0](https://github.com/helm/helm/releases/tag/v3.19.0) | Prioritize notable behavior changes and practical upgrade information. |
| [GitHub CLI v2.80.0](https://github.com/cli/cli/releases/tag/v2.80.0) | Use concise categories and link changes to their PRs. |
| [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) | Curate changes for people, group related entries, omit empty sections and put newer versions first. |

## Structure

```markdown
## {{version}}

{{upgrade_notes}}

{{sections}}

{{compare_link}}
```

`upgrade_notes` renders an **Upgrade Notes** section only when a concrete action is supported by the evidence. `sections` renders the existing categories **Breaking Changes**, **Features**, **Fixes**, **Changes**, **Documentation** and **Maintenance**, omitting empty categories. This borrows Keep a Changelog's editorial principles; it does not claim to implement that format's exact category vocabulary.

Each entry states a behavior change in one or two sentences, followed by source links. Exact configuration names use inline code. Larger implementation explanations belong in the linked PR or documentation. There is no mandatory highlights block repeating a short release's entries, and no generated downloads, signatures, release date or known-issues assertions.

The default heading contains only the version: the snapshot creation date is not the eventual publication date. Custom templates can still use `{{date}}`, which means the snapshot's UTC creation date. Generation timestamps remain available in the manifest.

Pure CI, test and refactoring changes are recorded in `excluded` with reasons rather than expanded into user-facing release notes. Changes to installation, delivered artifacts, supported platforms or runtime behavior remain eligible. The source coverage check still requires every change ID to be included or explicitly excluded.

Both the standalone version log and its block in the root Changelog receive the same rendered content. Regeneration replaces the current version's content and preserves historical versions.

## Editing and previewing

Edit `templates/changelog.md` for layout and `templates/changelog-policy.md` for editorial rules. Installed repositories own their copies under `.release-assistant/`; changing the bundled defaults does not overwrite those copies. Template v2 uses the existing renderer and JSON schema.

Use the tool repository's **Preview release notes** workflow to preview bundled templates against a fixed range. It checks out the workflow run's commit, so use a new run after changing these defaults. An installed **Prepare release** rerun instead reads the latest configured template ref and updates the same release PR, subject to the existing frozen-range checks.
