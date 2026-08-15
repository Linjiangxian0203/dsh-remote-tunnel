import { execRemote, canSudo, sudoPrefix } from "../ssh.js";
import { TunnelError } from "../errors.js";

// Remote port registry: /etc/dsh-ports.tsv (root-owned 0644, world-readable).
// TSV with one row per allocation:
//   port  user  workspace  source  created_at  last_heartbeat  status
// Writes are flock-protected (lock file beside the registry), appended via
// sudo when available. Allocation is ONE remote atomic operation:
//   flock → (registry in-use rows ∪ real bind probe) → first free port →
//   append row → echo port
// so concurrent allocators on the same server can never hand out the same
// port twice.

export const REGISTRY_COLUMNS = ["port", "user", "workspace", "source", "created_at", "last_heartbeat", "status"];

export function sanitizeField(value) {
  return String(value ?? "").replace(/[\t\n\r]+/g, " ").trim();
}

/** Parse registry TSV text; header/comment lines are skipped. */
export function parseTsv(text) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length < REGISTRY_COLUMNS.length) continue;
    if (fields[0] === "port" && fields[REGISTRY_COLUMNS.length - 1] === "status") continue;
    rows.push({
      port: Number.parseInt(fields[0], 10),
      user: fields[1],
      workspace: fields[2],
      source: fields[3],
      createdAt: fields[4],
      lastHeartbeat: fields[5],
      status: fields[6]
    });
  }
  return rows;
}

/** The remote node probe: first free port in [lo,hi] not in-use in the registry and not excluded. */
const ALLOCATE_NODE_PROBE = `const net = require("net");
const fs = require("fs");
const a = process.argv.slice(1);
const lo = +a[0], hi = +a[1], reg = a[2];
const exclude = new Set(a[3] ? a[3].split(",").map(Number) : []);
let used = new Set();
try {
  const text = fs.readFileSync(reg, "utf8");
  for (const line of text.split("\\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const f = t.split("\\t");
    if (f.length >= 7 && f[6] === "in-use" && /^\\d+$/.test(f[0])) used.add(+f[0]);
  }
} catch (e) {}
const ports = [];
for (let p = lo; p <= hi; p++) if (!used.has(p) && !exclude.has(p)) ports.push(p);
let pending = ports.length;
const free = [];
if (pending === 0) process.exit(3);
function finish() {
  if (free.length === 0) process.exit(3);
  process.stdout.write(String(Math.min.apply(null, free)));
  process.exit(0);
}
for (const p of ports) {
  const s = net.createServer();
  s.once("error", function () { pending -= 1; if (pending === 0) finish(); });
  s.once("listening", function () { free.push(p); s.close(function () { pending -= 1; if (pending === 0) finish(); }); });
  s.listen(p, "127.0.0.1");
}`;

// $1=REG $2=LO $3=HI $4=USER $5=WS $6=SRC $7=NOW $8=EXCLUDE(comma list or "-")
const ALLOCATE_SHELL = `set -eu
REG=$1; LO=$2; HI=$3; USER_=$4; WS=$5; SRC=$6; NOW=$7; EXC=$8
[ "$EXC" = "-" ] && EXC=""
NODE_PROG='PLACEHOLDER_NODE_PROBE'
[ -s "$REG" ] || printf 'port\\tuser\\tworkspace\\tsource\\tcreated_at\\tlast_heartbeat\\tstatus\\n' > "$REG"
chosen=$(node -e "$NODE_PROG" "$LO" "$HI" "$REG" "$EXC") || { echo "dsh-remote-tunnel: no free port in $LO-$HI" >&2; exit 3; }
printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$chosen" "$USER_" "$WS" "$SRC" "$NOW" "$NOW" "in-use" >> "$REG"
printf '%s' "$chosen"`;

// $1=REG $2=PORT $3=USER $4=COL(6|7) $5=VAL
const UPDATE_SHELL = `set -eu
REG=$1; PORT=$2; USER_=$3; COL=$4; VAL=$5
TMP="$REG.tmp.$$"
awk -F '\\t' -v OFS='\\t' -v port="$PORT" -v user="$USER_" -v col="$COL" -v val="$VAL" '
  { if ($1 == port && $2 == user) { if (col == "7") $7 = val; else $6 = val; } print }
' "$REG" > "$TMP"
mv "$TMP" "$REG"`;

const OCCUPANCY_NODE_PROBE = `const net = require("net");
const ports = process.argv.slice(1).map(Number);
const out = [];
let pending = ports.length;
if (pending === 0) process.exit(0);
function maybeFinish() { if (pending === 0) { process.stdout.write(out.sort(function (a, b) { return a - b; }).join("\\n")); process.exit(0); } }
for (const p of ports) {
  const c = net.connect(p, "127.0.0.1");
  c.setTimeout(2000);
  c.on("connect", function () { out.push(p); c.destroy(); pending -= 1; maybeFinish(); });
  c.on("timeout", function () { c.destroy(); pending -= 1; maybeFinish(); });
  c.on("error", function () { pending -= 1; maybeFinish(); });
}`;

function flockArgs(registry) {
  return [...registry.sudo, "flock", "-w", "30", registry.lockPath, "sh", "-s", "--"];
}

/**
 * Resolve which registry file to use on this host:
 *   shared         /etc/dsh-ports.tsv written via passwordless sudo
 *   shared-direct  /etc/dsh-ports.tsv writable by this account (dshports group)
 *   fallback       <remote home>/.dsh-ports.tsv (no shared file available yet)
 */
export async function resolveRegistry(hostDef, cfg, ctx, facts) {
  const r = cfg.defaults.registry;
  if (r.sudo === "always") {
    return { path: r.path, lockPath: r.lockPath, sudo: ["sudo", "-n"], kind: "shared" };
  }
  if (ctx.sudoState.canSudo === undefined) ctx.sudoState.canSudo = await canSudo(hostDef, cfg);
  if (ctx.sudoState.canSudo) {
    return { path: r.path, lockPath: r.lockPath, sudo: ["sudo", "-n"], kind: "shared" };
  }
  if (r.sudo !== "never") {
    const probe = await execRemote(hostDef, `test -w "${r.path}" && test -r "${r.path}" && echo yes || echo no`, { cfg, timeoutMs: 20000 });
    if (probe.stdout.trim() === "yes") {
      return { path: r.path, lockPath: r.lockPath, sudo: [], kind: "shared-direct" };
    }
  }
  const fallback = r.fallbackPath ?? ".dsh-ports.tsv";
  const path = fallback.startsWith("/") ? fallback : `${facts.home}/${fallback}`;
  return { path, lockPath: `${path}.lock`, sudo: [], kind: "fallback" };
}

/** Read the registry (world-readable, no sudo). */
export async function remoteReadRegistry(hostDef, cfg, ctx, registry) {
  const result = await execRemote(hostDef, `cat "${registry.path}" 2>/dev/null || true`, { cfg, timeoutMs: 30000 });
  if (result.code !== 0) {
    throw new TunnelError(`cannot read registry: ${result.stderr.trim() || `exit ${result.code}`}`, { code: "E_REGISTRY_READ" });
  }
  return parseTsv(result.stdout);
}

/**
 * Atomically allocate one free remote port and register it.
 * @returns the allocated port number.
 */
export async function remoteAllocate(hostDef, cfg, ctx, registry, { range, user, workspace, source, exclude = [] }) {
  const now = new Date().toISOString();
  const script = ALLOCATE_SHELL.replace("PLACEHOLDER_NODE_PROBE", ALLOCATE_NODE_PROBE.replace(/'/g, `'\\''`));
  const args = [
    ...flockArgs(registry),
    registry.path,
    String(range[0]), String(range[1]),
    sanitizeField(user), sanitizeField(workspace), sanitizeField(source),
    now,
    exclude.length > 0 ? exclude.join(",") : "-"
  ];
  const result = await execRemote(hostDef, args.join(" "), { cfg, stdin: script, timeoutMs: 90000 });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    if (detail.includes("no free port")) {
      throw new TunnelError(`no free port in remote range ${range[0]}-${range[1]}`, { code: "E_NO_FREE_REMOTE_PORT" });
    }
    if (detail.includes("sudo")) {
      throw new TunnelError(`registry write failed (sudo required?): ${detail}`, { code: "E_REGISTRY_WRITE", hint: "grant passwordless sudo for the registry, or use the dshports group 0664 setup (see README)" });
    }
    throw new TunnelError(`remote port allocation failed: ${detail}`, { code: "E_ALLOCATE" });
  }
  const port = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isInteger(port)) throw new TunnelError(`unexpected allocator output: ${JSON.stringify(result.stdout)}`, { code: "E_ALLOCATE" });
  return port;
}

/** Update one registry field (6 = last_heartbeat, 7 = status) under flock. */
export async function remoteUpdateRegistry(hostDef, cfg, ctx, registry, { port, user, field, value }) {
  const args = [
    ...flockArgs(registry),
    registry.path,
    String(port), sanitizeField(user),
    field === "status" ? "7" : "6",
    sanitizeField(value)
  ];
  const result = await execRemote(hostDef, args.join(" "), { cfg, stdin: UPDATE_SHELL, timeoutMs: 60000 });
  if (result.code !== 0) {
    throw new TunnelError(`registry update failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`, { code: "E_REGISTRY_WRITE" });
  }
}

/** Which of the given ports actually accept connections on the remote host. */
export async function remoteOccupancy(hostDef, cfg, ctx, ports) {
  if (ports.length === 0) return [];
  const result = await execRemote(hostDef, `node -e '${OCCUPANCY_NODE_PROBE.replace(/'/g, `'\\''`)}' ${ports.join(" ")}`, { cfg, timeoutMs: 60000 });
  if (result.code !== 0) {
    throw new TunnelError(`remote occupancy probe failed: ${result.stderr.trim() || `exit ${result.code}`}`, { code: "E_PROBE" });
  }
  return result.stdout.split(/\r?\n/).map((line) => Number.parseInt(line, 10)).filter((p) => Number.isInteger(p));
}

/** Best-effort `ss -tlnp` snapshot: [{port, pid, process}] (sudo when available). */
export async function remoteListeners(hostDef, cfg, ctx) {
  const sudo = await sudoPrefix(hostDef, cfg, ctx.sudoState);
  const cmd = [...sudo, "sh", "-c", "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || true"].join(" ");
  const result = await execRemote(hostDef, cmd, { cfg, timeoutMs: 30000 });
  const rows = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /127\.0\.0\.1:(\d+)\s+.*?users:\(\(\"([^\"]+)\",pid=(\d+)/.exec(line);
    if (match !== null) rows.push({ port: Number.parseInt(match[1], 10), pid: Number.parseInt(match[3], 10), process: match[2] });
  }
  return rows;
}

/** Map pid -> owning login for listener processes (ps needs no sudo). */
export async function remoteProcessOwners(hostDef, cfg, ctx, pids) {
  const owners = new Map();
  const unique = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  if (unique.length === 0) return owners;
  const result = await execRemote(hostDef, `ps -o user=,pid= -p ${unique.join(",")} 2>/dev/null || true`, { cfg, timeoutMs: 30000 });
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+(\d+)\s*$/.exec(line);
    if (match !== null) owners.set(Number.parseInt(match[2], 10), match[1]);
  }
  return owners;
}
