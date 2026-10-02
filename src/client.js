// dsh-remote-tunnel — browser half.
//
// Hand-written in the bundle format the client module system loads
// (window.__ModuleLoader__.load({ id, factory })), so the package needs no
// build step: npm, GitHub and local-directory installs ship this same file.
//
// Two jobs, both client-side by nature:
//   1. render the /remote command node (the chat dispatches
//      'conversation.chat.commandview' keyed by command name);
//   2. open the remote workspace in the right sidebar, on demand.
// It declares no `inject`: services are resolved lazily so the plugin always
// applies and reports what happened, even when a service mounts late.
window.__ModuleLoader__.load({
  id: "dsh-remote-tunnel",
  factory(require) {
    "use strict";
    var ROUTE = "/remote-tunnel/";
    var COMMAND_VIEW = "conversation.chat.commandview";
    var React = require("react");
    var h = React.createElement;

    function textOf(error) {
      if (error === undefined || error === null) return "unknown error";
      return error.message !== undefined ? error.message : String(error);
    }

    function report(event, detail) {
      // Two transports on purpose: if fetch is blocked by the shell carrier but
      // subresource loads are not (or the other way round), the host still
      // learns what the browser half did.
      var query = ROUTE + "report?event=" + encodeURIComponent(event) +
        (detail === undefined ? "" : "&detail=" + encodeURIComponent(String(detail).slice(0, 300)));
      try {
        if (typeof fetch === "function") fetch(query, { headers: { accept: "application/json" } }).catch(function () {});
      } catch (error) { /* diagnostics must never break the page */ }
      try {
        var image = new Image();
        image.src = query + "&beacon=" + String(Date.now());
      } catch (error) { /* ignore */ }
    }

    async function callHost(action) {
      var response = await fetch(ROUTE + action, { headers: { accept: "application/json" } });
      var body = {};
      try {
        body = await response.json();
      } catch (error) {
        body = {};
      }
      if (!response.ok) throw new Error(body.error || ("remote-tunnel: HTTP " + response.status));
      return body;
    }

    /** Client services mount independently of this bundle; wait instead of racing. */
    async function waitFor(ctx, name, attempts) {
      for (var i = 0; i < (attempts === undefined ? 20 : attempts); i += 1) {
        var service = ctx[name];
        if (service !== undefined && service !== null) return service;
        await new Promise(function (resolve) { setTimeout(resolve, 500); });
      }
      throw new Error("service '" + name + "' never mounted");
    }

    var S = {
      card: {
        display: "flex", flexDirection: "column", gap: "6px", padding: "10px 12px",
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))",
        borderRadius: "12px", fontSize: "13px", lineHeight: "20px", color: "inherit"
      },
      head: { display: "flex", alignItems: "baseline", gap: "8px", fontWeight: 600 },
      args: { opacity: 0.6, fontWeight: 400, fontSize: "12px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
      badge: { marginLeft: "auto", fontSize: "11px", opacity: 0.7, fontWeight: 400 },
      out: {
        margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "12px", opacity: 0.9
      },
      row: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" },
      button: {
        font: "inherit", fontSize: "12px", padding: "4px 10px", cursor: "pointer",
        color: "inherit", background: "transparent", borderRadius: "8px",
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))"
      },
      muted: { opacity: 0.65, fontSize: "12px" },
      error: { color: "var(--dsw-alias-label-error, #d4380d)", fontSize: "12px" }
    };

    return {
      name: "remote-tunnel",
      apply: function (ctx) {
        function sidebar() {
          return ctx.sidebarRight;
        }

        async function openPanel(host) {
          var service = sidebar();
          if (service === undefined || typeof service.openTab !== "function") {
            throw new Error("the sidebarRight service is unavailable (no Browser panel here)");
          }
          var state = await callHost("open?mode=panel" + (host ? "&host=" + encodeURIComponent(host) : ""));
          service.openTab("browser", { params: { url: state.authUrl } });
          return state;
        }

        function Card(props) {
          var node = props && props.node ? props.node : {};
          var outcome = node.outcome || null;
          var statusState = React.useState(null);
          var busyState = React.useState("");
          var errorState = React.useState(null);
          var status = statusState[0], setStatus = statusState[1];
          var busy = busyState[0], setBusy = busyState[1];
          var error = errorState[0], setError = errorState[1];

          var refresh = React.useCallback(function () {
            callHost("status").then(function (value) { setStatus(value); setError(null); },
              function (failure) { setError(textOf(failure)); });
          }, []);
          React.useEffect(function () { refresh(); }, [refresh]);

          function aliasOfTunnel() {
            return status && status.tunnels && status.tunnels.length > 0 ? status.tunnels[0].alias : undefined;
          }

          function run(mode) {
            setBusy(mode);
            setError(null);
            var alias = aliasOfTunnel();
            var work = mode === "browser"
              ? callHost("open?mode=browser" + (alias ? "&host=" + encodeURIComponent(alias) : ""))
              : openPanel(alias);
            work.then(function () { setBusy(""); refresh(); },
              function (failure) { setBusy(""); setError(textOf(failure)); });
          }

          function start() {
            var alias = status && status.hosts && status.hosts.length > 0 ? status.hosts[0].alias : undefined;
            if (alias === undefined) {
              setError("no host defined — add one in ~/.ssh/config or with 'hosts add'");
              return;
            }
            setBusy("up");
            setError(null);
            callHost("up?host=" + encodeURIComponent(alias)).then(function () { setBusy(""); refresh(); },
              function (failure) { setBusy(""); setError(textOf(failure)); });
          }

          var tunnel = status && status.tunnels && status.tunnels.length > 0 ? status.tunnels[0] : null;
          var children = [
            h("div", { key: "head", style: S.head },
              h("span", null, "/" + (node.name || "remote")),
              node.args ? h("span", { style: S.args }, node.args) : null,
              h("span", { style: S.badge },
                outcome === null ? "running" : outcome.kind === "error" ? "失败 / failed" : "完成 / done"))
          ];
          if (outcome && outcome.text) children.push(h("pre", { key: "out", style: S.out }, outcome.text));
          children.push(h("div", { key: "tunnel", style: S.muted },
            tunnel !== null
              ? "隧道:" + tunnel.alias + " · " + tunnel.host + ":" + tunnel.remotePort + " · " + tunnel.url + (tunnel.workspace ? " · " + tunnel.workspace : "")
              : (status === null ? "读取状态中… / reading status" : "当前没有隧道在跑 / no tunnel is up")));
          children.push(h("div", { key: "buttons", style: S.row },
            h("button", { style: S.button, disabled: busy !== "", onClick: function () { run("browser"); } },
              busy === "browser" ? "打开中…" : "在浏览器打开"),
            h("button", { style: S.button, disabled: busy !== "", onClick: function () { run("panel"); } },
              busy === "panel" ? "打开中…" : "在侧栏打开"),
            status !== null && tunnel === null
              ? h("button", { style: S.button, disabled: busy !== "", onClick: start }, busy === "up" ? "启动中…" : "启动隧道 / up")
              : null,
            h("button", { style: S.button, disabled: busy !== "", onClick: refresh }, "刷新 / refresh")));
          if (error !== null) children.push(h("div", { key: "error", style: S.error }, error));
          if (status && status.hosts && status.hosts.length > 1) {
            children.push(h("div", { key: "hosts", style: S.muted },
              "主机 / hosts:" + status.hosts.map(function (item) { return item.alias; }).join(", ")));
          }
          return h("div", { style: S.card }, children);
        }

        globalThis.__dshRemoteTunnel = { openPanel: openPanel, callHost: callHost, report: report };

        report("loaded");

        // The chat dispatches this child slot with entryKey = command name, so
        // every /remote node gets our card instead of the generic one.
        waitFor(ctx, "slots").then(function (slots) {
          slots.inject(COMMAND_VIEW, function () {
            return slots.register({ name: COMMAND_VIEW, key: "remote" }, Card);
          });
          report("view", COMMAND_VIEW + "#remote");
        }, function (failure) {
          report("error", "slots: " + textOf(failure));
        });

        // Auto-open is off unless the plugin config asks for it: the card's
        // buttons (and /remote open) are the normal way in.
        if (globalThis.__dshRemoteTunnelIgnited !== true) {
          globalThis.__dshRemoteTunnelIgnited = true;
          callHost("status").then(function (value) {
            if (value && value.config && value.config.autoOpen === true) return ignite();
            report("idle", "autoOpen is off; use the /remote card or a command");
          }, function (failure) {
            report("error", "status: " + textOf(failure));
          });
        }

        async function ignite() {
          var last;
          for (var attempt = 1; attempt <= 15; attempt += 1) {
            try {
              var state = await openPanel();
              report("opened", state && state.alias ? state.alias : "ok");
              return;
            } catch (error) {
              last = error;
              if (attempt === 1 || attempt % 5 === 0) {
                report("retry", attempt + ": " + textOf(error));
              }
              await new Promise(function (resolve) { setTimeout(resolve, 2000); });
            }
          }
          report("error", textOf(last));
        }
      }
    };
  }
});
