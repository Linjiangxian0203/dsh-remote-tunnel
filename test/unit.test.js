import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSshConfig, findSshAlias } from "../src/ssh-config.js";
import { parseTsv, sanitizeField, REGISTRY_COLUMNS } from "../src/remote/registry.js";
import { normalizeConfig, DEFAULT_CONFIG } from "../src/config.js";

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
