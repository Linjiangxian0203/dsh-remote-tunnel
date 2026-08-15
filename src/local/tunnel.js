import { spawnSsh } from "../ssh.js";
import { killProcessTree } from "./ports.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// The resilient ssh tunnel: `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote>`.
// Exit → reconnect with capped exponential backoff, forever by default.
// Logs every transition to the local log file and to the caller's reporter.

export class Tunnel {
  constructor({ hostDef, cfg, localPort, remotePort, logPath, reporter, isCancelled }) {
    this.hostDef = hostDef;
    this.cfg = cfg;
    this.localPort = localPort;
    this.remotePort = remotePort;
    this.logPath = logPath;
    this.reporter = reporter;
    this.isCancelled = isCancelled ?? (() => false);
    this.child = undefined;
    this.stopped = false;
    this.attempt = 0;
    this.timer = undefined;
    this.state = "stopped";
    this.lastError = undefined;
  }

  log(line) {
    try {
      if (this.logPath !== undefined) {
        mkdirSync(dirname(this.logPath), { recursive: true });
        appendFileSync(this.logPath, `${new Date().toISOString()} ${line}\n`, "utf8");
      }
    } catch {
      // logging must never break the tunnel
    }
  }

  report(state, detail) {
    this.state = state;
    this.reporter({ kind: "tunnel", alias: this.hostDef.alias, state, detail, localPort: this.localPort, remotePort: this.remotePort });
  }

  delayFor(attempt) {
    const delays = this.cfg.defaults.reconnect.delaysMs;
    return delays[Math.min(attempt, delays.length - 1)];
  }

  start() {
    this.stopped = false;
    this.spawn();
    return this;
  }

  spawn() {
    if (this.stopped) return;
    if (this.isCancelled()) {
      this.log("cancelled before connect — not respawning");
      this.report("stopped", "cancelled by down");
      return;
    }
    this.attempt += 1;
    const args = [
      "-N",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-L", `127.0.0.1:${this.localPort}:127.0.0.1:${this.remotePort}`
    ];
    this.report("connecting", `attempt ${this.attempt}`);
    this.log(`connecting: ssh ${args.join(" ")} ${this.hostDef.alias}`);
    const child = spawnSsh(this.hostDef, args, { cfg: this.cfg, onLine: ({ name, line }) => this.log(`[${name}] ${line}`) });
    this.child = child;
    child.on("error", (error) => {
      this.log(`spawn error: ${error.message}`);
      this.lastError = error;
      this.scheduleReconnect();
    });
    child.on("close", (code) => {
      if (this.child !== child) return; // superseded by a stop/restart
      this.log(`ssh exited with code ${code}`);
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped) return;
    if (this.isCancelled()) {
      this.log("cancelled — not reconnecting");
      this.report("stopped", "cancelled by down");
      return;
    }
    const cfg = this.cfg.defaults.reconnect;
    const exhausted = cfg.maxAttempts > 0 && this.attempt >= cfg.maxAttempts;
    if (exhausted) {
      this.report("failed", `gave up after ${this.attempt} attempts`);
      return;
    }
    const delay = this.delayFor(this.attempt);
    this.report("reconnecting", `waiting ${Math.round(delay / 1000)}s before attempt ${this.attempt + 1}`);
    this.log(`reconnecting in ${delay}ms`);
    this.timer = setTimeout(() => this.spawn(), delay);
  }

  async stop() {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const child = this.child;
    this.child = undefined;
    if (child !== undefined && child.pid !== undefined) {
      this.log("stopping tunnel");
      await killProcessTree(child.pid);
    }
    this.report("stopped", "tunnel stopped");
  }
}
