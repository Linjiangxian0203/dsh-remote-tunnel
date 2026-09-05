# dsh-remote-tunnel

[中文](README.zh.md) | English

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

**Remote Host Tunnel Manager**: automates the "local browser → dsh web on a remote Linux server" link — remote port allocation with a registry, systemd supervision, resilient SSH tunneling, local URL output, and full lifecycle management. Built for single users and for teams sharing one server.

- Sessions and files live **on the server** (the remote dsh web's workspace = server directories); the local machine only keeps a tunnel
- Each user automatically gets a **dedicated remote port**, double-checked on the server (real occupancy + registry) before allocation — safe under concurrency
- Every allocation is **recorded in a registry on the server** (`/etc/dsh-ports.tsv`, or a per-user fallback depending on permissions) — `audit` compares the registry against real occupancy at any time
- The tunnel **auto-reconnects** after network drops (backoff respawn), and heartbeats keep the registry fresh
- Occupied local ports shift automatically, with the occupying process reported

## If you're just a user (not developing)

```powershell
# 1. Install (published npm package)
dsh plugin --profile remote add dsh-remote-tunnel
#    want it in the web UI too (Settings → Plugins) with /remote slash commands in chat?
#    also install into the web profile, then restart dsh web:
dsh plugin --profile web add dsh-remote-tunnel

# 2. Confirm your server is visible (Host aliases from ~/.ssh/config are auto-discovered)
dsh --profile remote hosts
#    not there? define one:
dsh --profile remote hosts add lab --host 192.0.2.10 --user alice --workspace /home/alice/project

# 3. First run: a health check tells you step by step what's missing
#    (keys / Node / dsh / registry / systemd)
dsh --profile remote check lab

# 4. Bring the tunnel up; the browser opens the remote dsh web
dsh --profile remote up lab --open

# Everyday: status / down / logs / audit
dsh --profile remote down lab
```

The remote server needs: Node ≥ 22.19, dsh, systemd, and key-based ssh login. **Every account** (each labmate's own user) prepares its own environment once — idempotent, runs as whoever the ssh alias logs in as:
`dsh --profile remote bootstrap lab` (same script, manual: `ssh <host> 'sh -s' < scripts/bootstrap-remote.sh`). Everything else lives in `$DSH_HOME/remote-tunnel/config.yaml` — sensible defaults, no changes needed.

> The `remote` CLI profile is the main interface. Installing into the **web** profile is what makes the plugin appear under **Settings → Plugins** and enables the `/remote` slash commands in chat — restart `dsh web` once after adding it there.

## Requirements

- Local: Windows/macOS/Linux with the built-in OpenSSH client (Windows 10+ ships it), **Node ≥ 22.19**
- Remote: Linux, Node ≥ 22.19 + dsh (installable per account via `dsh --profile remote bootstrap <host>` or `scripts/bootstrap-remote.sh` — each user runs it once for their own account), systemd (user-level is enough — no root needed)
- Recommended: passwordless ssh key login (`ssh <alias>` connects without prompts)

## Install (development)

```powershell
# 1. Install into a dedicated CLI profile (initializes the profile on first use)
cd <plugin checkout>       # or the npm package name: dsh-remote-tunnel
dsh plugin --profile remote add .

# 2. Install into the web profile so the plugin shows up in the web UI
#    (Settings → Plugins) and /remote slash commands work in chat;
#    restart dsh web afterwards
dsh plugin --profile web add .
```

## Quick start

```powershell
# Hosts from ~/.ssh/config are auto-discovered
dsh --profile remote hosts

# Or define one manually (when there is no ~/.ssh/config entry)
dsh --profile remote hosts add lab --host 192.0.2.10 --user alice --workspace /home/alice/project

# Readiness diagnostics: keys / Node / dsh / registry / systemd, item by item
dsh --profile remote check lab

# check says Node/dsh are missing? Install them for the account you log in as
# (idempotent; each labmate runs it once for their own user)
dsh --profile remote bootstrap lab
#     --upgrade forces dsh to the latest version

# One command: allocate remote port → register → write systemd unit → start
# remote dsh web → open the local tunnel
dsh --profile remote up lab --open

# Example output:
#   allocated remote port 3081 (range 3080-3119, registered for alice)
#   ✓ tunnel up — http://127.0.0.1:3083 (remote lab:3081)
#   stop: dsh --profile remote down lab   (or Ctrl+C)

# Inspect / stop / review
dsh --profile remote status lab
dsh --profile remote logs lab            # remote dsh web logs (journalctl)
dsh --profile remote audit lab           # registry vs. real occupancy
dsh --profile remote down lab            # stop tunnel + registry released + stop unit + verify port freed
```

The local URL opens the dsh web **on the server**: chat and read/write server files. Configure the API key in the remote web's Settings → Models (written to the server's `~/.dsh/.credentials.yaml` — this plugin and the tunnel never touch credentials).

## Commands

```
hosts / hosts add <alias> --host H [--port 22] [--user U] [--workspace DIR] / hosts rm <alias>
check <host>                     readiness diagnostics (usable as a CI probe: nonzero exit = broken)
bootstrap <host> [--upgrade]     prepare the ssh account: Node/dsh (~/.npm-global)/~/.dsh/linger (idempotent)
provision <host> [--port N]      remote side only: allocate + systemd unit + start + register (no tunnel)
up <host> [--port N] [--local-port N] [--open] [--heartbeat seconds]
down [host] [--keep-service]     stop tunnel + released + stop unit + verify port freed
status [host] [--json]
list
logs <host> [--lines N] [--follow] [--local]
audit <host> [--json] [--release <port>] [--clean-stale]
open [host]
config show / config path
```

## How it works

1. **Remote port allocation (atomic)**: one remote script runs under a `flock` lock — read the registry's in-use set + probe every port in the range with a real bind → pick the first port free on both sides → append a TSV row → echo the port. Concurrent allocators can never hand out the same port.
2. **Remote supervision**: writes a systemd unit and `enable --now`s it. With passwordless sudo it uses a **system** unit (`/etc/systemd/system/dsh-web-<user>.service`); without sudo it automatically falls back to a **user** unit (`~/.config/systemd/user/dsh-web.service`) plus `loginctl enable-linger` — no root required at all. Survives reboots and crashes.
3. **TOCTOU fallback**: if dsh loses a bind race at startup (`EADDRINUSE` shows up in the unit journal), the port is added to the exclusion set and the next free port is retried (up to 5 rounds by default).
4. **Local tunnel**: `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote> <alias>`; the local port is checked first (shifts automatically when occupied, with `netstat`+`tasklist` naming the occupier). When the ssh process exits, it respawns with a backoff sequence (1s→2s→4s→8s→15s→30s cap), forever by default (`maxAttempts` configurable). The tunnel deliberately does **not** pass `ClearAllForwardings` (Windows OpenSSH would clear the command-line `-L` along with it); exec sessions still clear config forwards.
5. **Heartbeat**: while the tunnel lives, the registry's `last_heartbeat` is refreshed in-place under the lock every `heartbeatSeconds` (default 120).
6. **Release**: `down` (or Ctrl+C on `up`) runs in order: stop tunnel → remove local state → registry `released` → stop the remote unit → verify the port is really free. An `up` supervisor in another process notices the removed state file and stops reconnecting — no resurrection. Closing the terminal hard (without Ctrl+C) leaves the remote service running and the registry row `in-use` — which is accurate, not a leak: the next `up` cleans the stale local state and **reuses the same registered port** (no accumulation).

## Configuration

`$DSH_HOME/remote-tunnel/config.yaml` (`dsh --profile remote config path` prints the path):

```yaml
hosts:
  lab:                      # manually defined hosts (merged with ~/.ssh/config aliases; wins on name collision)
    host: 192.0.2.10
    port: 22
    user: alice
    workspace: /home/alice/project
    remotePortRange: [3080, 3119]   # optional per-host override
defaults:
  remotePortRange: [3080, 3119]     # remote dsh port range (occupancy-checked before allocation)
  localPortRange: [3081, 3140]      # local tunnel port range
  registry:
    path: /etc/dsh-ports.tsv
    lockPath: /etc/dsh-ports.lock
    sudo: auto                      # auto | always | never
    fallbackPath: .dsh-ports.tsv    # used when the shared registry is not writable (relative = remote home)
  unit:
    prefix: dsh-web-
    restartSec: 5
    type: auto                      # auto | system | user
  heartbeatSeconds: 120             # 0 = disable heartbeats
  remoteWaitSeconds: 60             # wait for the remote port to listen
  localWaitSeconds: 15              # wait for the local URL to respond
  reconnect:
    delaysMs: [1000, 2000, 4000, 8000, 15000, 30000]
    maxAttempts: 0                  # 0 = never give up
  allocateRetries: 5
  ssh:
    connectTimeout: 0               # 0 = do not pass -o ConnectTimeout (see Troubleshooting)
    extraArgs: []
```

## Sharing one server (multi-user)

| Server setup | Registry | Supervision |
|---|---|---|
| Members have passwordless sudo | `/etc/dsh-ports.tsv` (sudo writes) | system unit, one port per user |
| No sudo, admin created a dshports group | `/etc/dsh-ports.tsv` (group 0664, no sudo) | user unit + linger |
| Nothing configured (default) | falls back to `~/.dsh-ports.tsv` (own rows only; `check` points at the admin setup) | user unit + linger |

**Each account prepares its own environment** (N users on one server = N idempotent runs):

```powershell
dsh --profile remote bootstrap <host>     # from each user's own machine
```

This installs Node / dsh (into **that account's own** `~/.npm-global`) / `~/.dsh` / linger without touching any other account — session history is per-account too.

One-time admin setup for the shared registry (either):

```bash
# A. every member has passwordless sudo
sudo install -m 0644 -o root -g root /dev/null /etc/dsh-ports.tsv
sudo install -m 0644 -o root -g root /dev/null /etc/dsh-ports.tsv.lock

# B. members have no sudo: shared group writes
sudo groupadd dshports && sudo usermod -aG dshports alice bob ...
sudo install -m 0664 -o root -g dshports /dev/null /etc/dsh-ports.tsv
sudo install -m 0664 -o root -g dshports /dev/null /etc/dsh-ports.tsv.lock
# each member's plugin config: registry.sudo: never
```

Both files are required up front: they sit in a root-only directory, so a
member cannot create the lock themselves and every operation takes it.
In setup B only those two files carry the group-write bit (`0664`) — the
directory stays root-only, which is fine: each registry update stages through
a per-user `mktemp` file and rewrites the registry in place, never touching
the directory nor changing the file's owner/group.

Each user runs `up` independently and gets a different remote port; `audit` shows who holds which port and flags stale/conflicting rows.

## Remote bootstrap (per account)

`dsh --profile remote bootstrap <host>` prepares **the account the ssh alias logs in as**: Node ≥ 22.19 (when installable), dsh into that account's `~/.npm-global`, `~/.dsh`, systemd lingering and the npm-global PATH entries — idempotent, so each labmate runs it once for their own user. `--upgrade` forces dsh to the latest version.

```powershell
dsh --profile remote bootstrap lab              # prepare the current account
dsh --profile remote bootstrap lab --upgrade    # update remote dsh to the latest
```

The same script ships as `scripts/bootstrap-remote.sh` for manual use (identical behavior):

```bash
ssh <host> 'sh -s' < scripts/bootstrap-remote.sh
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `dsh not found` / `node not found` (check or up) | The ssh account has no Node/dsh yet — the plugin works per account. `dsh --profile remote bootstrap <host>` installs them for whoever you log in as (idempotent; `--upgrade` refreshes). Even when the ssh channel's PATH misses `~/.npm-global`, the plugin now probes that path directly. |
| `Error: listen EADDRINUSE ... 127.0.0.1:3080` | Someone (or your previous instance) holds the port. This plugin double-checks before allocation and retries the next port automatically on a startup race; you only see this when starting dsh by hand. |
| `Could not resolve hostname <alias>` | The alias is neither in `~/.ssh/config` nor in the plugin config. `hosts add` or add it to ssh config. |
| `Connection refused` / `remote port forwarding failed` | The remote dsh web is down or on the wrong port. `check <host>` → "web port listening"; `logs <host>` for the remote journal; `ss -tln \| grep <port>` on the server. |
| `channel_setup_fwd_listener_tcpip: cannot listen to port` | The local port is taken (common: two dsh web instances). The plugin shifts automatically and names the occupying process; or pass `--local-port`. |
| `Permission denied (publickey)` / `sudo: a password is required` | Keys not set up / no NOPASSWD sudo. `ssh-copy-id` for the former; the latter is optional — the user-unit + fallback-registry path works without sudo. |
| `Could not create directory '/home/xxx/.ssh'` + host key prompt | First connection needs the host key accepted; the plugin passes `accept-new` (TOFU) by default. |
| Tunnel does not come back after a network drop | Reconnection is infinite by default; `status` shows whether the ssh pid is alive and `logs <host> --local` shows reconnect activity. If `reconnect.maxAttempts` is set, it stops at the cap. |
| Tunnel stays connected but the local URL stays `not reachable` | On Windows OpenSSH 8.1, `-o ClearAllForwardings=yes` also cleared the command-line `-L`, so the tunnel connected without forwarding. **Fixed since 0.1.1**: the tunnel no longer passes that option (exec sessions still do). |
| Opening the tunnel URL shows `dsh web authentication required; reopen the URL printed by dsh web.` | dsh web ≥ 0.1.2-rc gates its UI behind a one-time token in the launch URL it prints at startup. `up` now prints that URL (rewritten to your local port) as the `auth:` line. If it expired (the service restarted), copy the `dsh web: http://…?token=…` line out of `logs <host>` into your address bar. |
| Registry unreadable (`/etc/dsh-ports.tsv missing`) | Created automatically on first allocation (requires write permission); without it the plugin falls back to `~/.dsh-ports.tsv` and `check` prints the admin setup command. |
| Every ssh command is slow (~N seconds each) | On some servers, passing `ConnectTimeout` to ssh makes every connection wait out the full timeout even when the connect is instant. The default no longer passes it (`ssh.connectTimeout: 0`); enable it explicitly if you need it. |

## Development and testing

```bash
npm install             # plugin dependencies (package-lock.json is committed)
npm test                # unit tests + mock-ssh integration tests (no real server needed)
```

The integration suite uses a fake `ssh` that interprets the plugin's remote commands against a temp "server" (with real TCP forwarding for the tunnel), covering: allocate/register/release, concurrent allocation by multiple users, TOCTOU retry, local port conflict shift, auto-reconnect, cross-process down cancellation, audit stale/orphan/clean.

## Security notes

- The tunnel and the remote dsh bind `127.0.0.1` only (dsh itself rejects `--host 0.0.0.0`)
- The plugin never stores or transmits passwords, keys, or API keys; ssh always uses existing keys (BatchMode — no password prompts, no hangs)
- The registry records no sensitive information (see [`docs/registry-format.en.md`](docs/registry-format.en.md) · [中文](docs/registry-format.md))
- Remote scripts only append/rewrite the registry and the systemd unit under `flock`; no other writes

## Non-goals

- No SSH/SFTP/remote-mount implementation: the design is "run dsh on the server"; the tunnel only brings HTTP back locally
- No new TUI: CLI subcommands + the web profile's `/remote` slash commands
