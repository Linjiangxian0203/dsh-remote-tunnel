import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSshConfig, findSshAlias, parseKnownHosts } from "../src/ssh-config.js";
import { parseTsv, sanitizeField, REGISTRY_COLUMNS } from "../src/remote/registry.js";
import { normalizeConfig, DEFAULT_CONFIG, validateHostInput, upsertHost, dropHost } from "../src/config.js";
import { parsePort, parseIntArg } from "../src/cli-args.js";
import { renderUnitBody } from "../src/remote/unit.js";
import { readBootstrapScript, BOOTSTRAP_MARKER } from "../src/remote/bootstrap.js";
import { parseNetstatListening, parseTasklistCsv, parseLsofListening } from "../src/local/ports.js";
import { resolveMode } from "../src/index.js";
import { authRejection } from "../src/web.js";

test("parsePort: passes through valid ports and absent options", () => {
  assert.equal(parsePort("22", "--port"), 22);
  assert.equal(parsePort("65535", "--port"), 65535);
  assert.equal(parsePort(undefined, "--port"), undefined);
});

test("parsePort: rejects non-integers and out-of-range values", () => {
  for (const bad of ["abc", "22.5", "0", "-1", "65536", ""]) {
    assert.throws(() => parsePort(bad, "--port"), (e) => e.code === "E_USAGE" && e.message.includes("--port"), bad);
  }
});

test("parseIntArg: range bounds and option absence", () => {
  assert.equal(parseIntArg(undefined, "--lines", { min: 1, max: 100 }), undefined);
  assert.equal(parseIntArg("0", "--heartbeat", { min: 0, max: 86400 }), 0);
  assert.throws(() => parseIntArg("0", "--lines", { min: 1, max: 100 }), (e) => e.code === "E_USAGE" && e.message.includes("expected 1-100"));
});

test("parseNetstatListening: IPv4/IPv6 listeners, range filter, ignores non-LISTENING", () => {
  const text = [
    "",
    "  TCP    127.0.0.1:3080     0.0.0.0:0      LISTENING     1234",
    "  TCP    [::]:3099          [::]:0         LISTENING     88",
    "  TCP    127.0.0.1:3500     1.2.3.4:55     ESTABLISHED   7",
    "  TCP    127.0.0.1:4000     0.0.0.0:0      LISTENING     99"
  ].join("\r\n");
  const map = parseNetstatListening(text, 3000, 3999);
  assert.deepEqual([...map.keys()].sort(), [3080, 3099]);
  assert.deepEqual([...map.get(3080)], ["1234"]);
  assert.deepEqual([...map.get(3099)], ["88"]);
});

test("parseTasklistCsv: pid -> image name", () => {
  const names = parseTasklistCsv('"node.exe","1234"\r\n"sshd","88"\r\n');
  assert.equal(names.get("1234"), "node.exe");
  assert.equal(names.get("88"), "sshd");
});

test("parseLsofListening: port + pid/command label, range filter", () => {
  const text = [
    "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
    "sshd     1234  user   3u  IPv6  0t0    TCP  *:3080 (LISTEN)",
    "node       88  user   4u  IPv4  0t0    TCP  127.0.0.1:3099 (LISTEN)",
    "node       77  user   5u  IPv4  0t0    TCP  127.0.0.1:4000 (LISTEN)"
  ].join("\n");
  assert.deepEqual(
    parseLsofListening(text, 3000, 3999),
    [[3080, "pid 1234 sshd"], [3099, "pid 88 node"]]
  );
});

test("renderUnitBody: quotes paths (spaces survive), rejects quotes/newlines", () => {
  const cfg = { defaults: { unit: { restartSec: 5 } } };
  const fields = { user: "alice", home: "/home/alice", workspace: "/home/alice/my project", dshPath: "/usr/local/bin/dsh", port: 3080, name: "dsh-web-alice" };
  const body = renderUnitBody(cfg, "system", fields);
  assert.ok(body.includes("WorkingDirectory=/home/alice/my project\n"), body); // raw value, no quotes
  assert.ok(body.includes('Environment="HOME=/home/alice"'), body);
  assert.ok(body.includes('ExecStart="/usr/local/bin/dsh" --profile web --port 3080'), body);
  assert.throws(
    () => renderUnitBody(cfg, "system", { ...fields, workspace: '/home/alice/we"ird' }),
    (e) => e.code === "E_UNIT_PATH" && e.message.includes("workspace")
  );
});

test("parseSshConfig: aliases, wildcard merge, port", () => {
  const text = [
    "Host *",
    "  User defaultuser",
    "  IdentityFile ~/.ssh/id_ed25519",
    "",
    "Host lab",
    "  HostName 192.0.2.10",
    "  Port 6104",
    "  User alice",
    "",
    "Host bare",
    "  HostName bare.example.com",
    "",
    "# comment line",
    "Host = equals",
    "  HostName eq.example.com"
  ].join("\n");
  const parsed = parseSshConfig(text);
  assert.equal(parsed.aliases.length, 3);
  assert.equal(parsed.aliases[0].alias, "lab");
  const lab = findSshAlias(parsed, "lab");
  assert.equal(lab.host, "192.0.2.10");
  assert.equal(lab.port, 6104);
  assert.equal(lab.user, "alice");
  assert.equal(lab.identityFile, "~/.ssh/id_ed25519");
  const bare = findSshAlias(parsed, "bare");
  assert.equal(bare.host, "bare.example.com");
  assert.equal(bare.port, 22);
  assert.equal(bare.user, "defaultuser");
  const eq = findSshAlias(parsed, "equals");
  assert.equal(eq.host, "eq.example.com");
});

test("parseTsv: skips header and comments, parses rows", () => {
  const text = [
    "# comment",
    "port\tuser\tworkspace\tsource\tcreated_at\tlast_heartbeat\tstatus",
    "3080\talice\t/home/alice/project\tpc1\t2026-01-10T09:30:00Z\t2026-01-10T10:15:00Z\tin-use",
    "3081\talice\t/home/alice\tpc2\t2026-01-10T10:05:00Z\t2026-01-10T10:05:00Z\treleased",
    "broken\trow"
  ].join("\n");
  const rows = parseTsv(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].port, 3080);
  assert.equal(rows[0].user, "alice");
  assert.equal(rows[0].status, "in-use");
  assert.equal(rows[1].status, "released");
});

test("parseTsv: empty/missing input yields no rows", () => {
  assert.deepEqual(parseTsv(""), []);
  assert.deepEqual(parseTsv("# only a comment\n"), []);
});

test("sanitizeField strips tabs/newlines", () => {
  assert.equal(sanitizeField("a\tb\nc"), "a b c");
  assert.equal(sanitizeField("  padded  "), "padded");
  assert.equal(sanitizeField(undefined), "");
});

test("normalizeConfig merges user values over defaults", () => {
  const merged = normalizeConfig({
    hosts: { lab: { host: "x" } },
    defaults: {
      remotePortRange: [4000, 4010],
      registry: { path: "/tmp/reg.tsv" },
      heartbeatSeconds: 0
    }
  });
  assert.deepEqual(merged.defaults.remotePortRange, [4000, 4010]);
  assert.equal(merged.defaults.registry.path, "/tmp/reg.tsv");
  assert.equal(merged.defaults.registry.lockPath, DEFAULT_CONFIG.defaults.registry.lockPath); // deep merge
  assert.equal(merged.defaults.heartbeatSeconds, 0);
  assert.equal(merged.hosts.lab.host, "x");
  assert.deepEqual(merged.defaults.localPortRange, DEFAULT_CONFIG.defaults.localPortRange);
});

test("REGISTRY_COLUMNS matches the documented order", () => {
  assert.deepEqual(REGISTRY_COLUMNS, ["port", "user", "workspace", "source", "created_at", "last_heartbeat", "status"]);
});

test("bootstrap script: shim marker, idempotent install, upgrade + PATH branches", () => {
  const script = readBootstrapScript();
  assert.ok(script.includes(BOOTSTRAP_MARKER), "shim marker must be present in the script");
  assert.ok(script.includes('export PATH="$NPM_PREFIX/bin:$PATH"'), "script must expose ~/.npm-global on PATH");
  assert.ok(script.includes("DSHRT_UPGRADE"), "upgrade branch must exist");
  assert.ok(script.includes(".npm-global/bin:$PATH"), "PATH rc persistence must be present");
  assert.ok(script.includes("loginctl enable-linger"), "linger must be enabled");
  assert.ok(!script.includes("it does NOT install"), "stale note removed");
});

// ---- mode detection (docs/desktop-web-refactor-route.md P0-1) ---------------
// A wrong guess here used to send the row down the CLI branch, where
// program.help() calls appExit(0) and kills the whole web/desktop host.

function fakeCtx({ profile, webStartup } = {}) {
  const services = new Map();
  if (profile !== undefined) services.set("profileContext", { name: profile });
  if (webStartup !== undefined) services.set("webStartup", webStartup);
  return { get: (name) => services.get(name) };
}

test("resolveMode: web and desktop hosts are service before webStartup mounts", () => {
  assert.equal(resolveMode(fakeCtx({ profile: "web" })), "service");
  assert.equal(resolveMode(fakeCtx({ profile: "desktop" })), "service");
});

test("resolveMode: dedicated launcher profiles stay CLI", () => {
  assert.equal(resolveMode(fakeCtx({ profile: "remote" })), "cli");
  assert.equal(resolveMode(fakeCtx({ profile: "headless" })), "cli");
});

test("resolveMode: webStartup only ever promotes to service", () => {
  assert.equal(resolveMode(fakeCtx({ webStartup: {} })), "service");
  assert.equal(resolveMode(fakeCtx({ profile: "remote", webStartup: {} })), "service");
  assert.equal(resolveMode(fakeCtx({})), "cli");
  assert.equal(resolveMode(fakeCtx({ profile: "web", webStartup: undefined })), "service");
});

test("parseKnownHosts: plain, bracketed port, comma lists, hashed/revoked/patterns", () => {
  const text = [
    "# a comment",
    "",
    "192.0.2.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKz",
    "[lab.example.com]:6104 ssh-rsa AAAAB3NzaC1yc2E",
    "a.example.com,b.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAa",
    "192.0.2.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKz",
    "|1|Yc5D5b2v3nWq0k9mZg==|Q2m4Z9x0p1rS2tU3vW4xY5z6aB8=",
    "@revoked 198.51.100.7 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBb",
    "@cert-authority *.example.com ssh-rsa AAAAB3NzaC1yc2E",
    "wild*.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICc",
    "[2001:db8::1]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDd"
  ].join("\r\n");
  const parsed = parseKnownHosts(text);
  assert.deepEqual(parsed.hosts.map((h) => [h.alias, h.suggestedAlias, h.host, h.port]), [
    ["192.0.2.10", "192.0.2.10", "192.0.2.10", 22],
    ["lab.example.com:6104", "lab.example.com-6104", "lab.example.com", 6104],
    ["a.example.com", "a.example.com", "a.example.com", 22],
    ["b.example.com", "b.example.com", "b.example.com", 22],
    ["[2001:db8::1]:2222", "2001-db8--1-2222", "2001:db8::1", 2222]
  ]);
  // The suggested alias is what the panel will submit, so it must already be a
  // legal alias: a colon (host:port, and illegal in a Windows file name) would
  // otherwise come back as a 400 "invalid alias".
  for (const host of parsed.hosts) {
    const entry = validateHostInput({ alias: host.suggestedAlias, host: host.host, port: host.port });
    assert.equal(entry.alias, host.suggestedAlias);
  }
  // Hashed entries cannot be reversed; revoked ones are not offered; wildcards name no single host.
  assert.equal(parsed.hashed, 1);
  assert.equal(parsed.revoked, 1);
  assert.equal(parseKnownHosts("").hosts.length, 0);
});

test("validateHostInput: normalizes a good definition and refuses the dangerous ones", () => {
  assert.deepEqual(
    validateHostInput({ alias: "lab", host: "192.0.2.10", port: "6104", user: "alice", workspace: "/srv/app" }),
    { alias: "lab", host: "192.0.2.10", port: 6104, user: "alice", workspace: "/srv/app" }
  );
  assert.deepEqual(validateHostInput({ alias: "lab", host: "lab.example.com" }), { alias: "lab", host: "lab.example.com", port: 22 });
  assert.deepEqual(validateHostInput({ alias: "v6", host: "2001:db8::1" }), { alias: "v6", host: "2001:db8::1", port: 22 });
  const bad = [
    { alias: "-x", host: "192.0.2.10" },
    { alias: "a b", host: "192.0.2.10" },
    { alias: "", host: "192.0.2.10" },
    { alias: "lab", host: "" },
    { alias: "lab", host: "host with space" },
    { alias: "lab", host: "192.0.2.10", port: "0" },
    { alias: "lab", host: "192.0.2.10", port: "70000" },
    { alias: "lab", host: "192.0.2.10", user: "bad user" },
    { alias: "lab", host: "192.0.2.10", workspace: "/tmp/x\ny" },
    { alias: "lab", host: "192.0.2.10", workspace: "/tmp/\"x\"" }
  ];
  for (const input of bad) {
    assert.throws(() => validateHostInput(input), (error) => error.code === "E_USAGE", JSON.stringify(input));
  }
});

test("upsertHost/dropHost: replacement needs overwrite, unknown aliases are refused", () => {
  const config = { hosts: {} };
  upsertHost(config, { alias: "lab", host: "192.0.2.10", port: 22, user: "alice" });
  assert.deepEqual(config.hosts.lab, { host: "192.0.2.10", port: 22, user: "alice" });
  assert.throws(() => upsertHost(config, { alias: "lab", host: "192.0.2.11", port: 22 }), (error) => error.code === "E_HOST_EXISTS");
  upsertHost(config, { alias: "lab", host: "192.0.2.11", port: 2200 }, { overwrite: true });
  assert.deepEqual(config.hosts.lab, { host: "192.0.2.11", port: 2200 });
  dropHost(config, "lab");
  assert.deepEqual(config.hosts, {});
  assert.throws(() => dropHost(config, "lab"), (error) => error.code === "E_UNKNOWN_HOST");
});

// ---- browser half (src/client.js) ------------------------------------------
// The bundle only ever runs inside the web renderer, so this loads it with a
// captured module loader, a stubbed React and a fake host, then renders the
// /remote card, the composer strip and the right sidebar's pane. It is the only
// automated check that the two open modes, the disconnect step, the dock and the
// remote-hosts tab type survive a change without restarting the desktop app.

function loadClientBundle() {
  const source = readFileSync(new URL("../src/client.js", import.meta.url), "utf8");
  const state = {
    dock: true,
    tunnels: [{ alias: "lab", host: "10.0.0.1", remotePort: 3080, url: "http://127.0.0.1:3081", workspace: "/home/lab" }],
    hosts: [{ alias: "lab", host: "10.0.0.1", port: 22, origin: "plugin-config" }],
    discovered: [
      { alias: "192.0.2.55", suggestedAlias: "192.0.2.55", host: "192.0.2.55", port: 22, origin: "known-hosts", managed: false },
      { alias: "101.43.145.128:6104", suggestedAlias: "101.43.145.128-6104", host: "101.43.145.128", port: 6104, origin: "known-hosts", managed: false }
    ],
    hashed: 2,
    requests: []
  };
  let captured;
  const window = { __ModuleLoader__: { load: (definition) => { captured = definition; } } };
  const fetchStub = async (url) => {
    state.requests.push(String(url));
    // `legacy` reproduces a 0.2.0 host half: no discovered/discovery fields.
    const body = String(url).includes("/status")
      ? {
        ok: true,
        version: "0.2.1",
        config: { openIn: "ask", autoOpen: false, dock: state.dock },
        hosts: state.hosts,
        ...(state.legacy === true
          ? {}
          : {
            discovered: state.discovered,
            discovery: { path: "C:\\Users\\me\\.ssh\\known_hosts", exists: true, hashed: state.hashed, revoked: 0 }
          }),
        tunnels: state.tunnels
      }
      : { ok: true, alias: "lab", authUrl: "http://127.0.0.1:3081/?token=t" };
    return { ok: true, status: 200, json: async () => body };
  };
  const Image = class { set src(_value) { /* the beacon is fire and forget */ } };
  new Function("window", "globalThis", "fetch", "Image", source)(window, {}, fetchStub, Image);
  return { captured, state };
}

function fakeReact() {
  let cells = [];
  let cursor = 0;
  let effects = [];
  let cleanups = [];
  return {
    api: {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
      useState: (initial) => {
        const index = cursor++;
        if (!(index in cells)) cells[index] = typeof initial === "function" ? initial() : initial;
        return [cells[index], (value) => { cells[index] = typeof value === "function" ? value(cells[index]) : value; }];
      },
      useCallback: (fn) => fn,
      useEffect: (fn) => { effects.push(fn); }
    },
    // Cleanups matter: the dock arms a refresh interval, and a stub that drops
    // the teardown keeps the whole test process alive forever.
    reset() {
      cleanups.forEach((fn) => fn());
      cleanups = [];
      cells = [];
      cursor = 0;
      effects = [];
    },
    begin() { cursor = 0; effects = []; },
    drain() {
      const pending = effects;
      effects = [];
      pending.forEach((fn) => {
        const cleanup = fn();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      });
    }
  };
}

function collectStrings(value, out = []) {
  if (value === null || value === undefined) return out;
  if (typeof value === "string") { out.push(value); return out; }
  if (Array.isArray(value)) { value.forEach((item) => collectStrings(item, out)); return out; }
  if (typeof value === "object") collectStrings(value.children, out);
  return out;
}

/** The raw element tree of a settled render, for asserting on buttons. */
async function renderTree(react, Component, props) {
  react.begin();
  Component(props);
  react.drain();
  await new Promise((resolve) => setTimeout(resolve, 20));
  react.begin();
  const tree = Component(props);
  react.drain();
  return tree;
}

/** Depth-first search collecting every element a predicate accepts. */
function findAll(value, predicate, out = []) {
  if (value === null || value === undefined || typeof value !== "object") return out;
  const children = Array.isArray(value) ? value : (value.children ?? []);
  if (!Array.isArray(value) && predicate(value)) out.push(value);
  for (const child of children) findAll(child, predicate, out);
  return out;
}

/** Depth-first search for the first element a predicate accepts. */
function findElement(value, predicate) {
  if (value === null || value === undefined || typeof value !== "object") return undefined;
  const children = Array.isArray(value) ? value : (value.children ?? []);
  if (!Array.isArray(value) && predicate(value)) return value;
  for (const child of children) {
    const found = findElement(child, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Render twice with the same state cells: once cold, once after the fetch settles. */
async function renderTwice(react, Component, props) {
  react.begin();
  const first = Component(props);
  react.drain();
  await new Promise((resolve) => setTimeout(resolve, 20));
  react.begin();
  const second = Component(props);
  react.drain();
  return { first: collectStrings(first).join(" | "), second: collectStrings(second).join(" | ") };
}

async function mountClient(load) {
  const react = fakeReact();
  const plugin = load.captured.factory((name) => {
    if (name === "react") return react.api;
    throw new Error("unexpected require: " + name);
  });
  assert.equal(plugin.name, "remote-tunnel");
  assert.equal(typeof plugin.apply, "function");
  const opened = [];
  const registered = [];
  const tabTypes = [];
  const disposers = [];
  const ctx = {
    sidebarRight: { openTab: (...args) => { opened.push(args); } },
    sidebarRightTabs: { register: (definition) => { tabTypes.push(definition); return () => {}; } },
    // cordis' ctx.effect runs the callback now and owns the disposer it returns.
    effect: (fn) => { disposers.push(fn()); },
    inject: (deps, callback) => { callback(ctx); },
    slots: {
      inject: (name, callback) => callback(),
      register: (definition, Component) => { registered.push({ definition, Component }); return () => {}; }
    }
  };
  plugin.apply(ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { react, registered, opened, tabTypes, disposers };
}

const CARD = "conversation.chat.commandview";
const DOCK = "conversation.composer.dock";
const TAB_PANE = "sidebar.right.pane.tab";

test("client bundle: the /remote card offers both open modes and the disconnect step", async () => {
  const load = loadClientBundle();
  assert.equal(load.captured.id, "dsh-remote-tunnel");
  const { react, registered } = await mountClient(load);
  const card = registered.find((item) => item.definition.name === CARD);
  assert.ok(card, "the command card must be registered");
  assert.equal(card.definition.key, "remote");
  react.reset();
  const node = { name: "remote", args: " hosts", outcome: { kind: "success", text: "lab  10.0.0.1:22  [ssh-config]" } };
  const { second } = await renderTwice(react, card.Component, { node });
  assert.ok(second.includes("在浏览器打开"), second);
  assert.ok(second.includes("在侧栏打开"), second);
  assert.ok(second.includes("完成 / done"), second);
  assert.ok(second.includes("隧道:lab"), second);
  assert.ok(second.includes("断开连接 / down"), second);
  assert.ok(!second.includes("启动隧道 / up"), "a live tunnel must not offer up");
  react.reset();
});

test("client bundle: a stopped tunnel offers up instead of down", async () => {
  const load = loadClientBundle();
  load.state.tunnels = [];
  const { react, registered } = await mountClient(load);
  const card = registered.find((item) => item.definition.name === CARD);
  react.reset();
  const node = { name: "remote", args: " hosts", outcome: { kind: "success", text: "no tunnel" } };
  const { second } = await renderTwice(react, card.Component, { node });
  assert.ok(second.includes("启动隧道 / up"), second);
  assert.ok(!second.includes("断开连接 / down"), second);
  react.reset();
});

test("client bundle: the composer strip carries the actions and honours dock:false", async () => {
  const load = loadClientBundle();
  const { react, registered } = await mountClient(load);
  const dock = registered.find((item) => item.definition.name === DOCK);
  assert.ok(dock, "the composer dock must be registered");
  assert.equal(dock.definition.id, "remote-tunnel");
  react.reset();
  const live = await renderTwice(react, dock.Component, {});
  assert.ok(live.second.includes("远程隧道 / remote tunnel"), live.second);
  assert.ok(live.second.includes("在侧栏打开"), live.second);
  assert.ok(live.second.includes("断开"), live.second);
  // dock:false removes the whole strip, even with a live tunnel.
  load.state.dock = false;
  react.reset();
  const hidden = await renderTwice(react, dock.Component, {});
  assert.equal(hidden.second, "", "dock:false must render nothing");
  react.reset();
});
test("client bundle: registers the remote-hosts tab type with a guide entry", async () => {
  const load = loadClientBundle();
  const { tabTypes, disposers } = await mountClient(load);
  assert.equal(tabTypes.length, 1, "exactly one tab type");
  const definition = tabTypes[0];
  assert.equal(definition.id, "dsh-remote-tunnel/hosts");
  assert.equal(definition.kind, "remote-hosts");
  assert.ok(!("patterns" in definition), "a page type must not claim resource patterns");
  assert.equal(typeof definition.title, "function");
  assert.equal(definition.title(), "远程连接");
  assert.equal(definition.guide.length, 1);
  assert.equal(definition.guide[0].id, "hosts");
  assert.equal(typeof definition.guide[0].order, "number");
  assert.equal(definition.guide[0].title(), "远程连接");
  // The guide draws entry.icon({ size, className }); without it the capsule
  // falls back to the guide's own cube.
  assert.equal(typeof definition.guide[0].icon, "function", "the capsule must carry its own glyph");
  const glyph = definition.guide[0].icon({ size: 26 });
  assert.equal(glyph.type, "svg");
  assert.equal(glyph.props.width, 26);
  assert.equal(glyph.children.length, 3, "a screen, a neck and a base");
  assert.ok(definition.guide[0].description().length > 0, "the guide capsule needs a description");
  assert.equal(disposers.length, 1, "the registration must be owned by ctx.effect");
  assert.equal(typeof disposers[0], "function", "and must hand back its disposer");
});

test("client bundle: the sidebar pane shows the tunnel, both open modes and the disconnect step", async () => {
  const load = loadClientBundle();
  const { react, registered } = await mountClient(load);
  const pane = registered.find((item) => item.definition.name === TAB_PANE);
  assert.ok(pane, "the sidebar.right.pane.tab body must be registered");
  assert.equal(pane.definition.key, "dsh-remote-tunnel/hosts");
  react.reset();
  const props = { useTabInfo: () => ({ sidebar: {}, panel: { id: "pane-1" }, tab: { navigation: { params: {} } } }) };
  const live = await renderTwice(react, pane.Component, props);
  assert.ok(live.second.includes("远程连接"), live.second);
  assert.ok(live.second.includes("v0.2.1"), "the pane must show which build is live");
  assert.ok(live.second.includes("已连接 / connected"), live.second);
  assert.ok(live.second.includes("隧道:lab"), live.second);
  assert.ok(live.second.includes("在侧栏打开"), live.second);
  assert.ok(live.second.includes("在浏览器打开"), live.second);
  assert.ok(live.second.includes("断开连接 / down"), live.second);
  assert.ok(!live.second.includes("启动隧道 / up"), "a live tunnel must not offer up");
  react.reset();
});

test("client bundle: the pane offers up when nothing is connected, and honours params.host", async () => {
  const load = loadClientBundle();
  load.state.tunnels = [];
  const { react, registered } = await mountClient(load);
  const pane = registered.find((item) => item.definition.name === TAB_PANE);
  react.reset();
  // An opener may name the host it was acting on; the pane must honour it.
  const props = { useTabInfo: () => ({ tab: { navigation: { params: { host: "lab" } } } }) };
  const stopped = await renderTwice(react, pane.Component, props);
  assert.ok(stopped.second.includes("未连接 / not connected"), stopped.second);
  assert.ok(stopped.second.includes("启动隧道 / up"), stopped.second);
  assert.ok(!stopped.second.includes("断开连接 / down"), stopped.second);
  react.reset();
});

test("client bundle: the pane lists hosts, offers discovered candidates and spells out both writes", async () => {
  const load = loadClientBundle();
  const { react, registered } = await mountClient(load);
  const pane = registered.find((item) => item.definition.name === TAB_PANE);
  react.reset();
  const props = { useTabInfo: () => ({ tab: { navigation: { params: {} } } }) };
  const tree = await renderTree(react, pane.Component, props);
  const text = collectStrings(tree).join(" | ");
  assert.ok(text.includes("已配置主机 / managed hosts"), text);
  assert.ok(text.includes("lab · 10.0.0.1:22"), text);
  assert.ok(text.includes("发现的主机 / discovered in ~/.ssh"), text);
  assert.ok(text.includes("192.0.2.55 · 192.0.2.55:22"), text);
  assert.ok(text.includes("2 条 known_hosts 记录已哈希"), text);

  // Adding a candidate writes through the confirmed route, with its own values.
  load.state.requests.length = 0;
  const addButton = findElement(tree, (element) => element.type === "button" && collectStrings(element).includes("添加"));
  assert.ok(addButton, "a discovered candidate must offer an add button");
  addButton.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    load.state.requests.filter((url) => url.includes("hosts/add")),
    ["/remote-tunnel/hosts/add?confirm=1&alias=192.0.2.55&host=192.0.2.55&port=22"]
  );

  // A known_hosts entry on a non-default port is spelled `host:port`, which is
  // display text, not an alias: the write must carry the suggested alias.
  const portRow = findAll(tree, (element) => element.type === "div"
    && element.children.some((child) => child && child.type === "span"
      && Array.isArray(child.children) && child.children[0] === "101.43.145.128:6104 · 101.43.145.128:6104"))[0];
  assert.ok(portRow, "the non-default-port candidate must be listed");
  const portAdd = findElement(portRow, (element) => element.type === "button");
  portAdd.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    load.state.requests.filter((url) => url.includes("hosts/add")).slice(1),
    ["/remote-tunnel/hosts/add?confirm=1&alias=101.43.145.128-6104&host=101.43.145.128&port=6104"]
  );

  // Removing a managed host is a two-step action: the first click only arms it.
  const removeButton = findElement(tree, (element) => element.type === "button" && collectStrings(element).includes("删除"));
  assert.ok(removeButton, "a plugin-config host must offer a delete button");
  removeButton.props.onClick();
  react.begin();
  const armed = pane.Component(props);
  react.drain();
  const armedText = collectStrings(armed).join(" | ");
  assert.ok(armedText.includes("确认删除?"), armedText);
  assert.equal(load.state.requests.filter((url) => url.includes("hosts/remove")).length, 0, "the first click must not delete");
  const confirmButton = findElement(armed, (element) => element.type === "button" && collectStrings(element).includes("确认删除?"));
  confirmButton.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    load.state.requests.filter((url) => url.includes("hosts/remove")),
    ["/remote-tunnel/hosts/remove?confirm=1&alias=lab"]
  );
  // An ssh-config host is not ours to delete.
  load.state.hosts = [{ alias: "from-ssh-config", host: "10.0.0.9", port: 22, origin: "ssh-config" }];
  react.reset();
  const sshTree = await renderTree(react, pane.Component, props);
  assert.equal(findElement(sshTree, (element) => element.type === "button" && collectStrings(element).includes("删除")), undefined);
  react.reset();
});

test("client bundle: the pane follows the selected host, not the first tunnel", async () => {
  const load = loadClientBundle();
  load.state.hosts = [
    { alias: "lab", host: "10.0.0.1", port: 22, origin: "plugin-config" },
    { alias: "prod", host: "10.0.0.2", port: 2200, origin: "ssh-config" }
  ];
  load.state.tunnels = [{ alias: "prod", host: "10.0.0.2", remotePort: 3090, url: "http://127.0.0.1:3091", workspace: null }];
  load.state.discovered = [];
  const { react, registered } = await mountClient(load);
  const pane = registered.find((item) => item.definition.name === TAB_PANE);
  react.reset();
  const props = { useTabInfo: () => ({ tab: { navigation: { params: {} } } }) };
  const tree = await renderTree(react, pane.Component, props);
  const text = collectStrings(tree).join(" | ");
  // The live tunnel belongs to `prod`, which is the active selection.
  assert.ok(text.includes("隧道:prod"), text);
  assert.ok(text.includes("已连接 / connected"), text);
  // Switching to the host without a tunnel must offer up and withdraw down.
  const select = findElement(tree, (element) => element.type === "select");
  assert.ok(select, "two hosts must offer a picker");
  select.props.onChange({ target: { value: "lab" } });
  react.begin();
  const switched = pane.Component(props);
  react.drain();
  const switchedText = collectStrings(switched).join(" | ");
  assert.ok(switchedText.includes("未连接 / not connected"), switchedText);
  assert.ok(switchedText.includes("启动隧道 / up"), switchedText);
  assert.ok(!switchedText.includes("断开连接 / down"), switchedText);
  react.reset();
});

test("client bundle: the pane survives a cold status and a 0.2.0 host half", async () => {
  const load = loadClientBundle();
  const { react, registered } = await mountClient(load);
  const pane = registered.find((item) => item.definition.name === TAB_PANE);
  react.reset();
  // Cold render, and no useTabInfo prop at all: the pane must say so, not throw.
  const cold = pane.Component({});
  react.drain();
  assert.ok(collectStrings(cold).join(" | ").includes("读取状态中…"), "a cold pane must report that it is reading");
  // A 0.2.0 host half answers without discovered/discovery; the pane must not care.
  load.state.legacy = true;
  react.reset();
  const legacy = await renderTree(react, pane.Component, { useTabInfo: () => ({ tab: { navigation: { params: {} } } }) });
  const text = collectStrings(legacy).join(" | ");
  assert.ok(text.includes("已配置主机 / managed hosts"), text);
  assert.ok(!text.includes("发现的主机"), "no discovery section without a discovered list");
  assert.ok(!text.includes("known_hosts 记录已哈希"), text);
  react.reset();
});

// ---- route admission (src/web.js) -------------------------------------------
// /remote-tunnel/* hands out a URL carrying a one-time launch token, so it must
// go through the platform's own fence + browser-session check.

test("authRejection: mirrors connection.admit() and honours auth:false", () => {
  const unauthenticated = { admit: () => ({ rejection: 401 }) };
  const untrusted = { admit: () => ({ rejection: 403 }) };
  const admitted = { admit: () => ({ peer: { id: "operator" } }) };
  assert.equal(authRejection(unauthenticated, { auth: true }, {}), 401);
  assert.equal(authRejection(untrusted, { auth: true }, {}), 403);
  assert.equal(authRejection(admitted, { auth: true }, {}), undefined);
  assert.equal(authRejection(unauthenticated, { auth: false }, {}), undefined, "the escape hatch must bypass the check");
  assert.equal(authRejection(undefined, { auth: true }, {}), undefined, "no connection service = no check available");
});
