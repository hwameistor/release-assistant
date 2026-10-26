## v1.1.2-alpha1

### Release Changes

#### Breaking Changes

- Local Storage reconciliation now replaces the complete member environment list, removing variables patched directly into existing DaemonSets. ([#399](https://github.com/hwameistor/hwameistor-operator/pull/399))

#### Features

- Added `localStorage.member.extraEnv` for per-Cluster member environment overrides, including PATH extensions; additions, updates and removals are reconciled on existing DaemonSets. ([#399](https://github.com/hwameistor/hwameistor-operator/pull/399))

#### Changes

- Changed the default migration image tag from `v1.0.4-01` to `v1.2.0` and added `localStorage.migrate.juicesync.version`, defaulting to `1.2.0`, for binary selection. Runtime selection and the companion directory-symlink SFTP fix require updated Local Storage and migration images. ([#400](https://github.com/hwameistor/hwameistor-operator/pull/400)) **Needs review.**
- Added `localStorage.migrate.check`, defaulting to `true`, changing member `--migrate-check` from `false` to `true` on new and existing DaemonSets. With the companion migration image, checked Jobs use `--check-all` instead of `--check-new`. ([#400](https://github.com/hwameistor/hwameistor-operator/pull/400)) **Needs review.**

---

### Upgrade Actions

- **Direct DaemonSet overrides:** move required member environment variables to `localStorage.member.extraEnv` before upgrading.
- **Adopting migration updates:** set `localStorage.member.tag` to an image containing the companion controller—the default remains `v1.1.1`—and update retained old `localStorage.migrate.juicesync.tag` settings to `v1.2.0`; existing Jobs retain their original templates.
- **Migration version overrides:** select only binaries installed in the image; avoid `1.4.1` when special-file omissions, including whiteouts, are unacceptable, as checks cannot detect them.
- **Checks intentionally disabled:** retain that behavior with `localStorage.migrate.check=false`.

[Full diff](https://github.com/hwameistor/hwameistor-operator/compare/e0b6bc166135f42c4afe5080983dd3e2e9d71949...6bb145fd0dc082f2d8ca9d77f72a8d978a65a5e8)
