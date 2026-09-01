import net from "node:net";
import { execFile } from "node:child_process";
import { TunnelError } from "../errors.js";

// Local port helpers (this machine): bind probing plus a Windows netstat /
// tasklist diagnostic that names the process holding a port.

function probeOnce(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

/** First free local port in [lo, hi]; throws with diagnostics when none. */
export async function findFreeLocalPort(range, { exclude = new Set() } = {}) {
  for (let port = range[0]; port <= range[1]; port++) {
    if (exclude.has(port)) continue;
    if (await probeOnce(port)) return port;
  }
  // One netstat + one tasklist/lsof pass for the WHOLE range (was: one pair
  // of process spawns per port — O(N) spawns when the range is exhausted).
  const occupants = await describeOccupants(range[0], range[1]);
  const detail = occupants.length > 0 ? `; occupied by: ${occupants.join(", ")}` : "";
  throw new TunnelError(`no free local port in ${range[0]}-${range[1]}${detail}`, { code: "E_NO_FREE_LOCAL_PORT" });
}

/** True when a local port accepts connections (used for URL verification). */
export async function localPortResponds(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => resolve(false));
  });
}

function execFileText(file, args, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      resolve(error === null ? stdout : "");
    });
  });
}

/** Parse `netstat -ano -p tcp` output into Map<port, Set<pid>> for LISTENING
 *  sockets whose local port falls in [lo, hi]. */
export function parseNetstatListening(text, lo, hi) {
  const result = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("LISTENING")) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const port = Number.parseInt(fields[1].slice(fields[1].lastIndexOf(":") + 1), 10);
    const pid = Number.parseInt(fields[fields.length - 1], 10);
    if (!Number.isInteger(port) || !Number.isInteger(pid) || port < lo || port > hi) continue;
    if (!result.has(port)) result.set(port, new Set());
    result.get(port).add(String(pid));
  }
  return result;
}

/** Parse `tasklist /FO CSV /NH` output into Map<pid, image name>. */
export function parseTasklistCsv(text) {
  const names = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (match !== null) names.set(match[2], match[1]);
  }
  return names;
}

/** Parse `lsof -nP -iTCP -sTCP:LISTEN` output into [port, "pid N cmd"] pairs
 *  for local ports in [lo, hi]. Locates NAME relative to the "(LISTEN)" token
 *  so both 9- and 10-column layouts (SIZE/OFF present or empty) parse. */
export function parseLsofListening(text, lo, hi) {
  const result = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    const listenIdx = fields.indexOf("(LISTEN)");
    if (listenIdx < 1) continue;
    const name = fields[listenIdx - 1];
    const port = Number.parseInt(name.slice(name.lastIndexOf(":") + 1), 10);
    if (!Number.isInteger(port) || port < lo || port > hi) continue;
    result.push([port, `pid ${fields[1]} ${fields[0]}`]);
  }
  return result;
}

/**
 * Name the processes listening on EVERY local port in [lo, hi] with exactly
 * one netstat + one tasklist (Windows) or one lsof (POSIX) invocation.
 * Returns `["3080 (pid 1234 node.exe)", ...]` sorted by port.
 */
export async function describeOccupants(lo, hi) {
  try {
    if (process.platform === "win32") {
      const netstat = await execFileText("netstat", ["-ano", "-p", "tcp"]);
      const portPids = parseNetstatListening(netstat, lo, hi);
      if (portPids.size === 0) return [];
      const names = parseTasklistCsv(await execFileText("tasklist", ["/FO", "CSV", "/NH"]));
      const out = [];
      for (const port of [...portPids.keys()].sort((a, b) => a - b)) {
        const label = [...portPids.get(port)]
          .map((pid) => names.has(pid) ? `pid ${pid} ${names.get(pid)}` : `pid ${pid}`)
          .join(", ");
        out.push(`${port} (${label})`);
      }
      return out;
    }
    const lsof = await execFileText("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
    return parseLsofListening(lsof, lo, hi).sort((a, b) => a[0] - b[0]).map(([port, label]) => `${port} (${label})`);
  } catch {
    return [];
  }
}

/** Name the process holding one local port (Windows netstat+tasklist; POSIX lsof). */
export async function describeOccupant(port) {
  const all = await describeOccupants(port, port);
  if (all.length === 0) return null;
  const match = /^\d+ \((.*)\)$/.exec(all[0]);
  return match !== null ? match[1] : null;
}

/** Kill a local process tree (the ssh tunnel child). */
export async function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    try {
      await execFileText("taskkill", ["/PID", String(pid), "/T", "/F"]);
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
