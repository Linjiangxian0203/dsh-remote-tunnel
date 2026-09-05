import { readFileSync } from "node:fs";
import { TunnelError } from "../errors.js";

// Remote account bootstrap: the plugin streams scripts/bootstrap-remote.sh
// (the single source of truth, also usable manually) to `sh -s` over ssh. It
// runs as whatever account the ssh alias logs in as, installing Node (when
// possible), dsh into that account's ~/.npm-global, ~/.dsh, linger and PATH
// entries — idempotently, so each labmate runs it once for their own account.

/** Marker the mock-remote ssh shim recognizes as the bootstrap script. */
export const BOOTSTRAP_MARKER = "dsh-remote-tunnel bootstrap";

/** The packaged bootstrap script, relative to this module (../../scripts/). */
const BOOTSTRAP_SCRIPT_URL = new URL("../../scripts/bootstrap-remote.sh", import.meta.url);

/** Read the packaged bootstrap script (throws E_BOOTSTRAP_SCRIPT when absent). */
export function readBootstrapScript() {
  try {
    return readFileSync(BOOTSTRAP_SCRIPT_URL, "utf8");
  } catch {
    throw new TunnelError("bootstrap script not found in this installation (scripts/bootstrap-remote.sh)", {
      code: "E_BOOTSTRAP_SCRIPT",
      hint: "reinstall dsh-remote-tunnel (the npm package ships scripts/)"
    });
  }
}
