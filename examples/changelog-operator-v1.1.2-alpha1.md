## v1.1.2-alpha1

### Breaking Changes

- Member reconciliation now replaces the complete environment-variable list, removing variables patched directly into the DaemonSet unless declared in the Cluster configuration. ([#399](https://github.com/hwameistor/hwameistor-operator/pull/399))

### Features

- Added `localStorage.member.extraEnv` and the Cluster annotation `hwameistor.io/local-storage-member-extra-env` for member environment variables. Additions, updates and removals are reconciled on new and existing member DaemonSets. ([#399](https://github.com/hwameistor/hwameistor-operator/pull/399))

### Changes

- Changed the default Local Storage migration-check setting from `false` to `true`; reconciliation updates `--migrate-check` on new and existing member DaemonSets. ([#400](https://github.com/hwameistor/hwameistor-operator/pull/400))
- Changed migration image default `v1.0.4-01` → `v1.2.0`; added `localStorage.migrate.juicesync.version` (default `1.2.0`) to set member `JUICEFS_VERSION`. Using the companion fixes for directory-symlink copying and listing-error reporting requires updated Local Storage and migration images. ([#400](https://github.com/hwameistor/hwameistor-operator/pull/400)) **Needs review.**

### Upgrade Notes

- Before upgrading, move required direct DaemonSet environment edits into `localStorage.member.extraEnv` or the Cluster annotation as a valid JSON environment-variable array; preserve required container paths when extending `PATH`.
- Select the updated Operator through `operator.tag` and a compatible Local Storage build through `localStorage.member.tag`; both frozen chart defaults remain `v1.1.1`. Confirm image availability before rollout. To replace an older migration image, set `localStorage.migrate.juicesync.tag` (or Cluster `spec.localStorage.member.juicesyncImage.tag` without Helm) to `v1.2.0`; existing nonempty settings are preserved.
- To keep migration checks disabled, set `localStorage.migrate.check=false`, or `MIGRATE_CHECK=false` on the Operator Deployment without Helm.
- When selecting JuiceFS `1.4.1`, account for skipped FIFOs, sockets and device nodes that content checks cannot detect. SFTP copying does not preserve all filesystem metadata, and checks do not establish a consistent snapshot of active writes; stop source writes or use a consistent snapshot when required.
- Wait for the Local Storage rollout before creating migration Jobs; existing Jobs and their retry Pods retain their original templates.

[Full diff](https://github.com/hwameistor/hwameistor-operator/compare/e0b6bc166135f42c4afe5080983dd3e2e9d71949...6bb145fd0dc082f2d8ca9d77f72a8d978a65a5e8)
