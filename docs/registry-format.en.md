# Remote port registry format

## Location and permissions

| Mode | Path | Permissions | Writes |
|---|---|---|---|
| shared (default, needs sudo) | `/etc/dsh-ports.tsv` + `/etc/dsh-ports.lock` | root-owned, 0644 (world-readable, not tamperable) | flock + append/rewrite under `sudo -n` |
| shared-direct | same | root:dshports group, 0664 | no sudo once members join the dshports group; still flock-protected |
| fallback (automatic without sudo) | `~/.dsh-ports.tsv` + `.lock` | 0644, private | direct writes under flock |

The plugin picks a mode in order — passwordless sudo available → shared file writable → fallback path — and shows the active file in `up`/`check` output.
Override in the plugin config: `defaults.registry.path / lockPath / sudo(auto|always|never) / fallbackPath`.

Only the two files themselves need the group-write bit in the shared-direct setup; the directory holding them stays root-only (updates stage through `mktemp` and rewrite the registry in place). The admin must pre-create both files — members cannot create the lock inside a root-only directory (see README "Sharing one server (multi-user)").

## File format

- **TSV** (tab-separated), UTF-8, one row per line; first line is a header, `#` lines are comments.
- Field values must not contain tabs or newlines (sanitized by the plugin before writing).

```
port	user	workspace	source	created_at	last_heartbeat	status
3080	alice	/home/alice/project	win-pc-01	2026-01-10T09:30:00Z	2026-01-10T10:15:00Z	in-use
3081	bob	/home/bob	win-pc-02	2026-01-10T10:05:00Z	2026-01-10T10:05:00Z	released
```

| Column | Meaning |
|---|---|
| `port` | allocated remote port (listens on 127.0.0.1 on the server) |
| `user` | owner identity (server login account) |
| `workspace` | workspace directory of that instance (the web file root) |
| `source` | origin (hostname of the machine that allocated it) |
| `created_at` | allocation time (ISO 8601 UTC) |
| `last_heartbeat` | last heartbeat time (refreshed periodically while the tunnel lives) |
| `status` | `in-use` / `released` |

## Write rules

- **Allocation (atomic)**: inside one `flock` — read the in-use set, probe-bind every port in the range, pick the first port that is both unregistered and unbound, append an in-use row, echo the port. Concurrent allocators never get the same port.
- **Heartbeat**: inside `flock`, `awk` updates the row's `last_heartbeat` in place (in-use rows only).
- **Release**: inside `flock`, the row's `status` becomes `released`.
- **Cleanup**: `audit --clean-stale` flips rows that are registered in-use but no longer listened on to `released`; rows are kept for auditability.

## Audit

`dsh --profile remote audit <host>` compares the registry against real occupancy:

- `ok` — in-use and the port really listens (owned by the registered user)
- `stale` — registered in-use but nobody listens
- `conflict` — the port listens, but the process owner differs from the registered user
- `orphan` — registered released but something still listens

`audit --release <port>` releases one port manually; `audit --clean-stale` cleans every stale row in one pass.
