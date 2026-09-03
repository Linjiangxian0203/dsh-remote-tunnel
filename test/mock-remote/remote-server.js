#!/usr/bin/env node
// Fake remote dsh web for the mock host: binds 127.0.0.1:<port>, serves a
// tiny page, appends lifecycle lines to the fake journal. Detached child of
// ssh-shim.js's `systemctl restart`.

import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [portArg, journalArg] = process.argv.slice(2);
const port = Number(portArg);

function journal(line) {
  try {
    mkdirSync(dirname(journalArg), { recursive: true });
    appendFileSync(journalArg, `${line}\n`, "utf8");
  } catch {
    // journal failures never crash the fake service
  }
}

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`mock dsh web on ${port}\n`);
});

server.on("error", (error) => {
  journal(`Error: listen EADDRINUSE: address already in use 127.0.0.1:${port}`);
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  // Mimic dsh web >= 0.1.2-rc: the launch URL carries a one-time token and is
  // printed to stdout (the unit journal) with an optional LAN variant. The
  // plain line first simulates a stale pre-token journal entry, so the plugin
  // must pick the LAST token-carrying URL logged after the unit start.
  journal(`dsh web: http://127.0.0.1:${port}`);
  journal(`dsh web: http://127.0.0.1:${port}/?token=mock-token-${port} (LAN: http://192.168.1.5:${port}/?token=mock-token-${port})`);
});
