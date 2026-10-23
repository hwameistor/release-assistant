## v1.1.2-alpha1

### Upgrade Notes

- Before upgrading, move any manually patched member environment variables into `localStorage.member.extraEnv` or the Cluster's `hwameistor.io/local-storage-member-extra-env` annotation.
- To keep migration checks disabled, set `localStorage.migrate.check=false`.
- Existing nonempty migration-image settings are preserved. To adopt image `v1.2.0`, update `spec.localStorage.member.juicesyncImage.tag` on the Cluster, or `localStorage.migrate.juicesync.tag` for a Helm-managed Cluster.

### Breaking Changes

- Local Storage reconciliation replaces the member container's environment with Operator-managed values and configured extras. Environment variables patched directly into the DaemonSet are removed. ([#399](https://github.com/hwameistor/hwameistor-operator/pull/399))

### Features

- Configure member environment variables per Cluster through `localStorage.member.extraEnv`. Additions, updates and removals are applied to existing member DaemonSets. ([#399](https://github.com/hwameistor/hwameistor-operator/pull/399))

### Changes

- Migration checks, previously disabled by default, are now enabled for new and existing Local Storage member DaemonSets, so users no longer need to enable them manually. ([#400](https://github.com/hwameistor/hwameistor-operator/pull/400))
- Select the migration binary through `localStorage.migrate.juicesync.version` to use an available version suited to your workloads without changing Operator code. The default is JuiceFS `1.2.0` in migration image `v1.2.0`. ([#400](https://github.com/hwameistor/hwameistor-operator/pull/400))

[Full diff](https://github.com/hwameistor/hwameistor-operator/compare/e0b6bc166135f42c4afe5080983dd3e2e9d71949...61fe6fbadf53a46e375208ca24c52af7c16c48b0)
