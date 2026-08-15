# dsh-remote-tunnel

[中文](README.zh.md) | English

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

The remote server needs: Node ≥ 22.19, dsh, systemd, and key-based ssh login. One command initializes it:
`ssh <host> 'sh -s' < scripts/bootstrap-remote.sh`. Everything else lives in `$DSH_HOME/remote-tunnel/config.yaml` — sensible defaults, no changes needed.

## Requirements

- Local: Windows/macOS/Linux with the built-in OpenSSH client (Windows 10+ ships it), **Node ≥ 22.19**
- Remote: Linux, Node ≥ 22.19 + dsh (installable via `scripts/bootstrap-remote.sh`), systemd (user-level is enough — no root needed)
- Recommended: passwordless ssh key login (`ssh <alias>` connects without prompts)

## Install (development)

```powershell
# 1. Install into a dedicated CLI profile (initializes the profile on first use)
cd <plugin checkout>       # or the npm package name: dsh-remote-tunnel
dsh plugin --profile remote add .

# 2. Optional: install into the web profile to get the /remote slash commands
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
4. **Local tunnel**: `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote> <alias>`; the local port is checked first (shifts automatically when occupied, with `netstat`+`tasklist` naming the occupier). When the ssh process exits, it respawns with a backoff sequence (1s→2s→4s→8s→15s→30s cap), forever by default (`maxAttempts` configurable).
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

One-time admin setup for the shared registry (either):

```bash
# A. every member has passwordless sudo
sudo install -m 0644 -o root -g root /dev/null /etc/dsh-ports.tsv

# B. members have no sudo: shared group writes
sudo groupadd dshports && sudo usermod -aG dshports alice bob ...
sudo install -m 0664 -o root -g dshports /dev/null /etc/dsh-ports.tsv
# each member's plugin config: registry.sudo: never
```

Each user runs `up` independently and gets a different remote port; `audit` shows who holds which port and flags stale/conflicting rows.

## Remote bootstrap (optional)

`scripts/bootstrap-remote.sh` installs Node (when missing) / dsh (into `~/.npm-global`) / creates `~/.dsh` / enables linger:

```bash
ssh <host> 'sh -s' < scripts/bootstrap-remote.sh
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Error: listen EADDRINUSE ... 127.0.0.1:3080` | Someone (or your previous instance) holds the port. This plugin double-checks before allocation and retries the next port automatically on a startup race; you only see this when starting dsh by hand. |
| `Could not resolve hostname <alias>` | The alias is neither in `~/.ssh/config` nor in the plugin config. `hosts add` or add it to ssh config. |
| `Connection refused` / `remote port forwarding failed` | The remote dsh web is down or on the wrong port. `check <host>` → "web port listening"; `logs <host>` for the remote journal; `ss -tln \| grep <port>` on the server. |
| `channel_setup_fwd_listener_tcpip: cannot listen to port` | The local port is taken (common: two dsh web instances). The plugin shifts automatically and names the occupying process; or pass `--local-port`. |
| `Permission denied (publickey)` / `sudo: a password is required` | Keys not set up / no NOPASSWD sudo. `ssh-copy-id` for the former; the latter is optional — the user-unit + fallback-registry path works without sudo. |
| `Could not create directory '/home/xxx/.ssh'` + host key prompt | First connection needs the host key accepted; the plugin passes `accept-new` (TOFU) by default. |
| Tunnel does not come back after a network drop | Reconnection is infinite by default; `status` shows whether the ssh pid is alive and `logs <host> --local` shows reconnect activity. If `reconnect.maxAttempts` is set, it stops at the cap. |
| Registry unreadable (`/etc/dsh-ports.tsv missing`) | Created automatically on first allocation (requires write permission); without it the plugin falls back to `~/.dsh-ports.tsv` and `check` prints the admin setup command. |
| Every ssh command is slow (~N seconds each) | On some servers, passing `ConnectTimeout` to ssh makes every connection wait out the full timeout even when the connect is instant. The default no longer passes it (`ssh.connectTimeout: 0`); enable it explicitly if you need it. |

## Development and testing

```bash
pnpm install            # plugin dependencies
npm test                # unit tests + mock-ssh integration tests (no real server needed)
```

The integration suite uses a fake `ssh` that interprets the plugin's remote commands against a temp "server" (with real TCP forwarding for the tunnel), covering: allocate/register/release, concurrent allocation by multiple users, TOCTOU retry, local port conflict shift, auto-reconnect, cross-process down cancellation, audit stale/orphan/clean.

## Security notes

- The tunnel and the remote dsh bind `127.0.0.1` only (dsh itself rejects `--host 0.0.0.0`)
- The plugin never stores or transmits passwords, keys, or API keys; ssh always uses existing keys (BatchMode — no password prompts, no hangs)
- The registry records no sensitive information (see `docs/registry-format.md`)
- Remote scripts only append/rewrite the registry and the systemd unit under `flock`; no other writes

## Non-goals

- No SSH/SFTP/remote-mount implementation: the design is "run dsh on the server"; the tunnel only brings HTTP back locally
- No new TUI: CLI subcommands + the web profile's `/remote` slash commands
