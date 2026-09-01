import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSshConfig, findSshAlias } from "../src/ssh-config.js";
import { parseTsv, sanitizeField, REGISTRY_COLUMNS } from "../src/remote/registry.js";
import { normalizeConfig, DEFAULT_CONFIG } from "../src/config.js";
import { parsePort, parseIntArg } from "../src/cli-args.js";
import { renderUnitBody } from "../src/remote/unit.js";
import { parseNetstatListening, parseTasklistCsv, parseLsofListening } from "../src/local/ports.js";

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
