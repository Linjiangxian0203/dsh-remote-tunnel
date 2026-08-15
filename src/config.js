import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";

// Plugin config: $DSH_HOME/remote-tunnel/config.yaml — host definitions plus
// allocation/tunnel defaults. Created with documented defaults on first use.

export const DEFAULT_CONFIG = {
  // alias -> { host, port, user, workspace, remotePortRange?, identityFile? }
  hosts: {},
  defaults: {
    // remote dsh web port range (first free port wins, checked on the server)
    remotePortRange: [3080, 3119],
    // local tunnel port range
    localPortRange: [3081, 3140],
    registry: {
      path: "/etc/dsh-ports.tsv",
      lockPath: "/etc/dsh-ports.lock",
      // auto: use sudo when `sudo -n true` succeeds, else write directly
      sudo: "auto",
      // used when the shared registry is not writable by this account:
      // relative paths live under the remote home
      fallbackPath: ".dsh-ports.tsv"
    },
    unit: {
      prefix: "dsh-web-",
      restartSec: 5,
      // auto: system unit when passwordless sudo exists, else a systemd --user unit
      type: "auto"
    },
    heartbeatSeconds: 120,
    remoteWaitSeconds: 60,
    localWaitSeconds: 15,
    reconnect: {
      delaysMs: [1000, 2000, 4000, 8000, 15000, 30000],
      maxAttempts: 0 // 0 = keep reconnecting forever
    },
    allocateRetries: 5,
    ssh: {
      // 0 = do not pass -o ConnectTimeout. On some servers setting it makes
      // EVERY connection wait out the timeout even when the connect is
      // instant; execRemote's own timeout still guards hung sessions.
      connectTimeout: 0,
      extraArgs: []
    }
  }
};

export function configPath(home) {
  return join(home, "config.yaml");
}

/** Merge user config over defaults (shallow per top-level section). */
export function normalizeConfig(user = {}) {
  const out = structuredClone(DEFAULT_CONFIG);
  out.hosts = user.hosts ?? {};
  for (const [key, value] of Object.entries(user.defaults ?? {})) {
    out.defaults[key] = typeof value === "object" && value !== null && !Array.isArray(value)
      ? { ...out.defaults[key], ...value }
      : value;
  }
  return out;
}

/** Load config.yaml, creating it with defaults when absent. */
export function loadConfig(home) {
  const path = configPath(home);
  mkdirSync(home, { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, "# dsh-remote-tunnel config — see README.md for every option.\n" + yaml.dump(structuredClone(DEFAULT_CONFIG), { lineWidth: 100 }), "utf8");
  }
  let user;
  try {
    user = yaml.load(readFileSync(path, "utf8")) ?? {};
  } catch (error) {
    throw new TunnelConfigError(`cannot parse ${path}: ${error.message}`);
  }
  return { path, config: normalizeConfig(user) };
}

export function saveConfig(home, config) {
  const path = configPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "# dsh-remote-tunnel config — see README.md for every option.\n" + yaml.dump(config, { lineWidth: 100 }), "utf8");
  return path;
}

class TunnelConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "TunnelConfigError";
  }
}
