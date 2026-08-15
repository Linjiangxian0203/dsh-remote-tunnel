import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Local state: $DSH_HOME/remote-tunnel/state/<alias>.json — one file per
// active tunnel, so status/down work across separate invocations.

export function stateDir(home) {
  return join(home, "state");
}

export function stateFile(home, alias) {
  return join(stateDir(home), `${alias.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
}

export function readState(home, alias) {
  const path = stateFile(home, alias);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeState(home, alias, data) {
  mkdirSync(stateDir(home), { recursive: true });
  writeFileSync(stateFile(home, alias), JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2), "utf8");
}

export function removeState(home, alias) {
  rmSync(stateFile(home, alias), { force: true });
}

export function listStates(home) {
  mkdirSync(stateDir(home), { recursive: true });
  const out = [];
  for (const name of readdirSync(stateDir(home))) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(stateDir(home), name), "utf8")));
    } catch {
      // ignore corrupt state files
    }
  }
  return out.sort((a, b) => String(a.alias).localeCompare(String(b.alias)));
}

export function logDir(home) {
  return join(home, "logs");
}

export function logFile(home, alias) {
  return join(logDir(home), `${alias.replace(/[^a-zA-Z0-9_.-]/g, "_")}.log`);
}
