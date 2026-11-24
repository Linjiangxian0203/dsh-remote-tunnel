import { readFileSync } from "node:fs";
import { TunnelError } from "./errors.js";
import { record, snapshot } from "./probe.js";

// The plugin's own version, read once: the sidebar pane shows it so a user can
// tell which build is live (the desktop app's Plugins page renders no version).
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? null;
  } catch (error) {
    return null;
  }
})();

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
 * The admission fence itself is broken: the Connection service exists but its
 * `admit()` call threw. Distinct from 401/403 — the request was never judged.
 */
export const ADMISSION_UNAVAILABLE = 503;

/**
 * Apply the platform's request trust and browser authentication.
 *
 * @returns the rejection status (403 fence / 401 unauthenticated / 503 when the
 *   fence cannot run), or undefined when the request is admitted — or when
 *   checking is disabled or no Connection service is mounted.
 */
export function authRejection(connection, settings, request) {
  if (settings?.auth === false) return undefined;
  if (connection === undefined || typeof connection.admit !== "function") return undefined;
  let admission;
  try {
    admission = connection.admit(request);
  } catch (error) {
    // A fence that cannot run must not turn every route into an opaque 500 —
    // and must not fall open either: these routes hand out a URL that carries
    // a one-time launch token. Report it as a clear "unavailable" instead.
    record("admission-failed", message(error));
    return ADMISSION_UNAVAILABLE;
  }
  return admission !== null && typeof admission === "object" && "rejection" in admission
    ? admission.rejection
    : undefined;
}

/**
 * Build the per-request resolver for the Connection service.
 *
 * DSH 0.2.3 (Cordis 4.2) wraps services in context-tracking proxies: a method
 * body runs against the **calling** context, so `connection.admit()` reading
 * its own `connection.authentication` throws `cannot get property
 * "connection.authentication" without inject` unless the caller's inject list
 * names it. Reading through a child context that declares both keeps the fence
 * working; on older hosts there is no `connection.authentication` service and
 * the callback simply never fires, so the base context is used unchanged.
 *
 * The service can also mount after this row, so it is resolved per request
 * rather than captured here.
 */
function connectionReader(ctx, services) {
  let admissionScope;
  try {
    ctx.inject(["connection", "connection.authentication"], (scoped) => {
      admissionScope = scoped;
      if (services !== undefined) services.admission = "injected";
      record("admission", "connection.authentication is injectable");
    });
  } catch (error) {
    record("admission-scope-failed", message(error));
  }
  return () => {
    const candidates = admissionScope === undefined ? [ctx] : [admissionScope, ctx];
    for (const candidate of candidates) {
      try {
        const connection = candidate.get("connection");
        if (connection !== undefined) return connection;
      } catch (error) {
        // Try the next context; a composition without Connection is allowed
        // and `authRejection` treats it as "no check available".
      }
    }
    return undefined;
  };
}

/** Resolve the tunnel this request is about: ?host=<alias>, else the only one. */
function pickTunnel(manager, wanted) {
  const states = manager.listStatesLocal();
  if (wanted === null || wanted === undefined || wanted.length === 0) return states[0];
  return states.find((state) => state.alias === wanted);
}

/**
 * Register the /remote-tunnel/ routes.
 *
 * @returns "registered" when the routes are live, or the reason they are not
 *   ("missing" = no webServer service mounted, "failed" = register() threw).
 *   Callers expose the outcome through `/remote-tunnel/status`, so a plugin
 *   that is active but has no routes is diagnosable instead of silent.
 */
export function registerWebRoutes(ctx, manager, services, settings) {
  const webServer = ctx.get("webServer");
  if (webServer === undefined) {
    record("web-unavailable", "webServer service is not mounted");
    if (services !== undefined) services.webServer = "missing";
    return "missing";
  }
  const connection = connectionReader(ctx, services);
  let dispose;
  try {
    dispose = webServer.register({
      kind: "prefix",
      path: PREFIX,
      handler: (req, res) => {
        void handle(connection, manager, services, settings, req, res);
      }
    });
  } catch (error) {
    // Registering a route is where a host API change surfaces first. Record it
    // instead of letting the inject callback reject and leave the plugin
    // "active" with no routes and no explanation.
    record("web-register-failed", message(error));
    if (services !== undefined) services.webServer = "failed";
    return "failed";
  }
  if (services !== undefined) services.webServer = "registered";
  ctx.effect(() => () => dispose(), "remote-tunnel.web");
  return "registered";
}

async function handle(connection, manager, services, settings, req, res) {
  const url = new URL(req.url ?? PREFIX, "http://127.0.0.1");
  const action = url.pathname.slice(PREFIX.length).replace(/^\/+/, "");
  try {
    const rejection = authRejection(connection(), settings, req);
    if (rejection !== undefined) {
      record("rejected", rejection + " " + action);
      if (rejection === ADMISSION_UNAVAILABLE) {
        return sendJson(res, ADMISSION_UNAVAILABLE, {
          ok: false,
          error: "request admission is unavailable in this host",
          code: "E_ADMISSION_UNAVAILABLE"
        });
      }
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
        let hidden = [];
        try {
          // The pane's lists leave out what the user hid there; the CLI still
          // lists everything, which is why the filter lives here and not in
          // listHosts().
          hosts = manager.listVisibleHosts();
          hidden = manager.hiddenKeys();
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
          version: VERSION,
          services: services ?? null,
          config: {
            openIn: settings?.openIn ?? "ask",
            autoOpen: settings?.autoOpen === true,
            dock: settings?.dock !== false
          },
          hosts,
          hidden,
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
      // Hiding is a display preference, not a delete: it only ever writes the
      // plugin's own config.yaml, so a ~/.ssh/config entry can be put out of the
      // way without touching the user's ssh setup.
      case "hosts/hide": {
        if (url.searchParams.get("confirm") !== "1") {
          return sendJson(res, 400, { ok: false, error: "hosts/hide writes the config — pass confirm=1" });
        }
        const key = url.searchParams.get("key");
        if (key === null || key.length === 0) {
          return sendJson(res, 400, { ok: false, error: "missing ?key=<alias|host:port>" });
        }
        const result = manager.hideHost(key, url.searchParams.get("hidden") !== "0");
        return sendJson(res, 200, { ok: true, ...result });
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
