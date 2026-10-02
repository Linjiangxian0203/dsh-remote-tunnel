import { TunnelError } from "./errors.js";

// dsh-remote-tunnel host half for the browser UI: the HTTP surface the client
// bundle calls. Routes live under /remote-tunnel/ and ride the same carrier as
// the rest of the GUI — the browser half reaches them through the shell origin.
//
// The desktop renderer talks to us without a cookie observable from outside, so
// `report` doubles as a black box: the client half records its lifecycle here
// and `state` exposes it, together with which host services ever mounted.

// NB: the webserver matches a prefix P as `path === P || path.startsWith(P + "/")`,
// so the registered prefix must not carry a trailing slash.
const PREFIX = "/remote-tunnel";
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

/** Start one `up` per alias; concurrent callers share the same promise. */
const inFlight = new Map();

/** Client-half lifecycle, filled by /remote-tunnel/report. */
const clientStatus = { loadedAt: null, openedAt: null, lastError: null, events: [] };

function record(event, detail) {
  const at = new Date().toISOString();
  if (event === "loaded") clientStatus.loadedAt = at;
  if (event === "opened") clientStatus.openedAt = at;
  if (event === "error") clientStatus.lastError = detail ?? "unknown";
  clientStatus.events.push({ at, event, detail: detail ?? null });
  if (clientStatus.events.length > 25) clientStatus.events.shift();
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { ...JSON_HEADERS, "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function message(error) {
  if (error instanceof TunnelError) return error.hint !== undefined ? `${error.message} (${error.hint})` : error.message;
  return error instanceof Error ? error.message : String(error);
}

/** Register the /remote-tunnel/ routes. Returns after registering; the
 *  disposer removes every route when the plugin unloads. */
export function registerWebRoutes(ctx, manager, services) {
  const webServer = ctx.get("webServer");
  if (webServer === undefined) return;
  const dispose = webServer.register({
    kind: "prefix",
    path: PREFIX,
    handler: (req, res) => {
      void handle(manager, services, req, res);
    }
  });
  ctx.effect(() => () => dispose(), "remote-tunnel.web");
}

async function handle(manager, services, req, res) {
  const url = new URL(req.url ?? PREFIX, "http://127.0.0.1");
  const action = url.pathname.slice(PREFIX.length).replace(/^\/+/, "");
  try {
    switch (action) {
      case "report":
        record(url.searchParams.get("event") ?? "unknown", url.searchParams.get("detail"));
        return sendJson(res, 200, { ok: true });
      case "state":
        return sendJson(res, 200, {
          ok: true,
          services: services ?? null,
          client: clientStatus,
          tunnels: manager.listStatesLocal()
        });
      case "open": {
        const states = manager.listStatesLocal();
        const wanted = url.searchParams.get("host");
        const state = wanted !== null && wanted.length > 0
          ? states.find((s) => s.alias === wanted)
          : states[0];
        if (state === undefined) {
          return sendJson(res, 409, {
            ok: false,
            error: wanted !== null && wanted.length > 0 ? `no tunnel for "${wanted}"` : "no tunnel is up",
            hint: "start one with /remote up <host> (or GET /remote-tunnel/up?host=<alias>)"
          });
        }
        return sendJson(res, 200, {
          ok: true,
          alias: state.alias,
          url: state.url,
          authUrl: state.authUrl ?? state.url,
          remotePort: state.remotePort
        });
      }
      case "up": {
        const alias = url.searchParams.get("host");
        if (alias === null || alias.length === 0) {
          return sendJson(res, 400, { ok: false, error: "missing ?host=<alias>" });
        }
        let pending = inFlight.get(alias);
        if (pending === undefined) {
          pending = manager.up(alias, {});
          inFlight.set(alias, pending);
          pending.catch(() => {}).finally(() => inFlight.delete(alias));
        }
        const result = await pending;
        return sendJson(res, 200, {
          ok: true,
          alias: result.alias,
          url: result.url,
          authUrl: result.authUrl ?? result.url,
          remotePort: result.remotePort,
          workspace: result.workspace
        });
      }
      case "down": {
        const alias = url.searchParams.get("host") ?? manager.listStatesLocal()[0]?.alias;
        if (alias === undefined) return sendJson(res, 409, { ok: false, error: "no tunnel is up" });
        const result = await manager.down(alias, { keepService: url.searchParams.get("keep-service") === "1" });
        return sendJson(res, 200, { ok: true, alias, ...result });
      }
      default:
        return sendJson(res, 404, { ok: false, error: `unknown remote-tunnel action "${action}"` });
    }
  } catch (error) {
    sendJson(res, 500, { ok: false, error: message(error) });
  }
}
