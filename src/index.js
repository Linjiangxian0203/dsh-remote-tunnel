import { join } from "node:path";
import { homedir } from "node:os";
import { runCli } from "./cli.js";
import { TunnelManager } from "./manager.js";
import { registerSlashCommands } from "./service.js";
import { registerWebRoutes } from "./web.js";

// dsh-remote-tunnel — Remote Host Tunnel Manager bundle entry.
// One row serves two modes, chosen at apply time:
//   - CLI mode: this profile owns the argument snapshot (a dedicated profile
//     such as `dsh --profile remote ...`). Parse and run the subcommand, then
//     exit through the launcher's appExit.
//   - Service mode: the web (or desktop) app owns the command line. Register
//     the /remote slash commands and provide the tunnel service.
export const name = "remote-tunnel";
export const inject = ["cmdlineArgs"];

/** Profiles that host a long-lived dsh UI: they own the command line. */
const SERVICE_PROFILES = new Set(["web", "desktop"]);

/** $DSH_HOME/remote-tunnel fallback when the row config is absent. */
export function defaultHome() {
  const base = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(base, "remote-tunnel");
}

/**
 * Pick the mode for this row.
 *
 * `profileContext` is provided by the profile boot *before* any row mounts, so
 * it is the race-free source of truth (present on the 0.1.7-rc.1 CLI, on the
 * 0.2.0-rc.2 desktop runtime and later). `webStartup` is provided by a
 * neighbouring row and rows initialise concurrently, so it is only a fallback —
 * and a one-way one: it may promote this row to `service`, never demote it to
 * `cli`. Getting that wrong means `program.help()` → `appExit(0)` → the whole
 * web/desktop host process exits (docs/desktop-web-refactor-route.md, P0-1).
 */
export function resolveMode(ctx) {
  const profileName = ctx.get("profileContext")?.name;
  if (SERVICE_PROFILES.has(profileName)) return "service";
  if (ctx.get("webStartup") !== undefined) return "service";
  return "cli";
}

export function apply(ctx, config) {
  const home = typeof config?.home === "string" && config.home.length > 0 ? config.home : defaultHome();
  // cmdlineArgs is injected, so it is mounted before this runs: freeze the argv
  // snapshot the CLI half parses. Service mode never reads it.
  ctx.get("cmdlineArgs").get();
  if (resolveMode(ctx) === "service") {
    applyService(ctx, home, {
      // How a tunnel should be opened, and whether the panel opens by itself at
      // startup. Both become editable in 设置 → 插件 once the Config schema lands.
      openIn: typeof config?.openIn === "string" ? config.openIn : "ask",
      autoOpen: config?.autoOpen === true
    });
    return;
  }
  runCli(ctx, home);
}

/**
 * Service mode: one tunnel manager, shared by the `/remote` slash command and
 * the browser half's HTTP routes. `ctx.inject` waits for each service instead
 * of racing the rows that provide it (rows mount concurrently).
 */
function applyService(ctx, home, settings) {
  const manager = new TunnelManager({
    home,
    reporter: { out() {}, err() {}, event() {} }
  });
  ctx.effect(() => () => manager.dispose(), "remote-tunnel.service");
  // Service readiness is exposed through the state route: a service that never
  // mounts is otherwise silent, and that silence is worth being able to read.
  const services = { commands: false, webServer: false, startedAt: new Date().toISOString() };
  ctx.inject(["commands"], (scoped) => {
    services.commands = true;
    registerSlashCommands(scoped, manager);
  });
  ctx.inject(["webServer"], (scoped) => {
    services.webServer = true;
    registerWebRoutes(scoped, manager, services, settings);
  });
}
