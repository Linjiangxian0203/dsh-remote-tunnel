import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Minimal ~/.ssh/config parser: enough for Host alias discovery and the
// fields a tunnel needs (HostName, Port, User, IdentityFile). `Include`
// directives are reported but not expanded.

const KEYWORDS = new Set(["hostname", "port", "user", "identityfile", "proxyjump", "hostkeyalias"]);

/** Locate the user's ssh config (Windows + POSIX). */
export function sshConfigPath() {
  return process.platform === "win32"
    ? join(process.env.USERPROFILE ?? homedir(), ".ssh", "config")
    : join(process.env.HOME ?? homedir(), ".ssh", "config");
}

/**
 * Parse ssh_config text into host blocks.
 * @returns {{ aliases: Array<{alias, host, port, user, identityFile, proxyJump}>, wildcard: object, includes: string[] }}
 */
export function parseSshConfig(text) {
  const aliases = [];
  const wildcard = {};
  const includes = [];
  let current = null; // {alias, host, port, user, identityFile, proxyJump}
  const lines = text.split(/\r?\n/);
  const startBlock = (name) => {
    if (name === "*") return null; // wildcard defaults accumulate separately
    current = { alias: name, host: null, port: null, user: null, identityFile: null, proxyJump: null };
    aliases.push(current);
    return current;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    // `Key Value` or `Key=Value`, case-insensitive key
    const match = /^(\S+?)\s*[= ]\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "host") {
      for (const name of value.split(/\s+/)) {
        if (name === "*") Object.assign(wildcard, {}); // marker only
        else startBlock(name);
      }
      continue;
    }
    if (key === "include") {
      includes.push(value);
      continue;
    }
    if (!KEYWORDS.has(key)) continue;
    const target = current ?? wildcard;
    if (key === "hostname") target.host = value;
    else if (key === "port") target.port = Number.parseInt(value, 10) || null;
    else if (key === "user") target.user = value;
    else if (key === "identityfile") target.identityFile = value;
    else if (key === "proxyjump") target.proxyJump = value;
    else if (key === "hostkeyalias") target.hostKeyAlias = value;
  }
  return { aliases, wildcard, includes };
}

/** Locate the user's known_hosts file (Windows + POSIX). */
export function knownHostsPath() {
  return process.platform === "win32"
    ? join(process.env.USERPROFILE ?? homedir(), ".ssh", "known_hosts")
    : join(process.env.HOME ?? homedir(), ".ssh", "known_hosts");
}

/**
 * Split one known_hosts host field into host and port.
 *
 * A non-default port is spelled `[host]:port`; a bare IPv6 literal keeps its
 * colons, so only a `host:digits` tail counts as a port. Patterns are dropped:
 * a wildcard cannot name one host to connect to.
 */
function splitKnownHost(name) {
  const text = name.trim();
  if (text.length === 0) return null;
  if (/[*?!]/.test(text)) return null;
  const bracketed = /^\[(.+)\]:(\d{1,5})$/.exec(text);
  if (bracketed !== null) return { host: bracketed[1], port: Number.parseInt(bracketed[2], 10) };
  const bare = /^([^:]+):(\d{1,5})$/.exec(text);
  if (bare !== null) return { host: bare[1], port: Number.parseInt(bare[2], 10) };
  return { host: text, port: 22 };
}

/**
 * Parse known_hosts text into candidate hosts.
 *
 * The file proves a host was connected to at least once, which is what the
 * sidebar's "discovered" list is for. Two kinds of line cannot be turned back
 * into a host and are counted instead of guessed at: hashed entries
 * (`|1|salt|hmac`, the OpenSSH default under HashKnownHosts) and the @revoked
 * marker. @cert-authority lines still name a real host, so they are kept.
 *
 * @returns {{ hosts: Array<{alias, host, port}>, hashed: number, revoked: number }}
 */
export function parseKnownHosts(text) {
  const hosts = [];
  const seen = new Set();
  let hashed = 0;
  let revoked = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    let index = 0;
    if (parts[index] !== undefined && parts[index].startsWith("@")) {
      const marker = parts[index].slice(1);
      index += 1;
      if (marker === "revoked") { revoked += 1; continue; }
    }
    const names = parts[index];
    if (names === undefined) continue;
    if (names.startsWith("|")) { hashed += 1; continue; }
    for (const name of names.split(",")) {
      const parsed = splitKnownHost(name);
      if (parsed === null) continue;
      const key = parsed.host + ":" + parsed.port;
      if (seen.has(key)) continue;
      seen.add(key);
      hosts.push({
        // The suggested alias is the host itself on the default port, and the
        // known_hosts spelling (`host:port`, or `[v6]:port`) otherwise.
        alias: parsed.port === 22
          ? parsed.host
          : parsed.host.includes(":") ? `[${parsed.host}]:${parsed.port}` : `${parsed.host}:${parsed.port}`,
        host: parsed.host,
        port: parsed.port
      });
    }
  }
  return { hosts, hashed, revoked };
}

/** Read and parse the user's known_hosts; empty result when absent. */
export function readKnownHosts() {
  const path = knownHostsPath();
  if (!existsSync(path)) return { hosts: [], hashed: 0, revoked: 0, path, exists: false };
  return { ...parseKnownHosts(readFileSync(path, "utf8")), path, exists: true };
}

/** Read and parse the user's ~/.ssh/config; empty result when absent. */
export function readSshConfig() {
  const path = sshConfigPath();
  if (!existsSync(path)) return { aliases: [], wildcard: {}, includes: [], path };
  return { ...parseSshConfig(readFileSync(path, "utf8")), path };
}

/** Resolve one ssh-config alias with wildcard defaults applied. */
export function findSshAlias(parsed, alias) {
  const entry = parsed.aliases.find((item) => item.alias === alias);
  if (entry === undefined) return undefined;
  return {
    alias,
    host: entry.host ?? parsed.wildcard.host ?? alias,
    port: entry.port ?? parsed.wildcard.port ?? 22,
    user: entry.user ?? parsed.wildcard.user ?? null,
    identityFile: entry.identityFile ?? parsed.wildcard.identityFile ?? null,
    proxyJump: entry.proxyJump ?? parsed.wildcard.proxyJump ?? null
  };
}
