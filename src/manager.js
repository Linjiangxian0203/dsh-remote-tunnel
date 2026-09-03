import os from "node:os";
import { spawn } from "node:child_process";
import { TunnelError } from "./errors.js";
import { loadConfig } from "./config.js";
import { readSshConfig, findSshAlias } from "./ssh-config.js";
import { execRemote, spawnSsh, canSudo, remoteFacts } from "./ssh.js";
import {
  remoteAllocate, remoteReadRegistry, remoteUpdateRegistry, remoteUpdateRegistryBatch,
  remoteOccupancy, remoteListeners, remoteProcessOwners, resolveRegistry
} from "./remote/registry.js";
import {
  UnitScope, provisionUnit, ensureLinger, resolveUnitScope
} from "./remote/unit.js";
import { findFreeLocalPort, localPortResponds, killProcessTree, pidAlive } from "./local/ports.js";
import { readState, writeState, removeState, listStates, logFile } from "./local/state.js";
import { Tunnel } from "./local/tunnel.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * TunnelManager — the whole plugin domain: host discovery, remote allocation
 * and registry, systemd provisioning (system or --user unit), local tunnel
 * supervision, heartbeats, audit and lifecycle. CLI commands and /remote
 * slash commands are thin wrappers over this class.
 */
export class TunnelManager {
  constructor({ home, reporter }) {
    this.home = home;
    this.reporter = reporter;
    this.cfg = loadConfig(home).config;
    this.tunnels = new Map();      // alias -> Tunnel
    this.heartbeats = new Map();   // alias -> interval
    this.sudoStates = new Map();   // alias -> { canSudo }
    this.targets = new Map();      // alias -> { hostDef, facts, registry, scope }
    this.follows = new Set();      // resident log-follow children
    this.disposed = false;
  }

  out(text) { this.reporter.out(text); }
  err(text) { this.reporter.err(text); }
  event(evt) { this.reporter.event(evt); }

  ctxFor(alias) {
    if (!this.sudoStates.has(alias)) this.sudoStates.set(alias, {});
    return { sudoState: this.sudoStates.get(alias) };
  }

  /** Resolve an alias: plugin config first, then ~/.ssh/config. */
  resolveHost(alias) {
    const custom = this.cfg.hosts[alias];
    if (custom !== undefined) {
      return {
        alias,
        fromSshConfig: false,
        host: custom.host ?? alias,
        port: custom.port ?? 22,
        user: custom.user ?? null,
        workspace: custom.workspace ?? null,
        remotePortRange: custom.remotePortRange ?? null
      };
    }
    const entry = findSshAlias(readSshConfig(), alias);
    if (entry !== undefined) return { ...entry, workspace: null };
    throw new TunnelError(
      `unknown host "${alias}" — define it with 'dsh --profile remote hosts add ${alias} --host <ip>' or in ~/.ssh/config`,
      { code: "E_UNKNOWN_HOST" }
    );
  }

  /** All known hosts: ~/.ssh/config aliases plus plugin-config entries. */
  listHosts() {
    const parsed = readSshConfig();
    const merged = new Map();
    for (const entry of parsed.aliases) {
      merged.set(entry.alias, {
        alias: entry.alias,
        origin: "ssh-config",
        host: entry.host ?? entry.alias,
        port: entry.port ?? 22,
        user: entry.user ?? null,
        workspace: null
      });
    }
    for (const [alias, custom] of Object.entries(this.cfg.hosts)) {
      merged.set(alias, {
        alias,
        origin: "plugin-config",
        host: custom.host ?? alias,
        port: custom.port ?? 22,
        user: custom.user ?? null,
        workspace: custom.workspace ?? null
      });
    }
    return [...merged.values()].sort((a, b) => a.alias.localeCompare(b.alias));
  }

  /** hostDef + facts + registry handle + unit scope for one alias (cached). */
  async resolveTargets(alias) {
    if (!this.targets.has(alias)) {
      const hostDef = this.resolveHost(alias);
      const facts = await remoteFacts(hostDef, this.cfg);
      const ctx = this.ctxFor(alias);
      const user = hostDef.user ?? facts.user;
      const registry = await resolveRegistry(hostDef, this.cfg, ctx, facts);
      const scope = await resolveUnitScope(hostDef, this.cfg, ctx, facts, user);
      this.targets.set(alias, { hostDef, facts, user, registry, scope });
    }
    return this.targets.get(alias);
  }

  async waitForRemotePort(targets, port, timeoutSeconds) {
    const { hostDef, scope } = targets;
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const listening = await remoteOccupancy(hostDef, this.cfg, this.ctxFor(hostDef.alias), [port]);
      if (listening.includes(port)) return;
      if (await scope.bindFailed(hostDef, this.cfg, this.ctxFor(hostDef.alias))) {
        const error = new TunnelError(`remote dsh on ${hostDef.alias} failed to bind port ${port} (EADDRINUSE)`, { code: "E_REMOTE_BIND" });
        error.port = port;
        throw error;
      }
      await sleep(2000);
    }
    throw new TunnelError(
      `remote dsh web did not open port ${port} within ${timeoutSeconds}s — run 'dsh --profile remote logs ${hostDef.alias}' for the journal`,
      { code: "E_REMOTE_PORT_TIMEOUT" }
    );
  }

  /**
   * Remote side of `up`: reuse a healthy registered port or allocate a fresh
   * one, ensure the systemd unit runs on it, wait until it listens.
   */
  async provision(alias, { port: requestedPort, exclude: initialExclude = [] } = {}) {
    const targets = await this.resolveTargets(alias);
    const { hostDef, facts, user, registry, scope } = targets;
    if (facts.nodePath === null) {
      throw new TunnelError(`node not found on ${alias} — the remote dsh requires Node >= 22.19 (run scripts/bootstrap-remote.sh on the server)`, { code: "E_REMOTE_NO_NODE" });
    }
    if (facts.dshPath === null) {
      throw new TunnelError(`dsh not found on ${alias} — install @deepseek-ai/dsh on the server first`, { code: "E_REMOTE_NO_DSH" });
    }
    const workspace = hostDef.workspace ?? facts.home;
    const source = os.hostname();
    const ctx = this.ctxFor(alias);

    let port = requestedPort ?? null;
    let reused = false;
    let allocated = false;

    if (port === null && await scope.exists(hostDef, this.cfg, ctx)) {
      const existing = await scope.port(hostDef, this.cfg, ctx);
      if (existing !== null) {
        const rows = await remoteReadRegistry(hostDef, this.cfg, ctx, registry);
        const row = rows.find((r) => r.port === Number(existing) && r.user === user && r.status === "in-use");
        if (row !== undefined) {
          port = Number(existing);
          reused = true;
          this.out(`reusing registered remote port ${port} (${scope.unit} already runs on it)`);
        }
      }
    }

    if (port === null) {
      const range = hostDef.remotePortRange ?? this.cfg.defaults.remotePortRange;
      const exclude = [...initialExclude];
      const retries = this.cfg.defaults.allocateRetries;
      for (let attempt = 0; attempt < retries; attempt++) {
        port = await remoteAllocate(hostDef, this.cfg, ctx, registry, { range, user, workspace, source, exclude });
        allocated = true;
        this.out(`allocated remote port ${port} (range ${range[0]}-${range[1]}, registered for ${user})`);
        let restartFailed = false;
        try {
          await provisionUnit(hostDef, this.cfg, ctx, scope, {
            user, home: facts.home, workspace, dshPath: facts.dshPath, port
          });
        } catch (error) {
          restartFailed = error instanceof TunnelError;
          if (!restartFailed) throw error;
        }
        // The dsh process may lose a bind race between allocation and start
        // (TOCTOU). Only a FAILED restart plus an EADDRINUSE journal entry
        // counts as that race — a stale journal line must not burn ports.
        if (restartFailed) {
          const bindFailed = await scope.bindFailed(hostDef, this.cfg, ctx).catch(() => false);
          if (bindFailed) {
            this.out(`port ${port} lost a bind race (EADDRINUSE) — retrying with the next free port`);
            exclude.push(port);
            continue;
          }
          throw new TunnelError(`systemd restart for ${scope.unit} failed — run 'dsh --profile remote logs ${alias}' for the journal`, { code: "E_UNIT" });
        }
        break;
      }
    } else if (!reused) {
      await provisionUnit(hostDef, this.cfg, ctx, scope, {
        user, home: facts.home, workspace, dshPath: facts.dshPath, port
      });
    } else {
      const active = await scope.activeState(hostDef, this.cfg, ctx);
      if (active !== "active") {
        this.out(`unit ${scope.unit} exists but is ${active} — restarting`);
        await provisionUnit(hostDef, this.cfg, ctx, scope, {
          user, home: facts.home, workspace, dshPath: facts.dshPath, port
        });
      }
    }

    const linger = await ensureLinger(hostDef, this.cfg, ctx, scope, user);
    if (!linger.ok) {
      this.err(`warning: could not enable linger for ${user} (${linger.detail}) — the remote service may stop when the user logs out`);
    } else if (linger.linger === "yes") {
      this.out(`linger enabled for ${user} (service survives logout)`);
    }

    await this.waitForRemotePort(targets, port, this.cfg.defaults.remoteWaitSeconds);
    return {
      hostDef, user, workspace, unit: scope.unit, unitScope: scope.type, scope, port,
      registryPath: registry.path, registryKind: registry.kind,
      reused: reused && !allocated,
      remoteUrl: `http://127.0.0.1:${port}`
    };
  }

  startHeartbeat(alias, { port, user }) {
    this.stopHeartbeat(alias);
    const seconds = this.cfg.defaults.heartbeatSeconds;
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    // Guard against overlapping beats: a slow ssh round-trip must not stack a
    // second heartbeat on top of the in-flight one.
    let inflight = false;
    const timer = setInterval(() => {
      if (inflight) return;
      inflight = true;
      const run = async () => {
        const targets = await this.resolveTargets(alias);
        await remoteUpdateRegistry(targets.hostDef, this.cfg, this.ctxFor(alias), targets.registry, {
          port, user, field: "last_heartbeat", value: new Date().toISOString()
        });
        const state = readState(this.home, alias);
        if (state !== undefined) writeState(this.home, alias, { ...state, lastHeartbeatAt: new Date().toISOString() });
      };
      run().catch((error) => {
        this.event({ kind: "heartbeat", alias, error: error instanceof Error ? error.message : String(error) });
      }).finally(() => { inflight = false; });
    }, seconds * 1000);
    timer.unref?.();
    this.heartbeats.set(alias, timer);
  }

  stopHeartbeat(alias) {
    const timer = this.heartbeats.get(alias);
    if (timer !== undefined) clearInterval(timer);
    this.heartbeats.delete(alias);
  }

  /** Full `up`: provision remotely, open the tunnel, verify the URL, keep alive. */
  async up(alias, opts = {}) {
    const state = readState(this.home, alias);
    if (state !== undefined && pidAlive(state.sshPid)) {
      throw new TunnelError(
        `tunnel for ${alias} is already up at ${state.url} — run 'down ${alias}' to stop it first`,
        { code: "E_ALREADY_UP" }
      );
    }
    if (state !== undefined && !pidAlive(state.sshPid)) {
      // The previous `up` process died without a clean teardown (terminal
      // hard-closed, machine rebooted...). Its state file is stale: drop it so
      // the old local port can be reused. The remote unit + registry row are
      // reused by provision() below, so the remote port stays stable.
      this.out(`cleaning up stale tunnel state for ${alias} (previous process is gone)`);
      removeState(this.home, alias);
    }
    // A dsh that crashes on bind AFTER systemd accepted the start surfaces as
    // E_REMOTE_BIND during the port wait — retry with that port excluded.
    let remote;
    const exclude = [];
    const retries = Math.max(1, this.cfg.defaults.allocateRetries);
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        remote = await this.provision(alias, { port: opts.remotePort, exclude });
        break;
      } catch (error) {
        if (error instanceof TunnelError && error.code === "E_REMOTE_BIND" && error.port !== undefined && attempt < retries - 1) {
          this.out(`port ${error.port} failed to bind after start — retrying with the next free port`);
          exclude.push(error.port);
          continue;
        }
        throw error;
      }
    }

    const localInUse = new Set(
      this.listStatesLocal().map((s) => s.localPort).filter((p) => Number.isInteger(p))
    );
    const localPort = opts.localPort ?? await findFreeLocalPort(this.cfg.defaults.localPortRange, { exclude: localInUse });

    // Cross-process cancellation: once this up() has written its state file,
    // a `down <host>` from another invocation removes it — that removes the
    // file, so the supervisor stops reconnecting instead of resurrecting a
    // tunnel the user just tore down.
    let stateWritten = false;
    const tunnel = new Tunnel({
      hostDef: remote.hostDef,
      cfg: this.cfg,
      localPort,
      remotePort: remote.port,
      logPath: logFile(this.home, alias),
      reporter: this.event.bind(this),
      isCancelled: () => this.tunnels.get(alias) !== tunnel || (stateWritten && readState(this.home, alias) === undefined)
    });
    this.tunnels.set(alias, tunnel);
    tunnel.start();

    const deadline = Date.now() + this.cfg.defaults.localWaitSeconds * 1000;
    let responding = false;
    while (Date.now() < deadline) {
      if (await localPortResponds(localPort)) { responding = true; break; }
      await sleep(500);
    }
    if (!responding) {
      await tunnel.stop();
      this.tunnels.delete(alias);
      throw new TunnelError(
        `local http://127.0.0.1:${localPort} not reachable after ${this.cfg.defaults.localWaitSeconds}s — run 'logs ${alias} --local' for the tunnel output`,
        { code: "E_LOCAL_URL" }
      );
    }

    const now = new Date().toISOString();
    writeState(this.home, alias, {
      alias,
      host: remote.hostDef.host,
      user: remote.user,
      workspace: remote.workspace,
      unit: remote.unit,
      unitScope: remote.unitScope,
      remotePort: remote.port,
      localPort,
      url: `http://127.0.0.1:${localPort}`,
      sshPid: tunnel.child?.pid ?? null,
      startedAt: now,
      lastHeartbeatAt: now
    });
    stateWritten = true;
    this.startHeartbeat(alias, { port: remote.port, user: remote.user });

    this.event({ kind: "up", alias, url: `http://127.0.0.1:${localPort}`, remotePort: remote.port, localPort });

    // dsh web (>= 0.1.2-rc) gates its UI behind a one-time token carried in
    // the launch URL it prints at startup (into the unit journal). Surface an
    // equivalent URL pointing at the local tunnel port so `up` output opens
    // the page directly; fall back to a hint when the journal can't supply it.
    //
    // Two real-world races: the web prints its URL 2-4s AFTER systemd reports
    // "Started", and an early fetch would otherwise match a STALE line from a
    // previous run (pre-token versions printed a plain URL — real journal
    // evidence). So only the segment after the last "Started dsh web" counts,
    // the LAST `dsh web:` URL in it must carry `?token=`, and the fetch
    // retries a few times to span the print delay.
    let authUrl = null;
    try {
      for (let attempt = 0; attempt < 4 && authUrl === null; attempt++) {
        if (attempt > 0) await sleep(1500);
        const journal = await remote.scope.journal(remote.hostDef, this.cfg, this.ctxFor(alias), 200);
        const started = journal.lastIndexOf("Started dsh web");
        const sinceStart = started === -1 ? journal : journal.slice(started);
        const matches = [...sinceStart.matchAll(/dsh web:\s*(http\S+)/g)];
        const match = matches.length > 0 ? matches[matches.length - 1] : null;
        if (match === null) continue;
        const url = new URL(match[1]);
        if (url.searchParams.get("token") === null) continue; // stale/plain line — keep waiting
        url.hostname = "127.0.0.1";
        url.port = String(localPort);
        authUrl = url.href;
      }
    } catch {
      // best effort: the plain URL plus the log hint below still work
    }

    return {
      alias,
      url: `http://127.0.0.1:${localPort}`,
      authUrl,
      localPort,
      remotePort: remote.port,
      unit: remote.unit,
      unitScope: remote.unitScope,
      workspace: remote.workspace,
      registryPath: remote.registryPath,
      registryKind: remote.registryKind,
      reused: remote.reused
    };
  }

  /** Stop the tunnel, release the registry entry, stop the unit, verify. */
  async down(alias, opts = {}) {
    const state = readState(this.home, alias);
    const tunnel = this.tunnels.get(alias);
    if (state === undefined && tunnel === undefined) {
      throw new TunnelError(`no tunnel state for "${alias}" — nothing to stop`, { code: "E_NOT_UP" });
    }
    if (tunnel !== undefined) await tunnel.stop();
    else if (state.sshPid !== null && state.sshPid !== undefined) await killProcessTree(state.sshPid);
    this.tunnels.delete(alias);
    this.stopHeartbeat(alias);
    // Remove the state file BEFORE the remote release round-trips: the local
    // teardown is authoritative, and another process's supervisor watches
    // this file to stop reconnecting.
    removeState(this.home, alias);

    const result = { alias, released: false, serviceStopped: false, portFree: false, warnings: [] };
    if (state !== undefined) {
      try {
        const targets = await this.resolveTargets(alias);
        const ctx = this.ctxFor(alias);
        await remoteUpdateRegistry(targets.hostDef, this.cfg, ctx, targets.registry, {
          port: state.remotePort, user: state.user, field: "status", value: "released"
        });
        result.released = true;
        if (opts.keepService !== true) {
          result.serviceStopped = await targets.scope.stop(targets.hostDef, this.cfg, ctx).then((r) => r.code === 0, () => false);
          if (!result.serviceStopped) result.warnings.push("remote unit did not stop");
        }
        const listening = await remoteOccupancy(targets.hostDef, this.cfg, ctx, [state.remotePort]);
        result.portFree = !listening.includes(state.remotePort);
        if (!result.portFree) result.warnings.push(`remote port ${state.remotePort} still accepts connections`);
      } catch (error) {
        result.warnings.push(`remote release failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.event({ kind: "down", alias });
    return result;
  }

  listStatesLocal() {
    return listStates(this.home);
  }

  /** Local + remote status for one tunnel. Remote parts degrade offline. */
  async status(alias) {
    const state = readState(this.home, alias);
    if (state === undefined) throw new TunnelError(`no tunnel state for "${alias}" — run 'up ${alias}' first`, { code: "E_NOT_UP" });
    const local = {
      ...state,
      pidAlive: pidAlive(state.sshPid),
      urlResponds: await localPortResponds(state.localPort)
    };
    const remote = {};
    try {
      const targets = await this.resolveTargets(alias);
      const ctx = this.ctxFor(alias);
      remote.unitActive = await targets.scope.activeState(targets.hostDef, this.cfg, ctx);
      remote.unitScope = targets.scope.type;
      const rows = await remoteReadRegistry(targets.hostDef, this.cfg, ctx, targets.registry);
      remote.registryRow = rows.find((r) => r.port === state.remotePort) ?? null;
      const listening = await remoteOccupancy(targets.hostDef, this.cfg, ctx, [state.remotePort]);
      remote.portListening = listening.includes(state.remotePort);
    } catch (error) {
      remote.error = error instanceof Error ? error.message : String(error);
    }
    return { local, remote };
  }

  /** Registry vs. real occupancy for one remote host. */
  async audit(alias, opts = {}) {
    const targets = await this.resolveTargets(alias);
    const { hostDef, registry } = targets;
    const ctx = this.ctxFor(alias);
    const rows = await remoteReadRegistry(hostDef, this.cfg, ctx, registry);
    const allPorts = [...new Set(rows.map((r) => r.port))];
    const occupied = await remoteOccupancy(hostDef, this.cfg, ctx, allPorts);
    const listeners = await remoteListeners(hostDef, this.cfg, ctx).catch(() => []);
    const owners = await remoteProcessOwners(hostDef, this.cfg, ctx, listeners.map((l) => l.pid)).catch(() => new Map());
    const listenerByPort = new Map(listeners.map((l) => [l.port, l]));
    const occupiedSet = new Set(occupied);

    const verdicts = rows.map((row) => {
      const listening = occupiedSet.has(row.port);
      const listener = listenerByPort.get(row.port);
      let verdict = "ok";
      const owner = listener !== undefined ? owners.get(listener.pid) ?? null : null;
      if (row.status === "in-use" && !listening) verdict = "stale";
      else if (row.status === "released" && listening) verdict = "orphan";
      else if (row.status === "in-use" && listening && owner !== null && owner !== row.user) verdict = "conflict";
      return { ...row, listening, verdict, listenerProcess: listener?.process ?? null, listenerPid: listener?.pid ?? null, listenerUser: owner };
    });

    const changes = [];
    if (opts.release !== undefined) {
      const row = rows.find((r) => r.port === opts.release);
      if (row === undefined) throw new TunnelError(`port ${opts.release} has no registry row`, { code: "E_AUDIT" });
      await remoteUpdateRegistry(hostDef, this.cfg, ctx, registry, {
        port: row.port, user: row.user, field: "status", value: "released"
      });
      changes.push(`released ${row.port} (${row.user})`);
    }
    if (opts.cleanStale === true) {
      // ONE flock+awk pass for every stale row (was: one ssh round-trip each).
      const stale = verdicts.filter((v) => v.verdict === "stale");
      await remoteUpdateRegistryBatch(hostDef, this.cfg, ctx, registry, stale.map((row) => ({
        port: row.port, user: row.user, field: "status", value: "released"
      })));
      for (const row of stale) changes.push(`cleaned stale ${row.port} (${row.user}) → released`);
    }
    return { rows: verdicts, changes, registryPath: registry.path, registryKind: registry.kind };
  }

  async check(alias) {
    const hostDef = this.resolveHost(alias);
    const steps = [];
    const push = (name, ok, detail, hint, level = ok ? "info" : "error") => steps.push({ name, ok, detail, hint, level });

    const reach = await execRemote(hostDef, "true", { cfg: this.cfg, timeoutMs: 20000 });
    push("ssh connectivity", reach.code === 0, reach.code === 0 ? "ok" : reach.stderr.trim().split("\n")[0] ?? `exit ${reach.code}`, "check your key (ssh-keygen, ssh-copy-id) and that the host/port are right");
    if (reach.code !== 0) return { steps, allOk: false };

    const version = await execRemote(hostDef, "node --version 2>&1 || true", { cfg: this.cfg, timeoutMs: 30000 });
    const nodeOk = /^v(\d+)\.(\d+)\./.test(version.stdout.trim()) && (() => {
      const [, major, minor] = /^v(\d+)\.(\d+)\./.exec(version.stdout.trim());
      return Number(major) > 22 || (Number(major) === 22 && Number(minor) >= 19);
    })();
    push("node >= 22.19", nodeOk, version.stdout.trim() || "node not found", "run scripts/bootstrap-remote.sh on the server", nodeOk ? "info" : "error");

    const dsh = await execRemote(hostDef, "dsh --version 2>&1 || true", { cfg: this.cfg, timeoutMs: 30000 });
    const dshOk = dsh.code === 0 && dsh.stdout.trim().length > 0;
    push("dsh installed", dshOk, dsh.stdout.trim() || "dsh not found", "npm i -g @deepseek-ai/dsh (see README)");

    if (this.cfg.defaults.registry.sudo !== "never") {
      const sudoOk = await canSudo(hostDef, this.cfg);
      push("passwordless sudo", sudoOk, sudoOk ? "ok" : "sudo -n failed", "without it the plugin uses a systemd --user unit and the per-user registry fallback", sudoOk ? "info" : "warn");
      this.sudoStates.set(alias, { canSudo: sudoOk });
    }

    const facts = await remoteFacts(hostDef, this.cfg).catch(() => null);
    if (facts === null) {
      push("remote facts", false, "id/getent failed", "ssh user must be able to log in");
      return { steps, allOk: false };
    }
    const user = hostDef.user ?? facts.user;
    const ctx = this.ctxFor(alias);
    const registry = await resolveRegistry(hostDef, this.cfg, ctx, facts);
    const registryLabel = registry.kind === "fallback"
      ? `fallback ${registry.path} (shared ${this.cfg.defaults.registry.path} not writable by ${user})`
      : `${registry.path} (${registry.kind})`;
    push("registry", true, registryLabel, registry.kind === "fallback" ? "ask an admin for passwordless sudo / dshports-group access to enable the shared registry" : undefined, registry.kind === "fallback" ? "warn" : "info");

    const read = await execRemote(hostDef, `test -r "${registry.path}" && echo yes || echo missing`, { cfg: this.cfg, timeoutMs: 30000 });
    push("registry readable", read.stdout.trim() === "yes", read.stdout.trim() === "yes" ? registry.path : `${registry.path} missing (created on first allocation)`, undefined, read.stdout.trim() === "yes" ? "info" : "warn");

    let writeOk = false;
    let writeDetail = "";
    try {
      const probe = await execRemote(hostDef, [...registry.sudo, "flock", "-w", "2", registry.lockPath, "-c", "true"].join(" "), { cfg: this.cfg, timeoutMs: 20000 });
      writeOk = probe.code === 0;
      writeDetail = writeOk ? "ok" : probe.stderr.trim() || `exit ${probe.code}`;
    } catch (error) {
      writeDetail = error instanceof Error ? error.message : String(error);
    }
    push("registry writable (lock probe)", writeOk, writeDetail, "sudo or dshports-group write access to the registry file is required");

    const scope = await resolveUnitScope(hostDef, this.cfg, ctx, facts, user).catch((error) => null);
    if (scope === null) {
      push("systemd unit", false, "cannot resolve a unit scope (no passwordless sudo, no --user session)", "grant NOPASSWD sudo or run 'loginctl enable-linger <user>'");
    } else {
      push("systemd unit scope", true, `${scope.type} unit ${scope.unit}`, scope.type === "user" ? "user scope works without sudo" : undefined);
      const exists = await scope.exists(hostDef, this.cfg, ctx);
      push("unit installed", exists, exists ? scope.servicePath : "not installed", `run 'provision ${alias}' to create it`, exists ? "info" : "warn");
      if (exists) {
        const active = await scope.activeState(hostDef, this.cfg, ctx);
        push("unit active", active === "active", active, `run 'provision ${alias}' or restart the unit`, active === "active" ? "info" : "error");
        const port = await scope.port(hostDef, this.cfg, ctx);
        if (port !== null) {
          const listening = await remoteOccupancy(hostDef, this.cfg, ctx, [Number(port)]);
          push("web port listening", listening.includes(Number(port)), `127.0.0.1:${port} ${listening.includes(Number(port)) ? "listening" : "NOT listening"}`, `journalctl -u ${scope.unit} -n 50`);
        }
      }
      if (scope.type === "user") {
        const linger = await execRemote(hostDef, `loginctl show-user "${user}" -p Linger 2>/dev/null | cut -d= -f2`, { cfg: this.cfg, timeoutMs: 30000 });
        const enabled = linger.stdout.trim() === "yes";
        push("linger enabled", enabled, linger.stdout.trim() || "unknown", "run 'provision <host>' — it enables linger automatically (or: loginctl enable-linger <user>)", enabled ? "info" : "warn");
      }
    }
    return { steps, allOk: steps.every((s) => s.level !== "error") };
  }

  async logs(alias, { lines = 100, follow = false, local = false }) {
    if (local) {
      const { readFileSync, existsSync } = await import("node:fs");
      const path = logFile(this.home, alias);
      if (!existsSync(path)) return { text: `no local tunnel log for ${alias} yet` };
      const all = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.length > 0);
      return { text: all.slice(-lines).join("\n") };
    }
    const targets = await this.resolveTargets(alias);
    const { hostDef, scope } = targets;
    if (follow) {
      const args = scope.type === "system"
        ? ["sudo", "-n", "journalctl", "-u", scope.unit, "-f", "--no-pager"]
        : ["journalctl", "--user-unit", scope.unit, "-f", "--no-pager"];
      const child = spawnSsh(hostDef, args, { cfg: this.cfg });
      this.follows.add(child);
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
      return new Promise((resolve) => {
        child.on("close", () => { this.follows.delete(child); resolve({ text: "" }); });
      });
    }
    const text = await scope.journal(hostDef, this.cfg, this.ctxFor(alias), lines);
    return { text };
  }

  open(alias, urlOverride) {
    const state = readState(this.home, alias);
    if (state === undefined) throw new TunnelError(`no tunnel state for "${alias}"`, { code: "E_NOT_UP" });
    const url = urlOverride ?? state.url;
    // Platform-specific browser launcher: Windows uses `cmd start`, macOS uses
    // `open`, everything else uses `xdg-open`.
    const launcher = process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
    const child = spawn(launcher[0], launcher[1], { stdio: "ignore", windowsHide: true });
    child.on("error", (error) => this.err(`could not open browser: ${error.message}`));
    return url;
  }

  /** Stop the tunnels this manager supervises (CLI up exit / shutdown). */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const child of this.follows) {
      try { child.kill(); } catch { /* already gone */ }
    }
    this.follows.clear();
    // Only tunnels this process started. State files of other processes (or
    // of a crashed `up`) are deliberately left alone — `down <host>` is the
    // cross-invocation teardown that reads the state file and kills by pid.
    const aliases = new Set([...this.tunnels.keys(), ...this.heartbeats.keys()]);
    for (const alias of aliases) {
      try {
        await this.down(alias, { keepService: false });
      } catch {
        // best effort on shutdown
      }
    }
  }
}
