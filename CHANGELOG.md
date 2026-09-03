# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions are published to npm and tagged `v*` on GitHub.

## [Unreleased]

## [0.1.8]

### Fixed
- The one-time-token launch URL fetch in `up` no longer races with the web
  startup print (it appears 2-4s after systemd reports "Started") and ignores
  stale, pre-token URL lines from older dsh versions still in the journal
  window: only the last `?token=` URL after the most recent unit start counts,
  retried up to 4x so the later print is caught.

## [0.1.7]

### Changed
- `up` now surfaces the dsh web launch URL: since dsh web 0.1.2-rc gates its
  UI behind a one-time token printed at startup, `up` fetches the unit journal
  and prints the token URL rewritten to the local tunnel port (`auth:` line),
  and `up --open` opens that URL. If the journal cannot supply it, `up` points
  you at `logs <host>`.
- READMEs document the new token flow.

## [0.1.6]

### Changed
- Config parse failures now raise the standard `TunnelError` with `E_CONFIG`
  (hint-aware error formatting) instead of an ad-hoc error class.
- Web-profile detection relies solely on the host-provided `webStartup`
  context instead of sniffing `process.argv`, so renamed or copied web
  profiles route correctly.

This is the final planned release of the current roadmap — the plugin enters
maintenance mode (compatibility checks on dsh upgrades, fixes on demand).

## [0.1.5]

### Changed
- `audit --clean-stale` rewrites every stale row in **one** flock+awk pass —
  N stale rows now cost one ssh round-trip instead of N (same mktemp + in-place
  write semantics as the single-row update; verified against both gawk and mawk).
- Local port-exhaustion diagnostics use **one** netstat + **one** tasklist
  (or one lsof) for the whole port range, instead of a process spawn per port.
- `peerDependencies`/`devDependencies` aligned to `@deepseek-ai/dsh-cmdline
  ^0.1.2-alpha.3` — removes the UNMET PEER warning (and possible duplicate
  dsh-cmdline install) against current harness alpha releases.
- `test/` is no longer shipped in the npm package.

### Added
- English registry-format doc (`docs/registry-format.en.md`); READMEs link both.

### Fixed
- README troubleshooting row for the old Windows `ClearAllForwardings` issue
  no longer tells up-to-date users to upgrade (fixed since 0.1.1).

## [0.1.4]

### Changed
- Dependency management unified on **npm**: `package-lock.json` is committed
  and both CI and the publish workflow install reproducibly with `npm ci`
  (the publish runner is also pinned to Node 22.19, matching `engines`).

### Fixed
- Numeric CLI options (`--port`, `--local-port`, `--heartbeat`, `--lines`,
  `--release`) are validated now — `--port abc` or `--port 22.5` exits with a
  clear usage error instead of silently falling back to a default.
- systemd unit rendering hardened, verified against `systemd-analyze`:
  `Environment=` values and the `ExecStart` binary are quoted (spaces survive
  where the parser would otherwise split them), paths containing quotes or
  newlines are rejected up front with an actionable error, and
  `WorkingDirectory` keeps its native raw-value semantics (spaces fine,
  quotes never added — the parser takes the line remainder verbatim).

### Added
- `CHANGELOG.md` (this file).

## [0.1.3]

### Fixed
- Registry updates no longer require write access to the registry's
  **directory**: updates stage through `mktemp` and rewrite the file in place
  (`cat >` keeps inode, owner and group). In the shared-direct setup the
  registry can stay at `/etc/dsh-ports.tsv` with a root-only directory —
  verified on real Linux with two users sharing a `dshports`-owned file.
- The remote occupancy probe is now fed to `node` over stdin instead of being
  shell-quoted onto the command line.

### Added
- The multi-user docs now spell out that the admin must pre-create **both**
  the registry and its lock file, and that only those two files carry the
  group-write bit.

## [0.1.2]

### Fixed
- Registry updates rewritten in place so a member's heartbeat/down no longer
  replaces the file's inode (which leaked the writer's primary group and
  locked other `dshports` members out). Covered by a shared-direct regression
  test in the mock ssh suite.
- `open` / `up --open` now use the platform browser launcher (`open` on macOS,
  `cmd start` on Windows, `xdg-open` elsewhere) and report spawn failures
  instead of hiding them.
- `/remote up <host> --open` honors the flag instead of treating it as the
  host name.

### Added
- Heartbeats skip a beat while the previous ssh round-trip is still in
  flight, instead of stacking up.
- CI workflow runs the test suite on every push/PR (Node 22.19, matching
  `engines`).

## [0.1.1]

### Fixed
- The long-lived tunnel no longer passes `ClearAllForwardings` (it also
  cleared the tunnel's own `-L` forward on Windows OpenSSH).
- Cross-platform process-tree kill (replaces the Windows-only `taskkill`
  call) so integration tests run everywhere.

### Added
- `up` cleans stale local tunnel state after a hard kill and reuses the
  still-registered remote port.
- English README; Chinese README stays as the original.

## [0.1.0] — initial release

Remote port allocation with a server-side registry, systemd supervision
(system or `--user` unit), resilient auto-reconnecting SSH tunnel, local URL
output, `check`/`audit` diagnostics, and the `/remote` slash commands for the
dsh web profile.
