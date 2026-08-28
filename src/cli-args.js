import { TunnelError } from "./errors.js";

// CLI numeric-argument validation. Every numeric option goes through these
// instead of `Number.parseInt(x) || fallback`, which silently turned "--port
// abc" into the default and hid typos from the user.

function toInt(value, name) {
  // parseInt alone would truncate "22.5" to 22 — reject anything that is not
  // a plain (optionally signed) integer literal before parsing.
  if (!/^-?\d+$/.test(String(value).trim())) {
    throw new TunnelError(`invalid ${name}: "${value}" is not an integer`, { code: "E_USAGE" });
  }
  return Number.parseInt(value, 10);
}

/** Parse a required-range integer option; undefined (option absent) passes through. */
export function parseIntArg(value, name, { min, max } = {}) {
  if (value === undefined) return undefined;
  const n = toInt(value, name);
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
    const range = min !== undefined && max !== undefined ? `${min}-${max}` : min !== undefined ? `>= ${min}` : `<= ${max}`;
    throw new TunnelError(`invalid ${name}: ${n} (expected ${range})`, { code: "E_USAGE" });
  }
  return n;
}

/** Parse a TCP port option (1-65535). */
export function parsePort(value, name) {
  return parseIntArg(value, name, { min: 1, max: 65535 });
}
