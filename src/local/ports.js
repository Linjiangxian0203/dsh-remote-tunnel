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
  const occupants = [];
  for (let port = range[0]; port <= range[1]; port++) {
    const info = await describeOccupant(port);
    if (info !== null) occupants.push(`${port} (${info})`);
  }
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

/** Name the process holding a local port (Windows netstat+tasklist; POSIX lsof). */
export async function describeOccupant(port) {
  try {
    if (process.platform === "win32") {
      const netstat = await execFileText("netstat", ["-ano", "-p", "tcp"]);
      const pids = new Set();
      for (const line of netstat.split(/\r?\n/)) {
        if (!line.includes("LISTENING")) continue;
        if (new RegExp(`:${port}\\s`).test(line)) {
          const match = /\s(\d+)\s*$/.exec(line.trim());
          if (match !== null) pids.add(match[1]);
        }
      }
      for (const pid of pids) {
        const tasklist = await execFileText("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
        const match = /"([^"]+)",\s*"(\d+)"/.exec(tasklist);
        if (match !== null) return `pid ${match[2]} ${match[1]}`;
      }
      return pids.size > 0 ? `pid ${[...pids].join(",")}` : "unknown process";
    }
    const lsof = await execFileText("lsof", ["-nP", "-i", `tcp:${port}`, "-sTCP:LISTEN"]);
    const line = lsof.split(/\r?\n/)[1] ?? "";
    const fields = line.trim().split(/\s+/);
    if (fields.length >= 2) return `pid ${fields[1]} ${fields[0]}`;
    return null;
  } catch {
    return null;
  }
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
