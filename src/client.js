// dsh-remote-tunnel — browser half.
//
// Hand-written in the bundle format the client module system loads
// (window.__ModuleLoader__.load({ id, factory })), so the package needs no
// build step: npm, GitHub and local-directory installs ship this same file.
//
// Two jobs, both client-side by nature:
//   1. render the /remote command node (the chat dispatches
//      'conversation.chat.commandview' keyed by command name);
//   2. drive the tunnel and open the remote workspace — in the right sidebar or
//      in the system browser, the two modes the plugin offers.
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

    /**
     * Run `callback(service, owner)` once a client service is mounted.
     *
     * Two traps live here: the row mounts concurrently with the services it
     * needs, and reading an unmounted service off the context *throws*
     * ("cannot get property … without inject") instead of returning undefined —
     * so a naive poll rejects on its first try. `ctx.inject` is the race-free
     * path; polling with a caught throw is the fallback.
     */
    function whenService(ctx, name, callback) {
      var delivered = false;
      function deliver(service, owner) {
        if (delivered) return;
        delivered = true;
        callback(service, owner);
      }
      (function poll(attempt) {
        if (delivered) return;
        var service;
        try {
          service = ctx[name];
        } catch (error) {
          service = undefined;
        }
        if (service !== undefined && service !== null) {
          deliver(service, ctx);
          return;
        }
        if (attempt >= 40) {
          report("error", "service '" + name + "' never mounted");
          return;
        }
        setTimeout(function () { poll(attempt + 1); }, 500);
      })(0);
      if (typeof ctx.inject === "function") {
        try {
          ctx.inject([name], function (scoped) {
            var service;
            try {
              service = scoped[name];
            } catch (error) {
              service = undefined;
            }
            if (service !== undefined && service !== null) deliver(service, scoped);
          });
        } catch (error) { /* the poll above covers this */ }
      }
    }

    var TONE = { ok: "#3fa45b", error: "#d4380d", running: "#8a8a8a" };

    var S = {
      card: {
        display: "flex", flexDirection: "column", gap: "6px", padding: "10px 12px",
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))",
        borderRadius: "12px", fontSize: "13px", lineHeight: "20px", color: "inherit"
      },
      head: { display: "flex", alignItems: "baseline", gap: "8px", fontWeight: 600 },
      args: { opacity: 0.6, fontWeight: 400, fontSize: "12px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
      // A status label, deliberately not button-shaped: the colour lives in the dot.
      badge: { marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11px", fontWeight: 400, opacity: 0.75 },
      dot: { width: "7px", height: "7px", borderRadius: "50%", display: "inline-block" },
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
      danger: {
        font: "inherit", fontSize: "12px", padding: "4px 10px", cursor: "pointer",
        background: "transparent", borderRadius: "8px",
        border: "1px solid rgba(212,56,13,0.55)", color: "#d4380d"
      },
      select: {
        font: "inherit", fontSize: "12px", padding: "3px 6px", borderRadius: "8px",
        color: "inherit", background: "transparent",
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))"
      },
      muted: { opacity: 0.65, fontSize: "12px" },
      error: { color: "var(--dsw-alias-label-error, #d4380d)", fontSize: "12px" }
    };

    function hostQuery(alias) {
      return alias === undefined || alias === null || alias === "" ? "" : "&host=" + encodeURIComponent(alias);
    }

    return {
      name: "remote-tunnel",
      apply: function (ctx) {
        var sidebarService = null;

        function sidebar() {
          if (sidebarService !== null) return sidebarService;
          try {
            return ctx.sidebarRight;
          } catch (error) {
            return undefined;
          }
        }

        async function openPanel(host) {
          var service = sidebar();
          if (service === undefined || typeof service.openTab !== "function") {
            throw new Error("the sidebarRight service is unavailable (no Browser panel here)");
          }
          var state = await callHost("open?mode=panel" + hostQuery(host));
          service.openTab("browser", { params: { url: state.authUrl } });
          return state;
        }

        function Card(props) {
          var node = props && props.node ? props.node : {};
          var outcome = node.outcome || null;
          var statusState = React.useState(null);
          var busyState = React.useState("");
          var errorState = React.useState(null);
          var confirmState = React.useState(false);
          var pickState = React.useState(null);
          var status = statusState[0], setStatus = statusState[1];
          var busy = busyState[0], setBusy = busyState[1];
          var error = errorState[0], setError = errorState[1];
          var confirming = confirmState[0], setConfirming = confirmState[1];
          var picked = pickState[0], setPicked = pickState[1];

          var refresh = React.useCallback(function () {
            callHost("status").then(function (value) { setStatus(value); setError(null); },
              function (failure) { setError(textOf(failure)); });
          }, []);
          React.useEffect(function () { refresh(); }, [refresh]);
          // The disconnect confirmation expires by itself, so a stray first click
          // can never arm the destructive action indefinitely.
          React.useEffect(function () {
            if (!confirming) return undefined;
            var timer = setTimeout(function () { setConfirming(false); }, 5000);
            return function () { clearTimeout(timer); };
          }, [confirming]);

          function tunnel() {
            return status && status.tunnels && status.tunnels.length > 0 ? status.tunnels[0] : null;
          }

          function target() {
            if (picked !== null && picked !== "") return picked;
            var current = tunnel();
            if (current !== null) return current.alias;
            return status && status.hosts && status.hosts.length > 0 ? status.hosts[0].alias : undefined;
          }

          function work(mode, promise) {
            setBusy(mode);
            setError(null);
            setConfirming(false);
            promise.then(function () { setBusy(""); refresh(); },
              function (failure) { setBusy(""); setError(textOf(failure)); });
          }

          function openIn(mode) {
            var alias = target();
            work(mode, mode === "browser"
              ? callHost("open?mode=browser" + hostQuery(alias))
              : openPanel(alias));
          }

          function start() {
            var alias = target();
            if (alias === undefined) {
              setError("no host defined — add one in ~/.ssh/config or with 'hosts add'");
              return;
            }
            work("up", callHost("up?host=" + encodeURIComponent(alias)));
          }

          function stop() {
            var alias = target();
            if (alias === undefined) return;
            work("down", callHost("down?host=" + encodeURIComponent(alias)));
          }

          var current = tunnel();
          var tone = outcome === null ? "running" : outcome.kind === "error" ? "error" : "ok";
          var label = outcome === null ? "执行中 / running" : outcome.kind === "error" ? "失败 / failed" : "完成 / done";

          var children = [
            h("div", { key: "head", style: S.head },
              h("span", null, "/" + (node.name || "remote")),
              node.args ? h("span", { style: S.args }, node.args) : null,
              h("span", { key: "state", style: S.badge, title: "命令状态 / command outcome" },
                h("span", { style: Object.assign({}, S.dot, { background: TONE[tone] }) }),
                label))
          ];
          if (outcome && outcome.text) children.push(h("pre", { key: "out", style: S.out }, outcome.text));
          children.push(h("div", { key: "tunnel", style: S.muted },
            current !== null
              ? "隧道:" + current.alias + " · " + current.host + ":" + current.remotePort + " · " + current.url + (current.workspace ? " · " + current.workspace : "")
              : (status === null ? "读取状态中… / reading status" : "当前没有隧道在跑 / no tunnel is up")));

          if (status && status.hosts && status.hosts.length > 1) {
            children.push(h("div", { key: "pick", style: S.row },
              h("span", { style: S.muted }, "主机 / host"),
              h("select", {
                style: S.select,
                value: picked === null ? (target() || "") : picked,
                onChange: function (event) { setPicked(event.target.value); }
              }, status.hosts.map(function (item) {
                return h("option", { key: item.alias, value: item.alias }, item.alias + " · " + item.host + ":" + item.port);
              }))));
          }

          var buttons = [
            h("button", { key: "browser", style: S.button, disabled: busy !== "", onClick: function () { openIn("browser"); } },
              busy === "browser" ? "打开中…" : "在浏览器打开"),
            h("button", { key: "panel", style: S.button, disabled: busy !== "", onClick: function () { openIn("panel"); } },
              busy === "panel" ? "打开中…" : "在侧栏打开")
          ];
          if (status !== null && current === null) {
            buttons.push(h("button", { key: "up", style: S.button, disabled: busy !== "", onClick: start },
              busy === "up" ? "连接中…" : "启动隧道 / up"));
          }
          if (current !== null) {
            buttons.push(h("button", {
              key: "down",
              style: confirming ? S.danger : S.button,
              disabled: busy !== "",
              onClick: function () { if (confirming) stop(); else setConfirming(true); }
            }, busy === "down" ? "断开中…" : confirming ? "确认断开?" : "断开连接 / down"));
          }
          buttons.push(h("button", { key: "refresh", style: S.button, disabled: busy !== "", onClick: refresh }, "刷新 / refresh"));
          children.push(h("div", { key: "buttons", style: S.row }, buttons));
          if (confirming) {
            children.push(h("div", { key: "warn", style: S.muted },
              "再次点击「确认断开?」将停止隧道、停掉服务器上的 dsh-web 并释放端口(5 秒后自动取消)"));
          }
          if (error !== null) children.push(h("div", { key: "error", style: S.error }, error));
          return h("div", { style: S.card }, children);
        }

        globalThis.__dshRemoteTunnel = { openPanel: openPanel, callHost: callHost, report: report };

        report("loaded");

        whenService(ctx, "sidebarRight", function (service) {
          sidebarService = service;
          report("service", "sidebarRight");
        });

        // The chat dispatches this child slot with entryKey = command name, so
        // every /remote node gets our card instead of the generic one.
        whenService(ctx, "slots", function (slots) {
          try {
            slots.inject(COMMAND_VIEW, function () {
              var disposer = slots.register({ name: COMMAND_VIEW, key: "remote" }, Card);
              // Reported from inside the registration, so the event means the
              // card is really in the slot table — not merely that we asked.
              report("view", COMMAND_VIEW + "#remote");
              return disposer;
            });
          } catch (error) {
            report("error", "view: " + textOf(error));
          }
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
