import { spawn } from "node:child_process";
import { TunnelError } from "./errors.js";
import { findSshAlias } from "./ssh-config.js";

// SSH client: exec with captured output, spawn for long-lived processes.
// Everything is BatchMode (no password prompts, no hangs) with a connect
// timeout. Hosts are referenced by their ~/.ssh/config alias whenever
// possible so the user's port/user/IdentityFile/ProxyJump apply verbatim.
// DSH_REMOTE_TUNNEL_SSH overrides the ssh binary (used by the mock tests).

export function commonSshArgs(cfg, { clearForwardings = true } = {}) {
  const ssh = cfg.defaults.ssh;
  return [
    "-o", "BatchMode=yes",
    // See config.js: ssh.connectTimeout — 0 (default) omits the option,
    // because on some servers ConnectTimeout makes every connection wait out
    // the full timeout even when the connect itself is instant.
    ...(ssh.connectTimeout > 0 ? ["-o", `ConnectTimeout=${ssh.connectTimeout}`] : []),
    "-o", "StrictHostKeyChecking=accept-new",
    // ClearAllForwardings drops config-file forwards so exec sessions skip
    // negotiating unrelated Local/RemoteForward entries. NOTE: it ALSO clears
    // command-line -L/-R forwards (verified on Windows OpenSSH 8.1p1), so the
    // long-lived tunnel disables it — the tunnel needs its own -L to survive.
    ...(clearForwardings ? ["-o", "ClearAllForwardings=yes"] : []),
    ...ssh.extraArgs
  ];
}

/** Target tokens that make `ssh <tokens>` reach the host. */
export function sshTargetArgs(hostDef) {
  if (hostDef.fromSshConfig) return [hostDef.alias];
  const args = [];
  if (hostDef.port && hostDef.port !== 22) args.push("-p", String(hostDef.port));
  args.push(hostDef.user ? `${hostDef.user}@${hostDef.host}` : hostDef.host);
  return args;
}

export function spawnSsh(hostDef, args, { cfg, stdin, onLine, clearForwardings = true } = {}) {
  const sshCmd = (process.env.DSH_REMOTE_TUNNEL_SSH ?? "ssh").split(/\s+/).filter((t) => t.length > 0);
  const child = spawn(sshCmd[0], [...sshCmd.slice(1), ...commonSshArgs(cfg, { clearForwardings }), ...sshTargetArgs(hostDef), ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  if (stdin !== undefined) {
    child.stdin.write(stdin);
  }
  // Always close stdin (ssh -n semantics): commands that read no input must
  // not wait on a pipe that never ends.
  child.stdin.end();
  if (onLine !== undefined) {
    for (const [stream, name] of [[child.stdout, "out"], [child.stderr, "err"]]) {
      let buffer = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n")) !== -1) {
          onLine({ name, line: buffer.slice(0, index) });
          buffer = buffer.slice(index + 1);
        }
      });
      stream.on("end", () => {
        if (buffer.length > 0) onLine({ name, line: buffer });
      });
    }
  }
  return child;
}

/** Run one remote command, returning { code, stdout, stderr }. */
export function execRemote(hostDef, cmd, { cfg, stdin, timeoutMs = 60000, env } = {}) {
  return new Promise((resolve, reject) => {
    const args = env === undefined ? [cmd] : ["env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), cmd];
    const child = spawnSsh(hostDef, args, { cfg, stdin });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new TunnelError(`ssh command timed out after ${Math.round(timeoutMs / 1000)}s: ${cmd}`, { code: "E_SSH_TIMEOUT" }));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new TunnelError(`cannot run ssh: ${error.message}. Is the OpenSSH client installed and on PATH?`, {
        code: "E_SSH_NOT_FOUND"
      }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Probe passwordless sudo once per host connection. */
export async function canSudo(hostDef, cfg) {
  const result = await execRemote(hostDef, "sudo -n true 2>/dev/null", { cfg, timeoutMs: 15000 });
  return result.code === 0;
}

/** Resolve the sudo prefix for the configured policy. */
export async function sudoPrefix(hostDef, cfg, state = {}) {
  const policy = cfg.defaults.registry.sudo;
  if (policy === "never") return [];
  if (policy === "always") return ["sudo", "-n"];
  if (state.canSudo === undefined) state.canSudo = await canSudo(hostDef, cfg);
  return state.canSudo ? ["sudo", "-n"] : [];
}

/** Resolve remote facts: login user, home, node path, dsh path. */
export async function remoteFacts(hostDef, cfg) {
  const identity = await execRemote(hostDef, "id -un", { cfg, timeoutMs: 20000 });
  if (identity.code !== 0) {
    throw new TunnelError(`ssh to ${hostDef.alias} failed: ${identity.stderr.trim() || `exit ${identity.code}`}`, { code: "E_SSH_CONNECT" });
  }
  const user = identity.stdout.trim();
  const [home, node, dsh] = await Promise.all([
    execRemote(hostDef, `getent passwd ${user} 2>/dev/null | cut -d: -f6 || true`, { cfg, timeoutMs: 20000 }),
    execRemote(hostDef, "command -v node || true", { cfg, timeoutMs: 20000 }),
    execRemote(hostDef, "command -v dsh || true", { cfg, timeoutMs: 20000 })
  ]);
  let homeDir = home.stdout.trim();
  if (homeDir.length === 0) {
    const fallback = await execRemote(hostDef, "printf '%s' \"$HOME\"", { cfg, timeoutMs: 20000 });
    homeDir = fallback.stdout.trim();
  }
  // per-account npm-global installs may be invisible to the ssh channel's PATH
  // (rc files differ per account); probe the standard location as a fallback.
  let dshPath = dsh.stdout.trim() || null;
  if (dshPath === null) {
    const alt = await execRemote(hostDef, 'test -x "$HOME/.npm-global/bin/dsh" && printf "%s\\n" "$HOME/.npm-global/bin/dsh" || true', { cfg, timeoutMs: 20000 });
    dshPath = alt.stdout.trim() || null;
  }
  return {
    user,
    home: homeDir,
    nodePath: node.stdout.trim() || null,
    dshPath
  };
}
