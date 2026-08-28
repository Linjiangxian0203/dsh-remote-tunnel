import { execRemote, canSudo } from "../ssh.js";
import { TunnelError } from "../errors.js";

// Remote dsh web lifecycle as a systemd unit, in one of two scopes:
//   system — /etc/systemd/system/dsh-web-<user>.service via passwordless sudo
//            (the multi-account layout from the task brief)
//   user   — ~/.config/systemd/user/dsh-web.service, NO sudo needed;
//            requires a running systemd --user session (loginctl enable-linger
//            makes it survive logout; a user can enable self-linger).
// `unit.type: auto` (default) picks system when sudo works, else user.

export function unitNameFor(cfg, user, scope) {
  const sanitized = user.replace(/[^a-zA-Z0-9_.-]/g, "-").toLowerCase();
  return scope === "system" ? `${cfg.defaults.unit.prefix}${sanitized}` : cfg.defaults.unit.prefix.replace(/-$/, "");
}

/**
 * Paths we interpolate into unit values. Verified against systemd-analyze
 * (255): WorkingDirectory takes the raw remainder of the line (spaces fine,
 * quotes would become literal and break it), while Environment= assignments
 * and the ExecStart executable token honor double quotes — so only those two
 * get quoted. Quotes/newlines are not representable in any of these slots;
 * reject them with a clear hint instead of writing a corrupt unit.
 */
function assertRenderablePath(field, value) {
  if (/["\r\n\t]/.test(value)) {
    throw new TunnelError(
      `${field} "${value}" contains characters a systemd unit cannot carry (quotes/newlines) — use a path without them`,
      { code: "E_UNIT_PATH" }
    );
  }
}

function renderSystemUnit(cfg, { user, home, workspace, dshPath, port, name }) {
  return `[Unit]
Description=dsh web (${user} on 127.0.0.1:${port})
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${workspace}
Environment="HOME=${home}"
Environment="DSH_HOME=${home}/.dsh"
ExecStart="${dshPath}" --profile web --port ${port}
Restart=on-failure
RestartSec=${cfg.defaults.unit.restartSec}

[Install]
WantedBy=multi-user.target
`;
}

function renderUserUnit(cfg, { user, home, workspace, dshPath, port, name }) {
  return `[Unit]
Description=dsh web (${user} on 127.0.0.1:${port})

[Service]
Type=simple
WorkingDirectory=${workspace}
Environment="DSH_HOME=${home}/.dsh"
ExecStart="${dshPath}" --profile web --port ${port}
Restart=on-failure
RestartSec=${cfg.defaults.unit.restartSec}

[Install]
WantedBy=default.target
`;
}

export function renderUnitBody(cfg, scope, { user, home, workspace, dshPath, port, name }) {
  assertRenderablePath("home", home);
  assertRenderablePath("workspace", workspace);
  assertRenderablePath("dshPath", dshPath);
  return scope === "system"
    ? renderSystemUnit(cfg, { user, home, workspace, dshPath, port, name })
    : renderUserUnit(cfg, { user, home, workspace, dshPath, port, name });
}

/**
 * A resolved unit scope: how every systemctl/journalctl call is prefixed.
 */
export class UnitScope {
  constructor({ type, unit, facts }) {
    this.type = type;      // 'system' | 'user'
    this.unit = unit;
    this.facts = facts;    // remote facts (home etc.)
  }

  get servicePath() {
    return this.type === "system"
      ? `/etc/systemd/system/${this.unit}.service`
      : `${this.facts.home}/.config/systemd/user/${this.unit}.service`;
  }

  ctl(verb, args = []) {
    return this.type === "system"
      ? ["sudo", "-n", "systemctl", verb, ...args]
      : ["systemctl", "--user", verb, ...args];
  }

  async run(hostDef, cfg, ctx, cmd, { stdin, timeoutMs = 60000 } = {}) {
    return execRemote(hostDef, cmd.join(" "), { cfg, stdin, timeoutMs });
  }

  /** Current port in the installed unit's ExecStart (or null when absent). */
  async port(hostDef, cfg, ctx) {
    const result = await execRemote(hostDef, `cat "${this.servicePath}" 2>/dev/null | grep -o -m1 -E '--port [0-9]+' | awk '{print $2}'`, { cfg, timeoutMs: 30000 });
    return result.stdout.trim() || null;
  }

  async exists(hostDef, cfg, ctx) {
    const result = await execRemote(hostDef, `test -f "${this.servicePath}" && echo yes || echo no`, { cfg, timeoutMs: 30000 });
    return result.stdout.trim() === "yes";
  }

  async activeState(hostDef, cfg, ctx) {
    const result = await this.run(hostDef, cfg, ctx, this.ctl("is-active", [this.unit]), { timeoutMs: 30000 });
    return result.stdout.trim() || "unknown";
  }

  async write(hostDef, cfg, ctx, body) {
    let result;
    if (this.type === "system") {
      result = await this.run(hostDef, cfg, ctx, ["sudo", "-n", "tee", this.servicePath], { stdin: body });
    } else {
      const mkdirResult = await execRemote(hostDef, `mkdir -p "${this.facts.home}/.config/systemd/user"`, { cfg, timeoutMs: 30000 });
      if (mkdirResult.code !== 0) {
        return mkdirResult;
      }
      result = await this.run(hostDef, cfg, ctx, ["tee", this.servicePath], { stdin: body });
    }
    return result;
  }

  async reload(hostDef, cfg, ctx) {
    return this.run(hostDef, cfg, ctx, this.ctl("daemon-reload"), { timeoutMs: 60000 });
  }

  async enable(hostDef, cfg, ctx) {
    return this.run(hostDef, cfg, ctx, this.ctl("enable", [this.unit]), { timeoutMs: 60000 });
  }

  async restart(hostDef, cfg, ctx) {
    return this.run(hostDef, cfg, ctx, this.ctl("restart", [this.unit]), { timeoutMs: 90000 });
  }

  async stop(hostDef, cfg, ctx) {
    return this.run(hostDef, cfg, ctx, this.ctl("stop", [this.unit]), { timeoutMs: 60000 });
  }

  async journal(hostDef, cfg, ctx, lines) {
    const args = this.type === "system"
      ? ["sudo", "-n", "journalctl", "-u", this.unit, "-n", String(lines), "--no-pager"]
      : ["journalctl", "--user-unit", this.unit, "-n", String(lines), "--no-pager"];
    const result = await this.run(hostDef, cfg, ctx, args, { timeoutMs: 60000 });
    if (result.code !== 0) {
      throw new TunnelError(`journalctl failed: ${result.stderr.trim() || `exit ${result.code}`}`, {
        code: "E_UNIT_LOG",
        hint: this.type === "system" ? "reading another user's unit logs needs sudo, or membership of the systemd-journal/adm groups" : undefined
      });
    }
    return result.stdout;
  }

  /** True when the unit's recent journal mentions EADDRINUSE (TOCTOU bind race). */
  async bindFailed(hostDef, cfg, ctx) {
    const args = this.type === "system"
      ? ["sudo", "-n", "journalctl", "-u", this.unit, "-n", "50", "--no-pager", "2>/dev/null", "|", "grep", "-m1", "-E", "EADDRINUSE"]
      : ["journalctl", "--user-unit", this.unit, "-n", "50", "--no-pager", "2>/dev/null", "|", "grep", "-m1", "-E", "EADDRINUSE"];
    const result = await this.run(hostDef, cfg, ctx, args, { timeoutMs: 30000 });
    return result.code === 0 && result.stdout.trim().length > 0;
  }
}

/**
 * Pick the unit scope for a host: system when passwordless sudo exists
 * (or is forced), else user scope when a --user session answers.
 */
export async function resolveUnitScope(hostDef, cfg, ctx, facts, user) {
  const type = cfg.defaults.unit.type ?? "auto";
  const sudoState = ctx.sudoState;
  if (sudoState.canSudo === undefined) sudoState.canSudo = await canSudo(hostDef, cfg);

  if (type === "system" && !sudoState.canSudo) {
    throw new TunnelError("unit.type is 'system' but the remote host has no passwordless sudo", {
      code: "E_UNIT",
      hint: "grant NOPASSWD sudo, or set unit.type to 'auto'/'user' in the plugin config"
    });
  }
  if (type !== "user" && sudoState.canSudo) {
    return new UnitScope({ type: "system", unit: unitNameFor(cfg, user, "system"), facts });
  }
  const probe = await execRemote(hostDef, "systemctl --user is-system-running 2>&1 || true", { cfg, timeoutMs: 30000 });
  const state = probe.stdout.trim();
  if (state === "running" || state === "degraded") {
    return new UnitScope({ type: "user", unit: unitNameFor(cfg, user, "user"), facts });
  }
  if (type === "user") {
    throw new TunnelError("unit.type is 'user' but no systemd --user session is running over ssh", {
      code: "E_UNIT",
      hint: "enable lingering: loginctl enable-linger <user>, then reconnect"
    });
  }
  throw new TunnelError("no usable unit scope: passwordless sudo unavailable and no systemd --user session", {
    code: "E_UNIT",
    hint: "either grant NOPASSWD sudo (system unit) or enable lingering (loginctl enable-linger <user>) for a user unit"
  });
}

/** Install (or update) the unit with the given port and restart the service. */
export async function provisionUnit(hostDef, cfg, ctx, scope, { user, home, workspace, dshPath, port }) {
  const body = renderUnitBody(cfg, scope.type, { user, home, workspace, dshPath, port, name: scope.unit });

  const write = await scope.write(hostDef, cfg, ctx, body);
  if (write.code !== 0) {
    throw new TunnelError(`cannot write unit ${scope.servicePath}: ${write.stderr.trim() || `exit ${write.code}`}`, {
      code: "E_UNIT_WRITE",
      hint: scope.type === "system" ? "provisioning needs passwordless sudo on the remote host (see README: sudoers setup)" : "check write access to ~/.config/systemd/user"
    });
  }

  const reload = await scope.reload(hostDef, cfg, ctx);
  if (reload.code !== 0) {
    throw new TunnelError(`systemctl daemon-reload failed: ${reload.stderr.trim() || `exit ${reload.code}`}`, { code: "E_UNIT" });
  }

  const enable = await scope.enable(hostDef, cfg, ctx);
  if (enable.code !== 0) {
    throw new TunnelError(`systemctl enable ${scope.unit} failed: ${enable.stderr.trim() || enable.stdout.trim() || `exit ${enable.code}`}`, { code: "E_UNIT" });
  }

  const restart = await scope.restart(hostDef, cfg, ctx);
  if (restart.code !== 0) {
    throw new TunnelError(`systemctl restart ${scope.unit} failed: ${restart.stderr.trim() || `exit ${restart.code}`}`, { code: "E_UNIT" });
  }
  return { unit: scope.unit, scope: scope.type, body };
}

/** Check/enable linger for user-scope units (a user may enable self-linger). */
export async function ensureLinger(hostDef, cfg, ctx, scope, user) {
  if (scope.type !== "user") return { ok: true, linger: "n/a" };
  const check = await execRemote(hostDef, `loginctl show-user "${user}" -p Linger 2>/dev/null | cut -d= -f2`, { cfg, timeoutMs: 30000 });
  let linger = check.stdout.trim();
  if (linger !== "yes") {
    const enable = await execRemote(hostDef, `loginctl enable-linger "${user}" 2>&1`, { cfg, timeoutMs: 30000 });
    const recheck = await execRemote(hostDef, `loginctl show-user "${user}" -p Linger 2>/dev/null | cut -d= -f2`, { cfg, timeoutMs: 30000 });
    linger = recheck.stdout.trim();
    if (linger !== "yes") {
      return {
        ok: false,
        linger,
        detail: enable.stderr.trim() || enable.stdout.trim() || "loginctl enable-linger failed"
      };
    }
  }
  return { ok: true, linger };
}
