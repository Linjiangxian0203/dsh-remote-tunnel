// dsh-remote-tunnel — shared diagnostics black box.
//
// Both halves run where a debugger cannot follow: the host process sits behind
// the desktop app, the browser half behind the shell's module carrier. The
// /remote-tunnel/report route and the events recorded here are how they tell
// the outside world what they did. Bounded ring, so a long-lived host cannot
// grow forever.
const MAX_EVENTS = 40;

const status = { loadedAt: null, openedAt: null, lastError: null, events: [] };

export function record(event, detail) {
  const at = new Date().toISOString();
  if (event === "loaded") status.loadedAt = at;
  if (event === "opened") status.openedAt = at;
  if (event === "error") status.lastError = detail ?? "unknown";
  status.events.push({ at, event, detail: detail ?? null });
  if (status.events.length > MAX_EVENTS) status.events.shift();
}

export function snapshot() {
  return status;
}
