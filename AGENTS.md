# AGENTS.md — how to work in this repository

Read this first. The breakpoint document for the current round is
[`docs/desktop-panel-progress.md`](docs/desktop-panel-progress.md); the plan for the round in
flight is [`docs/desktop-panel-0.2.1-plan.md`](docs/desktop-panel-0.2.1-plan.md).

## 1. Never publish this machine's SSH details — owner's standing rule (2026-10-03)

Nothing that identifies the owner's machines, accounts or filesystem may reach a committed file,
a test fixture, a document, a screenshot or an npm package. That includes, explicitly:

- ssh aliases and server addresses / IPs / ports;
- `~/.ssh/config` or `known_hosts` contents — **not even one line, not even as test data**;
- local absolute paths (the workspace root, the DSH data directory, remote home directories);
- remote hostnames, credentials, tokens, key file names.

Use documentation placeholders instead: `lab`, `192.0.2.10` (RFC 5737), `<repo>`, `<DSH_HOME>`,
`<server>`, `<user>`. Real values live in the owner's local notes (git-ignored) and nowhere else —
the exact list to scan for is kept locally in `docs/local-privacy-check.md`; extend that file rather
than committing the values.

Before every commit, scan what would ship:

```powershell
git grep -n -E '[0-9]{1,3}(\.[0-9]{1,3}){3}|[A-Za-z]:[\\/]|/home/[a-z]' -- src test locale scripts README.md README.zh.md CHANGELOG.md
```

Everything it prints is either a placeholder (`192.0.2.x`) or a leak: decide, do not guess.

Packaging follows the same rule. `docs/.npmignore` keeps the local-history documents
(progress / plan / route) out of the tarball, because they record this machine by design. Keep that
list current and re-run `npm pack --dry-run` whenever the packaged file set changes — **`.gitignore`
does not keep a file out of an npm package**, and a **root** `.npmignore` does not override
`package.json`'s `files` field (only one inside a subdirectory does).

## 2. Mechanics that bite in this project

- **The desktop profile installs this repository as a Junction**, so the GUI runs whatever is checked
  out here: `git checkout` changes what the app loads.
- **A client bundle's `rev` is `sha1(mtimeMs + ctimeMs + size)`** (`@deepseek-ai/dsh-client-modules`):
  editing `src/client.js` invalidates it for a running host (the bundle answers 404) until that host
  restarts. Verify with a restart — a page refresh is not enough.
- **Registration lifetime**: `ctx.effect(() => ctx.sidebarRightTabs.register(def), label)`; the pane body
  is `ctx.slots.register({ name: "sidebar.right.pane.tab", key: definition.id }, Body)`. From *inside*
  the sidebar, open tabs through `tab.actions.openTab(...)`, not `ctx.sidebarRight.openTab` (that one is
  the outside opener the card and the dock use).
- **A pane component must not reach into `apply`-scope helpers** — doing so was a silent
  `ReferenceError` that made a button do nothing. Factory-scope components go through the seam
  `openTabFromPane`, which `apply` installs.
- **Routes** live under `/remote-tunnel/`, pass `ctx.connection.admit()`, and every write requires
  `confirm=1`.
- **Environment**: the workspace's `node.exe` may only write inside the workspace; use the desktop CLI
  shim rather than the PATH one, run npm with `--cache <workspace>/_npmcache`, and point `TEMP`/`TMP`
  at `<workspace>/_tmp` before the integration suite (otherwise `mkdtemp` fails). The concrete paths
  are in the owner's local notes.
- **Release flow**: branch → tests green → user acceptance on the real desktop app → `merge --ff-only`
  to `main` → `git tag -a vX.Y.Z` → `git push origin vX.Y.Z` → CI runs `publish.yml`
  (`npm ci`, full tests, `npm publish`, attach `.github/releases/vX.Y.Z.md`). The registry takes about a
  minute to show a fresh version — that is not a failure.
