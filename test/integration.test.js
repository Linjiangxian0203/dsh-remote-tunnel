import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { killProcessTree } from "../src/local/ports.js";
import { TunnelManager } from "../src/manager.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "mock-remote", "ssh-shim.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Plain HTTP GET (no deps). */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = globalThis.fetch(url);
    req.then((res) => res.text()).then((text) => resolve({ status: 200, text })).catch((error) => reject(error));
  });
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "dsh-remote-home-"));
  const mockRoot = mkdtempSync(join(tmpdir(), "dsh-remote-mock-"));
  process.env.DSH_MOCK_ROOT = mockRoot;
  process.env.DSH_REMOTE_TUNNEL_SSH = `${process.execPath} ${SHIM}`;
  delete process.env.DSH_MOCK_NO_SUDO;
  delete process.env.DSH_MOCK_EADDRINUSE_PORT;
  delete process.env.DSH_MOCK_NO_NODE;
  delete process.env.DSH_MOCK_NO_DSH;
  writeFileSync(join(home, "config.yaml"), `hosts:
  mock:
    host: mock-host
    port: 22
    user: mockuser
    workspace: /home/mockuser/exp
defaults:
  remotePortRange: [31080, 31099]
  localPortRange: [32080, 32099]
  heartbeatSeconds: 0
  localWaitSeconds: 15
  remoteWaitSeconds: 15
  ssh:
    connectTimeout: 5
`, "utf8");
  return { home, mockRoot };
}

async function teardown(managers, { home, mockRoot }) {
  for (const manager of managers) {
    try { await manager.dispose(); } catch { /* best effort */ }
  }
  // kill leftover detached mock web servers
  try {
    const services = JSON.parse(readFileSync(join(mockRoot, "services.json"), "utf8"));
    for (const [, entry] of Object.entries(services)) {
      if (entry.pid !== null && entry.pid !== undefined) {
        await killProcessTree(entry.pid);
      }
    }
  } catch { /* nothing to clean */ }
  rmSync(home, { recursive: true, force: true });
  rmSync(mockRoot, { recursive: true, force: true });
}

function mockPath(mockRoot, remotePath) {
  return remotePath.startsWith("/") ? join(mockRoot, ...remotePath.split("/").filter((s) => s.length > 0)) : remotePath;
}

// Fake group metadata mirror for the registry file (see ssh-shim.js).
function fileGroupFile(mockRoot) {
  return join(mockRoot, "filegroup.json");
}

function setFileGroup(mockRoot, remotePath, group) {
  const file = fileGroupFile(mockRoot);
  const map = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  map[remotePath] = group;
  writeFileSync(file, JSON.stringify(map, null, 2), "utf8");
}

function getFileGroup(mockRoot, remotePath) {
  const file = fileGroupFile(mockRoot);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"))[remotePath] ?? null;
}

function makeManager(home, events = []) {
  const manager = new TunnelManager({
    home,
    reporter: { out: () => {}, err: () => {}, event: (evt) => events.push(evt) }
  });
  return manager;
}

async function waitFor(check, { timeoutMs = 15000, stepMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(stepMs);
  }
}

test("up → real HTTP through the tunnel → status → down (happy path)", async () => {
  const env = setup();
  const manager = makeManager(env.home);
  try {
    const result = await manager.up("mock");
    assert.ok(result.url.startsWith("http://127.0.0.1:3208"), result.url);
    // dsh web (>= 0.1.2-rc) token URL: rewritten to the LOCAL tunnel port with
    // the token preserved; the plain URL must NOT carry it.
    assert.ok(result.authUrl !== undefined && result.authUrl !== null, "authUrl missing");
    assert.ok(result.authUrl.startsWith(`http://127.0.0.1:${result.localPort}/?token=mock-token-${result.remotePort}`), result.authUrl);
    assert.ok(!result.url.includes("token"), result.url);
    const { status, text } = await httpGet(result.url);
    assert.equal(status, 200);
    assert.ok(text.includes(`mock dsh web on ${result.remotePort}`));

    // registry row registered in-use (at the registry the plugin picked)
    const registry = readFileSync(mockPath(env.mockRoot, result.registryPath), "utf8");
    assert.ok(registry.includes(`${result.remotePort}\tmockuser\t/home/mockuser/exp\t`));
    assert.ok(registry.includes("\tin-use\n"));

    const statusInfo = await manager.status("mock");
    assert.equal(statusInfo.local.pidAlive, true);
    assert.equal(statusInfo.local.urlResponds, true);
    assert.equal(statusInfo.remote.unitActive, "active");
    assert.equal(statusInfo.remote.portListening, true);

    const down = await manager.down("mock");
    assert.equal(down.released, true);
    assert.equal(down.serviceStopped, true);
    assert.equal(down.portFree, true);
    assert.equal(existsSync(join(env.home, "state", "mock.json")), false);

    const registryAfter = readFileSync(mockPath(env.mockRoot, result.registryPath), "utf8");
    const releasedRow = registryAfter.split(/\r?\n/).find((l) => l.startsWith(`${result.remotePort}\t`) && l.includes("\treleased"));
    assert.ok(releasedRow !== undefined, "registry row must be released after down");
  } finally {
    await teardown([manager], env);
  }
});

test("concurrent allocations for two users get distinct ports", async () => {
  const env = setup();
  const managerA = makeManager(env.home);
  // second manager: same home, but its own host alias with a different user
  const homeB = mkdtempSync(join(tmpdir(), "dsh-remote-home-b-"));
  writeFileSync(join(homeB, "config.yaml"), `hosts:
  mock:
    host: mock-host
    port: 22
    user: bob
    workspace: /home/bob/exp
defaults:
  remotePortRange: [31080, 31099]
  localPortRange: [32080, 32099]
  heartbeatSeconds: 0
  localWaitSeconds: 15
  remoteWaitSeconds: 15
  ssh:
    connectTimeout: 5
`, "utf8");
  const managerB = makeManager(homeB);
  try {
    const [a, b] = await Promise.all([managerA.up("mock"), managerB.up("mock")]);
    assert.notEqual(a.remotePort, b.remotePort);
    assert.notEqual(a.localPort, b.localPort);
    const [ta, tb] = await Promise.all([httpGet(a.url), httpGet(b.url)]);
    assert.equal(ta.status, 200);
    assert.equal(tb.status, 200);
    const registry = readFileSync(mockPath(env.mockRoot, a.registryPath), "utf8");
    assert.ok(registry.includes(`${a.remotePort}\tmockuser`));
    const registryB = readFileSync(mockPath(env.mockRoot, b.registryPath), "utf8");
    assert.ok(registryB.includes(`${b.remotePort}\tbob`));
    if (a.registryPath === b.registryPath) {
      assert.ok(registry.includes(`${b.remotePort}\tbob`), "shared registry must hold both rows");
    }
    await managerA.down("mock");
    await managerB.down("mock");
  } finally {
    await teardown([managerA, managerB], env);
    rmSync(homeB, { recursive: true, force: true });
  }
});

test("TOCTOU: EADDRINUSE on the allocated port retries with the next port", async () => {
  const env = setup();
  process.env.DSH_MOCK_EADDRINUSE_PORT = "31080";
  const manager = makeManager(env.home);
  try {
    const result = await manager.up("mock");
    // first free port 31080 failed to bind remotely; allocator moved on
    assert.equal(result.remotePort, 31081);
    const { status } = await httpGet(result.url);
    assert.equal(status, 200);
    await manager.down("mock");
  } finally {
    delete process.env.DSH_MOCK_EADDRINUSE_PORT;
    await teardown([manager], env);
  }
});

test("local port conflict: the tunnel shifts to the next free local port", async () => {
  const env = setup();
  const manager = makeManager(env.home);
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(32080, "127.0.0.1", resolve));
  try {
    const result = await manager.up("mock");
    assert.notEqual(result.localPort, 32080);
    const { status } = await httpGet(result.url);
    assert.equal(status, 200);
    await manager.down("mock");
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await teardown([manager], env);
  }
});

test("auto-reconnect: killing the tunnel child brings it back", async () => {
  const env = setup();
  const events = [];
  const manager = makeManager(env.home, events);
  try {
    const result = await manager.up("mock");
    const first = manager.tunnels.get("mock").child;
    assert.ok(first !== undefined);
    // kill the ssh shim process
    await killProcessTree(first.pid);
    await waitFor(async () => {
      const child = manager.tunnels.get("mock")?.child;
      return child !== undefined && child.pid !== first.pid && await (async () => {
        try { const { status } = await httpGet(result.url); return status === 200; } catch { return false; }
      })();
    });
    assert.ok(events.some((evt) => evt.kind === "tunnel" && evt.state === "reconnecting"));
    await manager.down("mock");
  } finally {
    await teardown([manager], env);
  }
});

test("audit: stale detection, clean-stale, orphan after keep-service down", async () => {
  const env = setup();
  const manager = makeManager(env.home);
  try {
    const result = await manager.up("mock");
    // kill the remote mock web directly -> in-use row with no listener = stale
    const services = JSON.parse(readFileSync(join(env.mockRoot, "services.json"), "utf8"));
    const entry = Object.values(services).find((e) => e.active === true);
    await killProcessTree(entry.pid);
    const auditStale = await manager.audit("mock", {});
    const staleRow = auditStale.rows.find((r) => r.port === result.remotePort);
    assert.equal(staleRow.verdict, "stale");

    // plant a second stale row (same user — the fallback registry lists own
    // rows only) so clean-stale exercises the BATCH update path. Translate the
    // POSIX registry path into the mock root the same way the ssh shim does —
    // a raw appendFileSync("/etc/...") would hit the Windows drive root.
    const targets0 = await manager.resolveTargets("mock");
    const registryFile = join(env.mockRoot, ...targets0.registry.path.split("/").filter((s) => s.length > 0));
    appendFileSync(registryFile, `3999\t${staleRow.user}\t/home/${staleRow.user}\tghost\t2026-01-01T00:00:00Z\t2026-01-01T00:00:00Z\tin-use\n`);

    const cleaned = await manager.audit("mock", { cleanStale: true });
    assert.ok(cleaned.changes.some((c) => c.includes(`cleaned stale ${result.remotePort}`)));
    assert.ok(cleaned.changes.some((c) => c.includes("cleaned stale 3999 ")));
    // rows are the PRE-clean snapshot; both rows were judged stale in it
    assert.equal(cleaned.rows.find((r) => r.port === 3999).verdict, "stale");
    assert.equal(cleaned.rows.find((r) => r.port === result.remotePort).verdict, "stale");
    // and a fresh audit confirms the batch write actually landed
    const afterClean = await manager.audit("mock", {});
    assert.equal(afterClean.rows.find((r) => r.port === 3999).status, "released");
    assert.equal(afterClean.rows.find((r) => r.port === result.remotePort).status, "released");

    // tear the first tunnel down, then re-up and down --keep-service
    // -> released row + listening port = orphan
    await manager.down("mock");
    const result2 = await manager.up("mock");
    await manager.down("mock", { keepService: true });
    const auditOrphan = await manager.audit("mock", {});
    const orphanRow = auditOrphan.rows.find((r) => r.port === result2.remotePort);
    assert.equal(orphanRow.verdict, "orphan");
    // real cleanup
    const targets = await manager.resolveTargets("mock");
    await targets.scope.stop(targets.hostDef, manager.cfg, manager.ctxFor("mock"));
  } finally {
    await teardown([manager], env);
  }
});

test("check: all green on a healthy mock; no-sudo variant uses user unit + fallback", async () => {
  const env = setup();
  const manager = makeManager(env.home);
  try {
    const report = await manager.check("mock");
    assert.equal(report.allOk, true, JSON.stringify(report.steps));
    const scopeStep = report.steps.find((s) => s.name === "systemd unit scope");
    assert.ok(["system unit", "user unit"].some((kind) => scopeStep.detail.includes(kind)));
  } finally {
    await teardown([manager], env);
  }
});

test("check with no sudo resolves user unit + fallback registry", async () => {
  const env = setup();
  process.env.DSH_MOCK_NO_SUDO = "1";
  const manager = makeManager(env.home);
  try {
    const report = await manager.check("mock");
    assert.equal(report.allOk, true, JSON.stringify(report.steps));
    assert.ok(report.steps.find((s) => s.name === "systemd unit scope").detail.includes("user unit"));
    assert.ok(report.steps.find((s) => s.name === "registry").detail.includes("fallback"));
  } finally {
    delete process.env.DSH_MOCK_NO_SUDO;
    await teardown([manager], env);
  }
});

test("check reports missing node/dsh", async () => {
  const env = setup();
  process.env.DSH_MOCK_NO_NODE = "1";
  const manager = makeManager(env.home);
  try {
    const report = await manager.check("mock");
    assert.equal(report.allOk, false);
    assert.equal(report.steps.find((s) => s.name === "node >= 22.19").ok, false);
  } finally {
    delete process.env.DSH_MOCK_NO_NODE;
    await teardown([manager], env);
  }
});

test("down from another process cancels the up supervisor (no resurrection)", async () => {
  const env = setup();
  const managerUp = makeManager(env.home);
  const managerDown = makeManager(env.home); // a separate invocation's manager
  try {
    await managerUp.up("mock");
    const child = managerUp.tunnels.get("mock").child;
    await managerDown.down("mock");
    // the up supervisor must notice the removed state file and stop
    await sleep(2500);
    const tunnel = managerUp.tunnels.get("mock");
    assert.equal(tunnel.state, "stopped");
    assert.ok(tunnel.child === undefined || tunnel.child === child);
    assert.equal(pidAliveLocal(child.pid), false);
  } finally {
    await teardown([managerUp, managerDown], env);
  }
});

function pidAliveLocal(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("up twice rejects; down then up works again", async () => {
  const env = setup();
  const manager = makeManager(env.home);
  try {
    await manager.up("mock");
    await assert.rejects(() => manager.up("mock"), (error) => error.code === "E_ALREADY_UP");
    await manager.down("mock");
    const again = await manager.up("mock");
    const { status } = await httpGet(again.url);
    assert.equal(status, 200);
    await manager.down("mock");
  } finally {
    await teardown([manager], env);
  }
});

test("up after a hard kill cleans stale state and reuses the registered remote port", async () => {
  const env = setup();
  const manager = makeManager(env.home);
  try {
    const first = await manager.up("mock");
    // simulate a hard-closed terminal: the tunnel process dies, state file stays
    await killProcessTree(manager.tunnels.get("mock").child.pid);
    await sleep(500);
    const second = await manager.up("mock");
    assert.equal(second.remotePort, first.remotePort, "remote port must be reused (unit + registry row still healthy)");
    assert.equal(second.reused, true);
    const { status } = await httpGet(second.url);
    assert.equal(status, 200);
    await manager.down("mock");
  } finally {
    await teardown([manager], env);
  }
});

test("shared-direct: registry update keeps the shared group (no mv inode swap)", async () => {
  const env = setup();
  process.env.DSH_MOCK_NO_SUDO = "1";
  process.env.DSH_MOCK_SHARED_WRITABLE = "1";
  const manager = makeManager(env.home);
  try {
    // admin pre-created the shared registry owned by the dshports group
    const reg = mockPath(env.mockRoot, "/etc/dsh-ports.tsv");
    mkdirSync(dirname(reg), { recursive: true });
    writeFileSync(reg, "port\tuser\tworkspace\tsource\tcreated_at\tlast_heartbeat\tstatus\n", "utf8");
    setFileGroup(env.mockRoot, reg, "dshports");

    const result = await manager.up("mock");
    assert.equal(result.registryKind, "shared-direct");
    assert.equal(getFileGroup(env.mockRoot, reg), "dshports", "allocation must keep the shared group");

    // down updates the registry (status -> released) via remoteUpdateRegistry
    await manager.down("mock");
    assert.equal(getFileGroup(env.mockRoot, reg), "dshports", "update must keep the shared group (in-place rewrite, no mv)");
  } finally {
    delete process.env.DSH_MOCK_NO_SUDO;
    delete process.env.DSH_MOCK_SHARED_WRITABLE;
    await teardown([manager], env);
  }
});
