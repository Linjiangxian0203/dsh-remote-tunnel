import { TunnelManager } from "./manager.js";
import { TunnelError } from "./errors.js";

// dsh-remote-tunnel service half: registers the `/remote` slash command on
// the web surface. The handler runs in the host process (where ssh and the
// tunnel supervisor live), so the web panel can drive the same manager the
// CLI uses.

const USAGE = "/remote hosts | check <host> | up <host> [--open] | down [host] | status [host] | audit <host> | open [host]";

export function registerSlashCommands(ctx, home) {
  const commands = ctx.get("commands");
  if (commands === undefined) return;

  const manager = new TunnelManager({
    home,
    reporter: { out() {}, err() {}, event() {} }
  });
  ctx.effect(() => {
    return () => manager.dispose();
  }, "remote-tunnel.service");

  commands.register({
    name: "remote",
    description: "remote host tunnel manager: list/check/up/down/status/audit remote dsh web tunnels",
    input: { hint: "hosts | check <host> | up <host> | down | status | audit <host>" },
    handler: async (invocation) => {
      const tokens = invocation.rawInput.trim().split(/\s+/).filter((t) => t.length > 0);
      const sub = tokens[0];
      try {
        switch (sub) {
          case undefined:
          case "help":
            return { kind: "success", text: USAGE };
          case "hosts": {
            const hosts = manager.listHosts();
            if (hosts.length === 0) return { kind: "success", text: "no hosts defined — use the remote-tunnel profile: 'dsh --profile remote hosts add <alias> --host <ip>'" };
            return { kind: "success", text: hosts.map((h) => `${h.alias}  ${h.host}:${h.port}  [${h.origin}]`).join("\n") };
          }
          case "check": {
            requireArg(tokens, 1, "check <host>");
            const { steps } = await manager.check(tokens[1]);
            return { kind: "success", text: steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.name}: ${s.detail}`).join("\n") };
          }
          case "up": {
            // Split flags from the host name: `up <host> [--open]`. A bare
            // `--open` must not be mistaken for the host.
            const rest = tokens.slice(1).filter((t) => !t.startsWith("--"));
            const wantOpen = tokens.slice(1).includes("--open");
            if (rest.length === 0) throw new TunnelError("missing argument — up <host> [--open]", { code: "E_USAGE" });
            const result = await manager.up(rest[0], {});
            if (wantOpen) {
              try { manager.open(rest[0]); } catch { /* the URL is already in the reply */ }
            }
            return { kind: "success", text: [`tunnel up for ${result.alias}`, `local: ${result.url}`, `remote: 127.0.0.1:${result.remotePort} (unit ${result.unit})`, `workspace: ${result.workspace}`, `stop: /remote down ${result.alias} or CLI 'down'`].join("\n") };
          }
          case "down": {
            const alias = tokens[1] ?? onlyStateAlias(manager);
            const result = await manager.down(alias, {});
            const lines = [`${alias} down`];
            if (result.released) lines.push("registry: released");
            if (result.serviceStopped) lines.push("service: stopped");
            lines.push(`remote port ${result.portFree ? "verified free" : "STILL LISTENING"}`);
            return { kind: "success", text: lines.join("\n") };
          }
          case "status": {
            const alias = tokens[1] ?? onlyStateAlias(manager);
            const { local, remote } = await manager.status(alias);
            const lines = [
              `tunnel ${alias}`,
              `url: ${local.url} ${local.urlResponds ? "(responding)" : "(NOT responding)"}`,
              `ssh pid: ${local.sshPid ?? "-"} ${local.pidAlive ? "(alive)" : "(dead)"}`,
              `remote: ${local.host}:${local.remotePort} (unit ${local.unit})`
            ];
            if (remote.error !== undefined) lines.push(`remote unavailable: ${remote.error}`);
            else {
              lines.push(`unit: ${remote.unitActive}`);
              lines.push(`port: ${remote.portListening ? "listening" : "NOT listening"}`);
            }
            return { kind: "success", text: lines.join("\n") };
          }
          case "audit": {
            requireArg(tokens, 1, "audit <host>");
            const { rows, changes } = await manager.audit(tokens[1], {});
            const lines = rows.map((r) => `${r.port}  ${r.user}  ${r.status}  ${r.verdict}`);
            if (rows.length === 0) lines.push("registry is empty");
            lines.push(...changes);
            return { kind: "success", text: lines.join("\n") };
          }
          case "open": {
            const alias = tokens[1] ?? onlyStateAlias(manager);
            const url = manager.open(alias);
            return { kind: "success", text: `opening ${url}` };
          }
          default:
            return { kind: "error", text: `unknown /remote subcommand "${sub}". ${USAGE}` };
        }
      } catch (error) {
        const message = error instanceof TunnelError
          ? `${error.message}${error.hint !== undefined ? `\nhint: ${error.hint}` : ""}`
          : error instanceof Error ? error.message : String(error);
        return { kind: "error", text: message };
      }
    }
  });
}

function requireArg(tokens, index, usage) {
  if (tokens[index] === undefined) throw new TunnelError(`missing argument — ${usage}`, { code: "E_USAGE" });
}

function onlyStateAlias(manager) {
  const states = manager.listStatesLocal();
  if (states.length === 0) throw new TunnelError("no tunnels — /remote up <host> first", { code: "E_NOT_UP" });
  if (states.length > 1) throw new TunnelError(`multiple tunnels (${states.map((s) => s.alias).join(", ")}) — pass the host name`, { code: "E_NOT_UP" });
  return states[0].alias;
}
