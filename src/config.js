import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { TunnelError } from "./errors.js";

// Plugin config: $DSH_HOME/remote-tunnel/config.yaml — host definitions plus
// allocation/tunnel defaults. Created with documented defaults on first use.

export const DEFAULT_CONFIG = {
  // alias -> { host, port, user, workspace, remotePortRange?, identityFile? }
  hosts: {},
  // Keys the sidebar pane keeps out of its lists: a managed host's alias, or a
  // discovered candidate's `host:port`. A display preference — ~/.ssh/config is
  // never touched, and the CLI still lists everything.
  hiddenHosts: [],
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
  out.hiddenHosts = Array.isArray(user.hiddenHosts)
    ? user.hiddenHosts.filter((key) => typeof key === "string" && key.length > 0)
    : [];
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
    throw new TunnelError(`cannot parse ${path}: ${error.message}`, { code: "E_CONFIG" });
  }
  return { path, config: normalizeConfig(user) };
}

// Host definitions arrive from a form (the sidebar panel) or from the CLI, so
// they are validated here, once, before anything writes them to disk.
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const HOST_PATTERN = /^[A-Za-z0-9._:\[\]-]{1,255}$/;
const USER_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

/**
 * Validate one host definition.
 *
 * @param {{alias, host, port?, user?, workspace?}} input - raw form values.
 * @returns a normalized `{alias, host, port, user?, workspace?}` definition.
 * @throws TunnelError with code E_USAGE when a field cannot be trusted.
 */
export function validateHostInput(input = {}) {
  const alias = String(input.alias ?? "").trim();
  if (!ALIAS_PATTERN.test(alias)) {
    throw new TunnelError(`invalid alias "${alias}" — letters, digits and . _ @ - only (max 64, no leading dash)`, { code: "E_USAGE" });
  }
  const host = String(input.host ?? "").trim();
  if (!HOST_PATTERN.test(host)) {
    throw new TunnelError(`invalid host "${host}" — a hostname, IPv4 or (bracketed) IPv6 address`, { code: "E_USAGE" });
  }
  const port = Number.parseInt(input.port ?? 22, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TunnelError(`invalid port "${input.port}" — expected 1-65535`, { code: "E_USAGE" });
  }
  const rawUser = input.user === undefined || input.user === null ? "" : String(input.user).trim();
  if (rawUser !== "" && !USER_PATTERN.test(rawUser)) {
    throw new TunnelError(`invalid user "${rawUser}"`, { code: "E_USAGE" });
  }
  const rawWorkspace = input.workspace === undefined || input.workspace === null ? "" : String(input.workspace).trim();
  if (rawWorkspace !== "" && (rawWorkspace.length > 512 || /[\r\n"']/.test(rawWorkspace))) {
    // The remote unit renderer rejects quotes and newlines; refuse them here so
    // a panel form can never stage a definition that `up` must reject later.
    throw new TunnelError("invalid workspace path — no quotes or line breaks (max 512 chars)", { code: "E_USAGE" });
  }
  return {
    alias,
    host,
    port,
    ...(rawUser === "" ? {} : { user: rawUser }),
    ...(rawWorkspace === "" ? {} : { workspace: rawWorkspace })
  };
}

/** Validate one pane hide key: a host alias, or a candidate's `host:port`. */
export function validateHideKey(key) {
  const text = String(key ?? "").trim();
  if (text.length === 0 || text.length > 200 || /[\u0000-\u001f]/.test(text)) {
    throw new TunnelError("invalid host key — expected an alias or host:port", { code: "E_USAGE" });
  }
  return text;
}

/** Hide or reveal one entry in the pane's lists (pure; caller saves). */
export function toggleHidden(config, key, hidden) {
  const text = validateHideKey(key);
  const rest = (Array.isArray(config.hiddenHosts) ? config.hiddenHosts : []).filter((item) => item !== text);
  config.hiddenHosts = hidden === true ? [...rest, text] : rest;
  return { key: text, hidden: hidden === true };
}

/** Add or replace one host in a normalized config (pure; caller saves). */
export function upsertHost(config, entry, { overwrite = false } = {}) {
  if (config.hosts[entry.alias] !== undefined && !overwrite) {
    throw new TunnelError(`host "${entry.alias}" is already defined`, { code: "E_HOST_EXISTS" });
  }
  config.hosts[entry.alias] = {
    host: entry.host,
    port: entry.port,
    ...(entry.user === undefined ? {} : { user: entry.user }),
    ...(entry.workspace === undefined ? {} : { workspace: entry.workspace })
  };
  return config;
}

/** Remove one plugin-config host (pure; caller saves). */
export function dropHost(config, alias) {
  if (config.hosts[alias] === undefined) {
    throw new TunnelError(`no plugin-config host "${alias}"`, { code: "E_UNKNOWN_HOST" });
  }
  delete config.hosts[alias];
  return config;
}

export function saveConfig(home, config) {
  const path = configPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "# dsh-remote-tunnel config — see README.md for every option.\n" + yaml.dump(config, { lineWidth: 100 }), "utf8");
  return path;
}
