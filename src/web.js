import { TunnelError } from "./errors.js";
import { record, snapshot } from "./probe.js";

// dsh-remote-tunnel host half for the browser UI: the HTTP surface the client
// bundle calls. Routes live under /remote-tunnel/ and ride the same carrier as
// the rest of the GUI — the browser half reaches them through the shell origin.
//
// Every request is admitted through `ctx.connection.admit()`, the same
// Host/Origin fence plus browser-session check the /api channel uses: these
// routes hand out a URL that carries a one-time launch token, so an
// unauthenticated loopback caller must not be able to read it. A carrier that
// cannot present a cookie can be accommodated with the `auth: false` config.
//
// The desktop renderer talks to us without a cookie observable from outside, so
// `report` doubles as a black box: the client half records its lifecycle here
// and `status` exposes it, together with which host services ever mounted.

// NB: the webserver matches a prefix P as `path === P || path.startsWith(P + "/")`,
// so the registered prefix must not carry a trailing slash.
const PREFIX = "/remote-tunnel";
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

/** Start one `up` per alias; concurrent callers share the same promise. */
const inFlight = new Map();

function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { ...JSON_HEADERS, "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function message(error) {
  if (error instanceof TunnelError) return error.hint !== undefined ? `${error.message} (${error.hint})` : error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Apply the platform's request trust and browser authentication.
 *
 * @returns the rejection status (403 fence / 401 unauthenticated), or undefined
 *   when the request is admitted — or when checking is disabled/unavailable.
 */
export function authRejection(connection, settings, request) {
  if (settings?.auth === false) return undefined;
  if (connection === undefined || typeof connection.admit !== "function") return undefined;
  const admission = connection.admit(request);
  return admission !== null && typeof admission === "object" && "rejection" in admission
    ? admission.rejection
    : undefined;
}

/** Resolve the tunnel this request is about: ?host=<alias>, else the only one. */
function pickTunnel(manager, wanted) {
  const states = manager.listStatesLocal();
  if (wanted === null || wanted === undefined || wanted.length === 0) return states[0];
  return states.find((state) => state.alias === wanted);
}

/** Register the /remote-tunnel/ routes. Returns after registering; the
 *  disposer removes every route when the plugin unloads. */
export function registerWebRoutes(ctx, manager, services, settings) {
  const webServer = ctx.get("webServer");
  if (webServer === undefined) return;
  // The Connection service can mount after this row, so it is resolved per
  // request rather than captured here (a missing service means "no check
  // available", which `authRejection` treats as unverified-but-allowed).
  const connection = () => {
    try {
      return ctx.get("connection");
    } catch (error) {
      return undefined;
    }
  };
  const dispose = webServer.register({
    kind: "prefix",
    path: PREFIX,
    handler: (req, res) => {
      void handle(connection, manager, services, settings, req, res);
    }
  });
  ctx.effect(() => () => dispose(), "remote-tunnel.web");
}

async function handle(connection, manager, services, settings, req, res) {
  const url = new URL(req.url ?? PREFIX, "http://127.0.0.1");
  const action = url.pathname.slice(PREFIX.length).replace(/^\/+/, "");
  try {
    const rejection = authRejection(connection(), settings, req);
    if (rejection !== undefined) {
      record("rejected", rejection + " " + action);
      res.writeHead(rejection, { ...JSON_HEADERS });
      res.end();
      return;
    }
    switch (action) {
      case "report":
        record(url.searchParams.get("event") ?? "unknown", url.searchParams.get("detail"));
        return sendJson(res, 200, { ok: true });
      case "state":
      case "status": {
        let hosts = [];
        try {
          hosts = manager.listHosts();
        } catch (error) {
          hosts = [];
        }
        // Candidates from ~/.ssh/known_hosts: what the user connected to at
        // least once but has not managed here yet. Its own try on purpose — an
        // unreadable known_hosts (permissions, a directory in its place) must
        // not blank the host list the rest of the pane depends on.
        let discovery = { hosts: [], knownHosts: { path: null, exists: false, hashed: 0, revoked: 0 } };
        try {
          discovery = manager.discoverHosts();
        } catch (error) {
          discovery = { hosts: [], knownHosts: { path: null, exists: false, hashed: 0, revoked: 0, error: message(error) } };
        }
        return sendJson(res, 200, {
          ok: true,
          services: services ?? null,
          config: {
            openIn: settings?.openIn ?? "ask",
            autoOpen: settings?.autoOpen === true,
            dock: settings?.dock !== false
          },
          hosts,
          discovered: discovery.hosts,
          discovery: discovery.knownHosts,
          tunnels: manager.listStatesLocal(),
          client: snapshot()
        });
      }
      case "open": {
        const state = pickTunnel(manager, url.searchParams.get("host"));
        if (state === undefined) {
          return sendJson(res, 409, {
            ok: false,
            error: "no tunnel is up",
            hint: "start one with /remote up <host> (or GET /remote-tunnel/up?host=<alias>)"
          });
        }
        const mode = url.searchParams.get("mode") ?? settings?.openIn ?? "ask";
        if (mode === "browser") {
          // The host owns the window system: this is the same opener the CLI uses.
          manager.open(state.alias, state.authUrl ?? undefined);
          return sendJson(res, 200, { ok: true, alias: state.alias, mode: "browser", url: state.url });
        }
        return sendJson(res, 200, {
          ok: true,
          alias: state.alias,
          mode,
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
      // Managing hosts writes the plugin's own config.yaml — never ~/.ssh.
      // A write is spelled out by `confirm=1` so a prefetch or a link scanner
      // cannot edit the file by accident; the admission above already keeps
      // every cross-site caller out.
      case "hosts/add": {
        if (url.searchParams.get("confirm") !== "1") {
          return sendJson(res, 400, { ok: false, error: "hosts/add writes the config — pass confirm=1" });
        }
        const added = manager.addHost({
          alias: url.searchParams.get("alias") ?? "",
          host: url.searchParams.get("host") ?? "",
          port: url.searchParams.get("port") ?? 22,
          user: url.searchParams.get("user") ?? undefined,
          workspace: url.searchParams.get("workspace") ?? undefined,
          overwrite: url.searchParams.get("overwrite") === "1"
        });
        return sendJson(res, 200, { ok: true, ...added });
      }
      case "hosts/remove": {
        if (url.searchParams.get("confirm") !== "1") {
          return sendJson(res, 400, { ok: false, error: "hosts/remove writes the config — pass confirm=1" });
        }
        const alias = url.searchParams.get("alias");
        if (alias === null || alias.length === 0) {
          return sendJson(res, 400, { ok: false, error: "missing ?alias=<alias>" });
        }
        const removed = manager.removeHost(alias);
        return sendJson(res, 200, { ok: true, ...removed });
      }
      default:
        return sendJson(res, 404, { ok: false, error: `unknown remote-tunnel action "${action}"` });
    }
  } catch (error) {
    // A rejected form value is the caller's mistake, not a server fault.
    const code = error instanceof TunnelError ? error.code : undefined;
    const status = code === "E_USAGE" ? 400
      : code === "E_HOST_EXISTS" ? 409
        : code === "E_UNKNOWN_HOST" ? 404
          : 500;
    sendJson(res, status, { ok: false, error: message(error), code: code ?? null });
  }
}
