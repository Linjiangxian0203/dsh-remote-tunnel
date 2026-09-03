import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";
import { TunnelManager } from "./manager.js";
import { TunnelError } from "./errors.js";
import { loadConfig, saveConfig } from "./config.js";
import { parsePort, parseIntArg } from "./cli-args.js";

// dsh-remote-tunnel CLI half: the commander program for a dedicated profile.
// runCli is called by the bundle entry once it has decided this profile owns
// the argument snapshot. Commands exit through the launcher's appExit;
// `up` stays resident while the tunnel supervisor keeps the process alive.

export function runCli(ctx, home) {
  const exit = ctx.get("appExit");
  const debug = process.env.DSH_DEBUG !== undefined;

  const reporter = {
    out(text) { process.stdout.write(`${text}\n`); },
    err(text) { process.stderr.write(`${text}\n`); },
    event(evt) {
      if (evt.kind === "up") {
        process.stdout.write(`✓ tunnel up — ${evt.url} (remote ${evt.alias}:${evt.remotePort})\n`);
      } else if (evt.kind === "down") {
        process.stdout.write(`✓ tunnel down — ${evt.alias}\n`);
      } else if (evt.kind === "tunnel") {
        const label = { connecting: "connecting", reconnecting: "reconnecting", failed: "FAILED", stopped: "stopped" }[evt.state] ?? evt.state;
        const detail = evt.detail !== undefined ? ` — ${evt.detail}` : "";
        process.stdout.write(`[tunnel ${evt.alias}] ${label}${detail}\n`);
      } else if (evt.kind === "heartbeat") {
        process.stdout.write(`[heartbeat ${evt.alias}] error: ${evt.error}\n`);
      }
    }
  };

  const manager = new TunnelManager({ home, reporter });
  ctx.effect(() => {
    return () => manager.dispose();
  }, "remote-tunnel.cli");

  const program = new Command()
    .name("dsh --profile remote")
    .description("Remote Host Tunnel Manager: run dsh web on a remote Linux server and keep a resilient SSH tunnel to it.")
    .helpOption("-h, --help", "show this help")
    .showHelpAfterError()
    .addHelpText("after", `
Commands:
  hosts                     list remote hosts (~/.ssh/config + this plugin's config)
  hosts add <alias>         define a remote host
  hosts rm <alias>          remove a host definition
  check <host>              readiness diagnostics for a remote host
  provision <host>          allocate a remote port, install the systemd unit, start dsh web
  up <host>                 provision + open the SSH tunnel (auto-reconnect, heartbeat)
  down [host]               stop the tunnel, release the registry entry, stop the unit
  status [host]             local tunnel state + remote service state
  list                      local tunnels
  logs <host>               remote dsh web logs (journalctl); --local for the tunnel log
  audit <host>              registry vs. real port occupancy
  open [host]               open the local URL in the browser
  config show               print the resolved config
  config path               print the config file path
`);

  function printError(error) {
    if (error instanceof TunnelError) {
      process.stderr.write(`✗ ${error.message}\n`);
      if (error.hint !== undefined) process.stderr.write(`  hint: ${error.hint}\n`);
    } else {
      process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
    }
    if (debug && error instanceof Error && error.stack !== undefined) process.stderr.write(`${error.stack}\n`);
  }

  /** Wire one async command: success exits 0 (except resident), failure exits 1.
   *  A handler may return a number to choose the exit code itself. */
  function cmd(name, description, handler, { resident = false } = {}) {
    const run = (promise) => {
      promise.then((code) => {
        if (!resident) exit?.(code ?? 0);
      }, (error) => {
        printError(error);
        exit?.(1);
      });
    };
    program.command(name).description(description).action((...actionArgs) => {
      run(Promise.resolve().then(() => handler(...actionArgs)));
    });
  }

  program.command("help").description("show this help").action(() => {
    program.help();
  });

  // ---- hosts ---------------------------------------------------------------
  const hostsCmd = program.command("hosts").description("list remote hosts, or add/remove plugin-config host definitions");
  hostsCmd.action(() => {
    Promise.resolve().then(async () => {
      const hosts = manager.listHosts();
      if (hosts.length === 0) {
        reporter.out("no hosts found — add one with 'hosts add <alias> --host <ip>' or define it in ~/.ssh/config");
        return;
      }
      for (const h of hosts) {
        const user = h.user ?? "(default)";
        const ws = h.workspace ?? "(remote home)";
        reporter.out(`${h.alias.padEnd(20)} ${h.host}:${h.port}  user=${user}  workspace=${ws}  [${h.origin}]`);
      }
    }).then(() => exit?.(0), (error) => { printError(error); exit?.(1); });
  });

  hostsCmd.command("add <alias>")
    .description("define a remote host in the plugin config")
    .requiredOption("--host <host>", "remote host name or IP")
    .option("--port <port>", "ssh port", "22")
    .option("--user <user>", "ssh login user")
    .option("--workspace <dir>", "workspace root for the remote dsh web (default: remote home)")
    .action((alias, options) => {
      Promise.resolve().then(async () => {
        const { path, config } = loadConfig(home);
        config.hosts[alias] = {
          host: options.host,
          port: parsePort(options.port, "--port"),
          ...(options.user !== undefined ? { user: options.user } : {}),
          ...(options.workspace !== undefined ? { workspace: options.workspace } : {})
        };
        saveConfig(home, config);
        reporter.out(`host ${alias} added (${path})`);
      }).then(() => exit?.(0), (error) => { printError(error); exit?.(1); });
    });

  hostsCmd.command("rm <alias>")
    .description("remove a host definition from the plugin config")
    .action((alias) => {
      Promise.resolve().then(async () => {
        const { path, config } = loadConfig(home);
        if (config.hosts[alias] === undefined) throw new TunnelError(`no plugin-config host "${alias}" (ssh-config entries are managed in ~/.ssh/config)`, { code: "E_UNKNOWN_HOST" });
        delete config.hosts[alias];
        saveConfig(home, config);
        reporter.out(`host ${alias} removed (${path})`);
      }).then(() => exit?.(0), (error) => { printError(error); exit?.(1); });
    });

  // ---- check ---------------------------------------------------------------
  cmd("check <host>", "readiness diagnostics for a remote host", async (alias) => {
    const { steps, allOk } = await manager.check(alias);
    for (const step of steps) {
      const mark = step.ok ? "✓" : step.level === "warn" ? "△" : "✗";
      reporter.out(`${mark} ${step.name}: ${step.detail}`);
      if (!step.ok && step.hint !== undefined) reporter.out(`    hint: ${step.hint}`);
    }
    reporter.out(allOk ? "✓ all checks passed" : "✗ some checks failed — fix them and re-run check");
    return allOk ? 0 : 1;
  });

  // ---- provision -----------------------------------------------------------
  const provisionCmd = program.command("provision <host>")
    .description("allocate a remote port, install the systemd unit, start remote dsh web (no local tunnel)")
    .option("--port <port>", "use this remote port instead of allocating one");
  provisionCmd.action((alias, options) => {
    Promise.resolve().then(async () => {
      const result = await manager.provision(alias, { port: parsePort(options.port, "--port") });
      reporter.out(`✓ remote dsh web ready on ${alias}`);
      reporter.out(`  port:     ${result.remoteUrl}`);
      reporter.out(`  unit:     ${result.unit}`);
      reporter.out(`  workspace: ${result.workspace}`);
      reporter.out(`  next:     dsh --profile remote up ${alias}`);
    }).then(() => exit?.(0), (error) => { printError(error); exit?.(1); });
  });
  provisionCmd.showHelpAfterError();

  // ---- up ------------------------------------------------------------------
  const upCmd = program.command("up <host>")
    .description("provision the remote dsh web and open a resilient local tunnel")
    .option("--port <port>", "force this remote port instead of allocating one")
    .option("--local-port <port>", "force this local tunnel port")
    .option("--open", "open the local URL in the browser once the tunnel is up")
    .option("--heartbeat <seconds>", "override heartbeat interval");
  upCmd.action((alias, options) => {
    Promise.resolve().then(async () => {
      if (options.heartbeat !== undefined) {
        manager.cfg.defaults.heartbeatSeconds = parseIntArg(options.heartbeat, "--heartbeat", { min: 0, max: 86400 });
      }
      const result = await manager.up(alias, {
        remotePort: parsePort(options.port, "--port"),
        localPort: parsePort(options.localPort, "--local-port")
      });
      reporter.out("");
      reporter.out(`  local:    ${result.url}`);
      if (result.authUrl !== null && result.authUrl !== undefined) {
        reporter.out(`  auth:     ${result.authUrl}`);
        reporter.out(`            (one-time token; run 'logs ${alias}' if the page asks for a new URL)`);
      } else {
        reporter.out(`  auth:     — run 'logs ${alias}' for the printed dsh web URL (it may carry a one-time token)`);
      }
      reporter.out(`  remote:   127.0.0.1:${result.remotePort} (unit ${result.unit})`);
      reporter.out(`  registry: ${result.registryPath} — port ${result.remotePort} in-use by ${result.unit.replace(/^dsh-web-/, "")}`);
      reporter.out(`  stop:     dsh --profile remote down ${alias}   (or Ctrl+C)`);
      reporter.out("");
      if (options.open === true) manager.open(alias, result.authUrl ?? undefined);
      // stays resident: the tunnel supervisor keeps this process alive
    }).then(() => { /* resident */ }, (error) => { printError(error); exit?.(1); });
  });
  upCmd.showHelpAfterError();

  // ---- down ----------------------------------------------------------------
  const downCmd = program.command("down [host]")
    .description("stop the tunnel, release the registry entry, stop the remote unit")
    .option("--keep-service", "keep the remote dsh web unit running");
  downCmd.action((alias, options) => {
    Promise.resolve().then(async () => {
      const target = alias ?? onlyStateAlias();
      const result = await manager.down(target, { keepService: options.keepService === true });
      reporter.out(`✓ ${target} down`);
      if (result.released) reporter.out("  registry: released");
      if (result.serviceStopped) reporter.out("  service: stopped");
      reporter.out(`  remote port ${result.portFree ? "verified free" : "STILL LISTENING"}`);
      for (const warning of result.warnings) reporter.err(`  warning: ${warning}`);
    }).then(() => exit?.(0), (error) => { printError(error); exit?.(1); });
  });
  downCmd.showHelpAfterError();

  function onlyStateAlias() {
    const states = manager.listStatesLocal();
    if (states.length === 0) throw new TunnelError("no tunnels — nothing to stop", { code: "E_NOT_UP" });
    if (states.length > 1) {
      throw new TunnelError(`multiple tunnels (${states.map((s) => s.alias).join(", ")}) — pass the host name`, { code: "E_NOT_UP" });
    }
    return states[0].alias;
  }

  // ---- status --------------------------------------------------------------
  const statusCmd = program.command("status [host]")
    .description("local tunnel state + remote service state")
    .option("--json", "machine-readable output");
  statusCmd.action((alias, options) => {
    Promise.resolve().then(async () => {
      const target = alias ?? onlyStateAlias();
      const result = await manager.status(target);
      if (options.json === true) {
        reporter.out(JSON.stringify(result, null, 2));
        return;
      }
      const { local, remote } = result;
      reporter.out(`tunnel ${target}`);
      reporter.out(`  url:       ${local.url} ${local.urlResponds ? "(responding)" : "(NOT responding)"}`);
      reporter.out(`  ssh pid:   ${local.sshPid ?? "-"} ${local.pidAlive ? "(alive)" : "(dead)"}`);
      reporter.out(`  started:   ${local.startedAt}`);
      reporter.out(`  heartbeat: ${local.lastHeartbeatAt ?? "-"}`);
      reporter.out(`  remote:    ${local.host} port ${local.remotePort} (unit ${local.unit})`);
      if (remote.error !== undefined) reporter.out(`  remote status unavailable: ${remote.error}`);
      else {
        reporter.out(`  unit:      ${remote.unitActive}`);
        reporter.out(`  port:      ${remote.portListening ? "listening" : "NOT listening"}`);
        const row = remote.registryRow;
        reporter.out(`  registry:  ${row !== null && row !== undefined ? `port ${row.port} ${row.status} (${row.user})` : "no row"}`);
      }
    }).then(() => exit?.(0), (error) => { printError(error); exit?.(1); });
  });
  statusCmd.showHelpAfterError();

  // ---- list ----------------------------------------------------------------
  const listCmd = program.command("list")
    .description("local tunnels")
    .option("--json", "machine-readable output");
  listCmd.action((options) => {
    Promise.resolve().then(async () => {
      const states = manager.listStatesLocal();
      if (options.json === true) {
        reporter.out(JSON.stringify(states, null, 2));
        return;
      }
      if (states.length === 0) reporter.out("no local tunnels — 'up <host>' to create one");
      for (const s of states) {
        reporter.out(`${s.alias.padEnd(20)} ${s.url}  remote ${s.host}:${s.remotePort}  ssh pid ${s.sshPid ?? "-"}`);
      }
    }).then(() => exit?.(0), (error) => { printError(error); exit?.(1); });
  });
  listCmd.showHelpAfterError();

  // ---- logs ----------------------------------------------------------------
  const logsCmd = program.command("logs <host>")
    .description("remote dsh web logs (journalctl)")
    .option("--lines <n>", "number of lines", "100")
    .option("--follow", "stream the remote journal until Ctrl+C")
    .option("--local", "show the local tunnel log instead");
  logsCmd.action((alias, options) => {
    Promise.resolve().then(async () => {
      const { text } = await manager.logs(alias, {
        lines: parseIntArg(options.lines, "--lines", { min: 1, max: 100000 }),
        follow: options.follow === true,
        local: options.local === true
      });
      if (text.length > 0) reporter.out(text);
      // --follow stays resident until the stream closes or Ctrl+C
      if (!options.follow) exit?.(0);
    }).then(() => { /* follow mode stays resident */ }, (error) => { printError(error); exit?.(1); });
  });
  logsCmd.showHelpAfterError();

  // ---- audit ---------------------------------------------------------------
  const auditCmd = program.command("audit <host>")
    .description("registry vs. real port occupancy")
    .option("--json", "machine-readable output")
    .option("--release <port>", "mark one port released in the registry")
    .option("--clean-stale", "mark every stale in-use row released");
  auditCmd.action((alias, options) => {
    Promise.resolve().then(async () => {
      const { rows, changes } = await manager.audit(alias, {
        release: parsePort(options.release, "--release"),
        cleanStale: options.cleanStale === true
      });
      if (options.json === true) {
        reporter.out(JSON.stringify({ rows, changes }, null, 2));
        return;
      }
      const mark = { ok: "ok     ", stale: "STALE  ", orphan: "ORPHAN ", conflict: "CONFLICT" };
      for (const row of rows) {
        const extra = row.listenerProcess !== null && row.listenerProcess !== undefined
          ? ` ${row.listenerProcess}${row.listenerUser !== null && row.listenerUser !== undefined ? `(${row.listenerUser})` : ""}`
          : "";
        reporter.out(`${String(row.port).padEnd(6)} ${String(row.user).padEnd(10)} ${String(row.status).padEnd(9)} ${mark[row.verdict]}  ws=${row.workspace}  hb=${row.lastHeartbeat}${extra}`);
      }
      for (const change of changes) reporter.out(`✓ ${change}`);
      if (rows.length === 0) reporter.out("registry is empty");
    }).then(() => exit?.(0), (error) => { printError(error); exit?.(1); });
  });
  auditCmd.showHelpAfterError();

  // ---- open ----------------------------------------------------------------
  cmd("open [host]", "open the local URL in the browser", async (alias) => {
    const url = manager.open(alias ?? onlyStateAlias());
    reporter.out(`opening ${url}`);
  });

  // ---- config --------------------------------------------------------------
  const configCmd = program.command("config").description("show the resolved config / its file path");
  configCmd.command("show").description("print the resolved config").action(() => {
    const { config } = loadConfig(home);
    reporter.out(JSON.stringify(config, null, 2));
    exit?.(0);
  });
  configCmd.command("path").description("print the config file path").action(() => {
    const { path } = loadConfig(home);
    reporter.out(path);
    exit?.(0);
  });
  configCmd.action(() => {
    const { path, config } = loadConfig(home);
    reporter.out(`${path}\n`);
    reporter.out(JSON.stringify(config, null, 2));
    exit?.(0);
  });
  configCmd.showHelpAfterError();

  // No matching subcommand (including a bare invocation): print help.
  program.action(() => {
    program.help();
  });

  parseCmdline(ctx, program);
}
