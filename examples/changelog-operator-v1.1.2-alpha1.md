## v1.1.2-alpha1

### Release Changes

#### Breaking Changes

- Local Storage reconciliation now replaces the complete member environment list, removing variables patched directly into existing DaemonSets. ([#399](https://github.com/hwameistor/hwameistor-operator/pull/399))

#### Features

- Added `localStorage.member.extraEnv` for per-Cluster member environment overrides, including PATH extensions; additions, updates and removals reconcile existing DaemonSets. ([#399](https://github.com/hwameistor/hwameistor-operator/pull/399))

#### Changes

- Migration image changes `v1.0.4-01` → `v1.2.0` for directory-symlink SFTP errors; `localStorage.migrate.juicesync.version` selects JuiceFS (default `1.2.0`), requiring compatible Local Storage and migration images. ([#400](https://github.com/hwameistor/hwameistor-operator/pull/400)) **Needs review.**
- Migration checks now default to enabled (`false` → `true`) through `localStorage.migrate.check`, including existing member DaemonSets; `--check-all` requires the companion migration image. ([#400](https://github.com/hwameistor/hwameistor-operator/pull/400)) **Needs review.**

---

### Upgrade Actions

- **Direct DaemonSet overrides:** move required member environment variables into `localStorage.member.extraEnv` before upgrading.
- **Migration adopters:** select a companion-enabled `localStorage.member.tag` and published `localStorage.migrate.juicesync.tag=v1.2.0`; existing Jobs retain old templates, so create new Jobs for updated settings.
- **Alternate JuiceFS versions:** select an installed binary using `localStorage.migrate.juicesync.version`; avoid `1.4.1` when unchecked omission of FIFOs, sockets, devices or whiteouts is unacceptable.
- **Checks intentionally disabled:** set `localStorage.migrate.check=false` to retain that behavior.

[Full diff](https://github.com/hwameistor/hwameistor-operator/compare/e0b6bc166135f42c4afe5080983dd3e2e9d71949...6bb145fd0dc082f2d8ca9d77f72a8d978a65a5e8)
