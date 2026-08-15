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
