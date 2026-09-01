import { join } from "node:path";
import { homedir } from "node:os";
import { runCli } from "./cli.js";
import { registerSlashCommands } from "./service.js";

// dsh-remote-tunnel — Remote Host Tunnel Manager bundle entry.
// One row serves two modes, chosen at apply time:
//   - CLI mode: this profile owns the argument snapshot (a dedicated profile
//     such as `dsh --profile remote ...`). Parse and run the subcommand, then
//     exit through the launcher's appExit.
//   - Service mode: the web app owns the command line. Register the /remote
//     slash commands and provide the tunnel service.
export const name = "remote-tunnel";
export const inject = ["cmdlineArgs"];

/** $DSH_HOME/remote-tunnel fallback when the row config is absent. */
export function defaultHome() {
  const base = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(base, "remote-tunnel");
}

export function apply(ctx, config) {
  const home = typeof config?.home === "string" && config.home.length > 0 ? config.home : defaultHome();
  const args = ctx.get("cmdlineArgs").get();
  // The web app's startup row mounts `webStartup` when it owns the argument
  // snapshot; its presence (not the shape of process.argv) decides the mode,
  // so renamed/copied web profiles route correctly too.
  if (ctx.get("webStartup") === undefined) {
    runCli(ctx, home);
    return;
  }
  registerSlashCommands(ctx, home);
}
