#!/usr/bin/env node
// Fake `ssh` for dsh-remote-tunnel integration tests. It plays a remote Linux
// host against a fake filesystem rooted at DSH_MOCK_ROOT, executes the exact
// remote command protocols the plugin emits (flock+sh allocation, awk-style
// registry update, tee, systemctl/journalctl/loginctl, node probes), and for
// `ssh -N -L ...` it really forwards TCP to 127.0.0.1:<remote-port>, where a
// detached mock-remote-server.js child serves the fake dsh web.

import { createServer, connect } from "node:net";
import { spawn } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync,
  openSync, closeSync, unlinkSync
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.DSH_MOCK_ROOT;
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(HERE, "remote-server.js");
const DEFAULT_USER = "mockuser";

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

// ---- fake server state -----------------------------------------------------

const fsPath = (...parts) => join(ROOT, ...parts);

/** Map a remote absolute path into the fake root (/etc/x -> <root>/etc/x). */
function mockPath(path) {
  if (path.startsWith("/")) return fsPath(...path.split("/").filter((s) => s.length > 0));
  return path;
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function services() {
  return readJson(fsPath("services.json"), {});
}

function saveServices(value) {
  writeJson(fsPath("services.json"), value);
}

function linger(user) {
  return readJson(fsPath("linger.json"), {})[user] ?? "no";
}

function setLinger(user, value) {
  const map = readJson(fsPath("linger.json"), {});
  map[user] = value;
  writeJson(fsPath("linger.json"), map);
}

// Fake owner/group metadata per file (filegroup.json). Only the group of the
// registry file matters: the shared-direct permission story (dshports group)
// depends on the file keeping its group across registry updates.
function fileGroups() {
  return readJson(fsPath("filegroup.json"), {});
}

function getFileGroup(path) {
  return fileGroups()[path] ?? null;
}

function setFileGroup(path, group) {
  const map = fileGroups();
  map[path] = group;
  writeJson(fsPath("filegroup.json"), map);
}

function journalPath(unit, user) {
  return fsPath("journal", `${user}--${unit}.log`);
}

function appendJournal(unit, user, line) {
  mkdirSync(fsPath("journal"), { recursive: true });
  appendFileSync(journalPath(unit, user), `${line}\n`, "utf8");
}

function serviceKey(unit, user) {
  return `${unit}@${user}`;
}

function unitFileFor(scope, unit, user) {
  return scope === "system"
    ? fsPath("etc", "systemd", "system", `${unit}.service`)
    : fsPath("home", user, ".config", "systemd", "user", `${unit}.service`);
}

function parseUnit(text) {
  const port = /ExecStart=.*--port (\d+)/.exec(text)?.[1];
  const user = /^User=(.+)$/m.exec(text)?.[1] ?? null;
  return { port: port !== undefined ? Number(port) : null, user };
}

async function killPid(pid) {
  if (pid === undefined || pid === null) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      child.on("close", () => resolve());
    });
  } else {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

async function startMockWeb(unit, port, scope, user) {
  appendJournal(unit, user, `systemctl: starting ${unit} on port ${port}`);
  const child = spawn(process.execPath, [SERVER_JS, String(port), journalPath(unit, user), user ?? ""], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const key = serviceKey(unit, user);
  const entry = services()[key] ?? {};
  const forcedEaddr = process.env.DSH_MOCK_EADDRINUSE_PORT !== undefined
    && Number(process.env.DSH_MOCK_EADDRINUSE_PORT) === port;
  if (forcedEaddr) {
    appendJournal(unit, user, `Error: listen EADDRINUSE: address already in use 127.0.0.1:${port}`);
    await killPid(child.pid);
    const all = services();
    all[key] = { ...entry, scope, unit, port, pid: null, active: false, user };
    saveServices(all);
    return { code: 1, stdout: "", stderr: `Job for ${unit}.service failed.` };
  }
  const all = services();
  all[key] = { ...entry, scope, unit, port, pid: child.pid, active: true, user };
  saveServices(all);
  return { code: 0, stdout: "", stderr: "" };
}

// ---- shell-ish tokenizer ---------------------------------------------------

function tokenize(str) {
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === " " || c === "\t") {
      if (cur.length > 0) { out.push(cur); cur = ""; }
      continue;
    }
    cur += c;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** Split on single `|` only; `||` stays inside the current stage. */
function splitPipeline(str) {
  const stages = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === "|") {
      if (str[i + 1] === "|") { cur += "||"; i += 1; continue; }
      stages.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  stages.push(cur.trim());
  return stages;
}

// ---- command interpreter ---------------------------------------------------

async function runStage(state, tokens, stdinText) {
  tokens = tokens.filter((t) => t !== "2>/dev/null" && t !== ">/dev/null" && t !== "2>&1");
  if (tokens.length === 0) return { code: 0, stdout: "", stderr: "" };
  // `a && b || c` chains with proper short-circuiting (left to right)
  const parts = [];
  const ops = [];
  let cur = [];
  for (const token of tokens) {
    if (token === "&&" || token === "||") {
      parts.push(cur);
      ops.push(token);
      cur = [];
    } else {
      cur.push(token);
    }
  }
  parts.push(cur);
  if (ops.length > 0) {
    let result = await runStage(state, parts[0], stdinText);
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const runs = (op === "&&" && result.code === 0) || (op === "||" && result.code !== 0);
      if (runs) result = await runStage(state, parts[i + 1], stdinText);
    }
    return result;
  }
  const [cmd, ...args] = tokens;
  const out = (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr });

  switch (cmd) {
    case "true": return out();
    case "echo": return out(args.join(" ") + "\n");
    case "printf": {
      if (args.some((a) => a.includes("$HOME"))) return out(`/home/${state.user}\n`);
      return out(args.join(" "));
    }
    case "id": return args[0] === "-un" ? out(state.user + "\n") : out(`uid=1000(${state.user})\n`);
    case "getent": {
      const user = args[1] ?? state.user;
      return out(`${user}:x:1000:1000::/home/${user}:/bin/bash\n`);
    }
    case "cut": {
      const text = stdinText ?? "";
      if ((args[0] === "-d:" || args[0] === "-d=") && args[1] !== undefined) {
        const sep = args[0] === "-d:" ? ":" : "=";
        const field = Number(args[1].replace("-f", ""));
        return out(text.split(/\r?\n/).map((l) => l.split(sep)[field - 1] ?? "").join("\n"));
      }
      return out(text);
    }
    case "command": {
      const v = args.indexOf("-v");
      const name = v === -1 ? undefined : args[v + 1];
      if (name === "node" && process.env.DSH_MOCK_NO_NODE === undefined) return out("/usr/bin/node\n");
      if (name === "dsh" && process.env.DSH_MOCK_NO_DSH === undefined) return out(`/home/${state.user}/.npm-global/bin/dsh\n`);
      if (name === "sudo") return out("/usr/bin/sudo\n");
      return out("", 1);
    }
    case "node": {
      if (args[0] === "--version") {
        if (process.env.DSH_MOCK_NO_NODE !== undefined) return out("", 127, "node: command not found");
        return out(`${process.env.DSH_MOCK_NODE_VERSION ?? "v22.23.2"}\n`);
      }
      if (args[0] === "-e") {
        const prog = args[1];
        const progArgs = args.slice(2);
        return new Promise((resolve) => {
          const child = spawn(process.execPath, ["-e", prog, ...progArgs], { windowsHide: true });
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (c) => { stdout += c; });
          child.stderr.on("data", (c) => { stderr += c; });
          child.on("close", (code) => resolve(out(stdout, code ?? 1, stderr)));
          child.on("error", (e) => resolve(out("", 1, e.message)));
        });
      }
      if (args[0] === "-") {
        // Program-on-stdin mode (the plugin's occupancy probe): forward our
        // stdin text to a real `node -` child.
        const rest = args.slice(1);
        return new Promise((resolve) => {
          const child = spawn(process.execPath, ["-", ...rest], { windowsHide: true });
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (c) => { stdout += c; });
          child.stderr.on("data", (c) => { stderr += c; });
          child.on("close", (code) => resolve(out(stdout, code ?? 1, stderr)));
          child.on("error", (e) => resolve(out("", 1, e.message)));
          child.stdin.write(stdinText ?? "");
          child.stdin.end();
        });
      }
      return out("", 1, `unsupported node invocation: ${args.join(" ")}`);
    }
    case "dsh":
      if (args[0] === "--version") {
        if (process.env.DSH_MOCK_NO_DSH !== undefined) return out("", 127, "dsh: command not found");
        return out("0.1.0-rc.6\n");
      }
      return out("", 1, "unsupported dsh invocation");
    case "sudo": {
      const rest = args.filter((a) => a !== "-n");
      if (rest.length === 0) return out("", 1, "sudo: missing command");
      if (rest[0] === "true") {
        return process.env.DSH_MOCK_NO_SUDO !== undefined
          ? out("", 1, "sudo: a password is required")
          : out();
      }
      return runStage(state, rest, stdinText);
    }
    case "env": {
      const rest = args.filter((a) => !a.includes("="));
      return runStage(state, rest, stdinText);
    }
    case "flock": {
      let i = 0;
      while (i < args.length && (args[i] === "-w" || args[i] === "-n")) i += 2;
      const lockPath = mockPath(args[i]);
      i += 1;
      const rest = args[i] === "-c" ? args.slice(i + 1) : args.slice(i);
      return withLock(lockPath, () => runStage(state, rest, stdinText));
    }
    case "sh": {
      if (args[0] === "-c") {
        const stages = splitPipeline(args[1]).filter((s) => s.length > 0);
        return runPipeline(state, stages.slice(0, 1), stdinText);
      }
      const sIndex = args.indexOf("-s");
      if (sIndex !== -1) {
        const params = args[sIndex + 1] === "--" ? args.slice(args.indexOf("--") + 1) : args.slice(sIndex + 1);
        const script = stdinText ?? "";
        if (script.includes("NODE_PROG=")) return runAllocate(state, params, script);
        if (script.includes("TMP=$(mktemp)")) return runUpdate(state, params, script);
        return out("", 1, "unrecognized remote script");
      }
      return out("", 1, "unsupported sh invocation");
    }
    case "cat": {
      const path = mockPath(args[0]);
      if (!existsSync(path)) return out("", 1, `cat: ${args[0]}: No such file or directory`);
      return out(readFileSync(path, "utf8"));
    }
    case "tee": {
      const path = mockPath(args[0]);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, stdinText ?? "", "utf8");
      return out(stdinText ?? "");
    }
    case "mkdir":
      if (args[0] === "-p") { mkdirSync(mockPath(args[1]), { recursive: true }); return out(); }
      return out("", 1, "unsupported mkdir");
    case "head": {
      const text = stdinText ?? "";
      const n = args.includes("-1") ? 1 : 10;
      return out(text.split(/\r?\n/).slice(0, n).join("\n") + "\n");
    }
    case "grep": {
      const text = stdinText ?? "";
      let pattern = args.includes("-E") ? args[args.indexOf("-E") + 1] : args[0];
      if (pattern === undefined) return out("", 2);
      const re = new RegExp(pattern.replace(/^\^|\$$/g, ""));
      let lines = text.split(/\r?\n/).filter((l) => re.test(l));
      if (args.includes("-m1")) lines = lines.slice(0, 1);
      if (args.includes("-o")) {
        return lines.length > 0 ? out(lines.map((l) => (l.match(re) ?? [""])[0] ?? "").join("\n") + "\n") : out("", 1);
      }
      return lines.length > 0 ? out(lines.join("\n") + "\n") : out("", 1);
    }
    case "awk": {
      const text = stdinText ?? "";
      const program = args.find((a) => a.startsWith("{"));
      const printMatch = program !== undefined ? /\$(\d+)/.exec(program) : null;
      if (program !== undefined && program.includes("print") && printMatch !== null) {
        const field = Number(printMatch[1]);
        const rawSep = args.includes("-F") ? args[args.indexOf("-F") + 1] : " ";
        const sep = rawSep === "\\t" ? "\t" : rawSep;
        return out(text.split(/\r?\n/).filter((l) => l.length > 0).map((l) => l.split(sep)[field - 1]).join("\n") + "\n");
      }
      return out(text);
    }
    case "systemctl": {
      if (process.env.DSH_MOCK_DEBUG !== undefined) process.stderr.write(`DEBUG systemctl args=${JSON.stringify(args)}\n`);
      const flags = args.filter((a) => a.startsWith("-"));
      const scope = flags.includes("--user") ? "user" : "system";
      const rest = args.filter((a) => !a.startsWith("-"));
      const verb = rest[0] ?? "";
      if (verb === "is-system-running") return out("running\n");
      if (verb === "daemon-reload") return out();
      if (verb.length === 0) return out("", 1, "systemctl: missing verb");
      const unit = rest[rest.length - 1];
      if (unit === undefined) return out("", 1, "systemctl: missing unit");
      const svc = services();
      const key = serviceKey(unit, state.user);
      const entry = svc[key] ?? { active: false, enabled: false, pid: null };
      if (verb === "is-active") return entry.active ? out("active\n") : out("inactive\n", 3);
      if (verb === "is-enabled") return entry.enabled ? out("enabled\n") : out("disabled\n", 1);
      if (verb === "enable") { svc[key] = { ...entry, enabled: true }; saveServices(svc); return out(); }
      if (verb === "restart") {
        if (!existsSync(unitFileFor(scope, unit, state.user))) return out("", 5, `Unit ${unit}.service not found.`);
        const parsed = parseUnit(readFileSync(unitFileFor(scope, unit, state.user), "utf8"));
        await killPid(entry.pid);
        return startMockWeb(unit, parsed.port ?? 3080, scope, parsed.user ?? state.user);
      }
      if (verb === "stop") {
        await killPid(entry.pid);
        svc[key] = { ...entry, active: false, pid: null };
        saveServices(svc);
        return out();
      }
      return out("", 1, `unsupported systemctl verb ${verb}`);
    }
    case "journalctl": {
      let unit = args[args.indexOf("-u") + 1] ?? args[args.indexOf("--user-unit") + 1];
      if (unit === undefined || unit.startsWith("-")) unit = "dsh-web";
      const n = args.includes("-n") ? Number(args[args.indexOf("-n") + 1]) : 10;
      if (!existsSync(journalPath(unit, state.user))) return out("-- No entries --\n");
      const lines = readFileSync(journalPath(unit, state.user), "utf8").split(/\r?\n/).filter((l) => l.length > 0);
      return out(lines.slice(-n).join("\n") + "\n");
    }
    case "loginctl": {
      if (args[0] === "show-user") {
        const user = args[1];
        if (args.includes("-p") && args[args.indexOf("-p") + 1] === "Linger") return out(`Linger=${linger(user)}\n`);
        return out("");
      }
      if (args[0] === "enable-linger") { setLinger(args[1], "yes"); return out(); }
      return out("", 1, "unsupported loginctl");
    }
    case "ss": {
      const lines = [];
      for (const [, entry] of Object.entries(services())) {
        if (entry.active && entry.pid !== null) {
          lines.push(`LISTEN 0 128 127.0.0.1:${entry.port} 0.0.0.0:* users:(("node",pid=${entry.pid},fd=19))`);
        }
      }
      return out(lines.length > 0 ? lines.join("\n") + "\n" : "");
    }
    case "netstat": return out("");
    case "ps": {
      const pIndex = args.indexOf("-p");
      const pids = pIndex === -1 ? [] : (args[pIndex + 1] ?? "").split(",").map(Number);
      const lines = [];
      for (const pid of pids) {
        const entry = Object.values(services()).find((e) => e.pid === pid);
        if (entry !== undefined) lines.push(`${entry.user ?? state.user} ${pid}`);
      }
      return out(lines.length > 0 ? lines.join("\n") + "\n" : "");
    }
    case "test": {
      const flag = args[0];
      const path = mockPath(args[1]);
      let ok = false;
      // Model the real permission story: /etc/... is root-owned and not
      // writable by a plain user unless the dshports-group setup is simulated.
      const underEtc = args[1] !== undefined && args[1].startsWith("/etc/");
      const etcWritable = underEtc && process.env.DSH_MOCK_SHARED_WRITABLE !== undefined;
      if (flag === "-f") ok = existsSync(path);
      else if (flag === "-r") ok = (() => { try { readFileSync(path); return true; } catch { return false; } })();
      else if (flag === "-w") ok = underEtc
        ? etcWritable
        : (() => {
            try {
              mkdirSync(dirname(path), { recursive: true });
              const fd = openSync(path, "a");
              closeSync(fd);
              return true;
            } catch { return false; }
          })();
      else if (flag === "-s") ok = existsSync(path) && readFileSync(path, "utf8").length > 0;
      else if (flag === "-d") ok = existsSync(path);
      return ok ? out() : out("", 1);
    }
    default:
      return out("", 127, `${cmd}: command not found`);
  }
}

async function withLock(lockPath, action) {
  const deadline = Date.now() + 30000;
  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        return await action();
      } finally {
        closeSync(fd);
        try { unlinkSync(lockPath); } catch { /* best effort */ }
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() > deadline) return { code: 1, stdout: "", stderr: "flock: timeout" };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

// ---- the plugin's remote protocol scripts ----------------------------------

async function runAllocate(state, params, script) {
  const [regRaw, lo, hi, user, ws, src, now, exc] = params;
  const reg = mockPath(regRaw);
  mkdirSync(dirname(reg), { recursive: true });
  if (!existsSync(reg) || readFileSync(reg, "utf8").trim().length === 0) {
    writeFileSync(reg, "port\tuser\tworkspace\tsource\tcreated_at\tlast_heartbeat\tstatus\n", "utf8");
  }
  const match = /NODE_PROG='([\s\S]*?)'\n/.exec(script);
  if (match === null) return { code: 1, stdout: "", stderr: "no node probe in allocate script" };
  const probe = match[1];
  const probeResult = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", probe, lo, hi, reg, exc === "-" ? "" : exc], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (e) => resolve({ code: 1, stdout: "", stderr: e.message }));
  });
  if (probeResult.code !== 0) {
    return { code: 3, stdout: "", stderr: `dsh-remote-tunnel: no free port in ${lo}-${hi}` };
  }
  const chosen = probeResult.stdout.trim();
  appendFileSync(reg, `${chosen}\t${user}\t${ws}\t${src}\t${now}\t${now}\tin-use\n`, "utf8");
  return { code: 0, stdout: chosen, stderr: "" };
}

function runUpdate(state, params, script) {
  const reg = mockPath(params[0]);
  // Single-row form: REG PORT USER COL VAL. Batch form: REG then repeated
  // (PORT USER COL VAL) groups. Both rewrite the file in ONE pass, mirroring
  // the real UPDATE_SHELL / UPDATE_BATCH_SHELL awk behavior.
  const rest = params.slice(1);
  if (rest.length === 0 || rest.length % 4 !== 0) {
    return { code: 1, stdout: "", stderr: `bad update args: ${params.join(" ")}` };
  }
  const wanted = new Map();
  for (let i = 0; i < rest.length; i += 4) {
    wanted.set(`${rest[i]}\t${rest[i + 1]}`, { col: rest[i + 2], val: rest[i + 3] });
  }
  const lines = readFileSync(reg, "utf8").split(/\r?\n/).filter((l) => l.length > 0);
  const updated = lines.map((line) => {
    if (line.startsWith("#")) return line;
    const fields = line.split("\t");
    const hit = fields.length >= 7 ? wanted.get(`${fields[0]}\t${fields[1]}`) : undefined;
    if (hit !== undefined) fields[hit.col === "7" ? 6 : 5] = hit.val;
    return fields.join("\t");
  });
  const tmp = `${reg}.tmp`;
  writeFileSync(tmp, updated.join("\n") + "\n", "utf8");
  // Mirror the real UPDATE_SHELL's inode semantics: `mv tmp reg` replaces the
  // inode (owner/group become the current user's primary group), while
  // `cat tmp > reg` rewrites in place and keeps the original owner/group. The
  // shared-direct registry (dshports group) depends on the latter surviving.
  const group = getFileGroup(reg);
  if (script.includes('mv "$TMP" "$REG"')) {
    setFileGroup(reg, state.user);
  } else if (group !== null) {
    setFileGroup(reg, group); // unchanged — explicit keep
  }
  writeFileSync(reg, readFileSync(tmp, "utf8"), "utf8");
  try { unlinkSync(tmp); } catch { /* best effort */ }
  return { code: 0, stdout: "", stderr: "" };
}

async function runPipeline(state, stages, stdinText) {
  let text = stdinText;
  let code = 0;
  let stderr = "";
  for (const stage of stages) {
    const result = await runStage(state, tokenize(stage), text);
    text = result.stdout;
    code = result.code;
    stderr = result.stderr;
    const benign = ["grep", "ss", "netstat"].some((name) => stage.trim().startsWith(name));
    if (code !== 0 && !benign) break;
  }
  return { code, stdout: text, stderr };
}

// ---- entry -----------------------------------------------------------------

function findTarget(args) {
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token.startsWith("-")) {
      if (["-p", "-o", "-w", "-n", "-L"].includes(token)) i += 1;
      continue;
    }
    if (token.includes("@")) return token;
  }
  fail("ssh: destination required");
}

const args = process.argv.slice(2);
const tunnelIndex = args.indexOf("-N");
const target = findTarget(args);
const user = (target.split("@")[0] ?? DEFAULT_USER) || DEFAULT_USER;
const state = { user, root: ROOT };

if (tunnelIndex !== -1) {
  const spec = args[args.indexOf("-L") + 1];
  const match = /^127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)$/.exec(spec);
  if (match === null) fail("shim: bad -L spec", 255);
  const localPort = Number(match[1]);
  const remotePort = Number(match[2]);
  const server = createServer((socket) => {
    const upstream = connect(remotePort, "127.0.0.1");
    upstream.on("connect", () => {
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  server.on("error", (error) => {
    process.stderr.write(`bind: ${error.code === "EADDRINUSE" ? "Address already in use" : error.message}\n`);
    process.exit(255);
  });
  server.listen(localPort, "127.0.0.1", () => {
    process.stdout.write(`forwarding 127.0.0.1:${localPort} -> 127.0.0.1:${remotePort}\n`);
  });
  const shutdown = () => process.exit(0);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  // exec mode: everything after the target is one command string (like real
  // ssh). Stdin is read synchronously: the plugin always ends stdin, and
  // event listeners could miss an end that arrives before they attach.
  const command = args.slice(args.indexOf(target) + 1).join(" ");
  const stdinText = readFileSync(0, "utf8");
  (async () => {
    try {
      const stages = splitPipeline(command).filter((s) => s.length > 0);
      const result = await runPipeline(state, stages, stdinText);
      if (result.stdout.length > 0) process.stdout.write(result.stdout);
      if (result.stderr.length > 0) process.stderr.write(result.stderr);
      process.exit(result.code);
    } catch (error) {
      process.stderr.write(`shim error: ${error.message}\n`);
      process.exit(1);
    }
  })();
}
