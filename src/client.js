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
    // The strip above the composer: always rendered, in an empty session too.
    var DOCK = "conversation.composer.dock";
    // The right sidebar: one tab type plus the pane that renders it. This is the
    // only entry the plugin can offer in a session with no model history.
    var TAB_PANE = "sidebar.right.pane.tab";
    var TAB_ID = "dsh-remote-tunnel/hosts";
    var TAB_KIND = "remote-hosts";
    var TAB_TITLE = "远程连接";
    // apply() installs this seam. The pane below is declared here, outside the
    // plugin context, so it cannot see the context-scoped helpers (openPanel and
    // the sidebar service) that the card and the dock use — reaching for them
    // directly was a ReferenceError that made "在侧栏打开" do nothing at all.
    var openTabFromPane = null;
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
      // A native popup ignores `color: inherit` and paints its own surface, so
      // the ink AND the surface are spelled out with the theme aliases — without
      // them the host picker rendered white text on the white popup.
      select: {
        font: "inherit", fontSize: "12px", padding: "3px 6px", borderRadius: "8px",
        color: "var(--dsw-alias-label-primary, inherit)",
        background: "var(--dsw-alias-bg-base, #1c1c20)",
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))"
      },
      option: {
        color: "var(--dsw-alias-label-primary, inherit)",
        background: "var(--dsw-alias-bg-base, #1c1c20)"
      },
      // The add-a-host form: same surface/ink treatment as the picker, so the
      // fields stay readable in either theme.
      input: {
        flex: "1 1 auto", minWidth: "0", font: "inherit", fontSize: "12px", padding: "3px 6px", borderRadius: "8px",
        color: "var(--dsw-alias-label-primary, inherit)",
        background: "var(--dsw-alias-bg-base, #1c1c20)",
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))"
      },
      formRow: { display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" },
      formLabel: { flex: "0 0 auto", width: "76px", opacity: 0.7 },
      guideLine: { fontSize: "12px", lineHeight: "18px" },
      muted: { opacity: 0.65, fontSize: "12px" },
      error: { color: "var(--dsw-alias-label-error, #d4380d)", fontSize: "12px" },
      // The always-on strip above the composer: one compact line, the same
      // visual weight as the stats pills it sits beside.
      dock: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", fontSize: "12px", color: "inherit", opacity: 0.85 },
      dockButton: {
        font: "inherit", fontSize: "11px", padding: "2px 8px", cursor: "pointer",
        color: "inherit", background: "transparent", borderRadius: "999px",
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))"
      },
      dockLabel: { display: "inline-flex", alignItems: "center", gap: "6px", fontWeight: 500 },
      // The host management rows: one line per host, one action each.
      section: { display: "flex", flexDirection: "column", gap: "4px", marginTop: "4px" },
      sectionTitle: { fontSize: "11px", opacity: 0.6, letterSpacing: "0.04em" },
      sectionHead: { display: "flex", alignItems: "center", gap: "8px", justifyContent: "space-between" },
      hostRow: { display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" },
      mono: {
        flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
      }
    };

    function hostQuery(alias) {
      return alias === undefined || alias === null || alias === "" ? "" : "&host=" + encodeURIComponent(alias);
    }

    /** Poll the host for tunnel state; the card and the dock both live on it. */
    function useTunnelStatus() {
      var state = React.useState(null);
      var setStatus = state[1];
      var refresh = React.useCallback(function () {
        callHost("status").then(function (value) { setStatus(value); }, function () { /* keep the last good state */ });
      }, []);
      React.useEffect(function () {
        refresh();
        var timer = setInterval(refresh, 15000);
        return function () { clearInterval(timer); };
      }, [refresh]);
      return { status: state[0], refresh: refresh };
    }

    /**
     * The pane's glyph: a monitor, drawn inline.
     *
     * A guide entry's `icon` is a *component* the guide renders as
     * `Icon({ size, className })` — without one it falls back to the guide's own
     * cube (`sidebar-right/lib/client.js:461`). Drawing it here keeps the bundle
     * dependency-free: the shipped types import their glyphs from
     * `dsh-client-ui-primitives`, which a hand-written bundle with no build step
     * cannot resolve.
     */
    function ComputerGlyph(props) {
      var size = props && props.size !== undefined ? props.size : 22;
      return h("svg", {
        width: size, height: size, viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round",
        className: props ? props.className : undefined, "aria-hidden": "true", focusable: "false"
      }, [
        h("rect", { key: "screen", x: "2.5", y: "4", width: "19", height: "12.5", rx: "2" }),
        h("path", { key: "neck", d: "M12 16.5v3.5" }),
        h("path", { key: "base", d: "M8.5 20.5h7" })
      ]);
    }

    /**
     * The definition of the right sidebar's「远程连接」tab type.
     *
     * A page type names no `patterns`: it is opened by kind (the guide capsule,
     * or `sidebarRight.openTab("remote-hosts")`), never by a resource address.
     * `title`/`description` are functions because the guide resolves them when
     * it renders, exactly like the shipped files/browser types do it.
     */
    function hostsDefinition() {
      return {
        id: TAB_ID,
        kind: TAB_KIND,
        title: function () { return TAB_TITLE; },
        guide: [{
          // Sorted against the shipped entries (files 10, browser 30) so ours
          // keeps a stable place at the end of the guide.
          id: "hosts",
          order: 50,
          title: function () { return TAB_TITLE; },
          description: function () { return "连接远程主机,把远端 dsh web 开进侧栏"; },
          icon: ComputerGlyph
        }]
      };
    }

    /**
     * The「远程连接」pane.
     *
     * Why it exists: both 0.2.0 entries are gated by the conversation itself.
     * The /remote card lives in the transcript, which a session without model
     * history does not render (it shows the hero page), and
     * `conversation.composer.dock` is not rendered in the hero variant either,
     * so a brand-new session had no visible entry at all. The sidebar draws its
     * tab strip and its guide in every session state, so this pane is the one
     * entry that is always reachable.
     */
    function HostsPanel(props) {
      // The framework injects `useTabInfo` into the body's props; the params an
      // opener passed (e.g. the host a card or dock button was acting on) arrive
      // as `tab.navigation.params`.
      var info = props && typeof props.useTabInfo === "function" ? props.useTabInfo() : undefined;
      var params = info && info.tab && info.tab.navigation ? info.tab.navigation.params : undefined;
      var preferred = params && typeof params.host === "string" ? params.host : null;
      var tunnelState = useTunnelStatus();
      var status = tunnelState.status;
      var refresh = tunnelState.refresh;
      var busyState = React.useState("");
      var errorState = React.useState(null);
      var confirmState = React.useState(false);
      var pickState = React.useState(preferred);
      var removeState = React.useState(null);
      var pendingRemove = removeState[0], setPendingRemove = removeState[1];
      var formState = React.useState(null);
      var formErrState = React.useState(null);
      var form = formState[0], setForm = formState[1];
      var formError = formErrState[0], setFormError = formErrState[1];
      var busy = busyState[0], setBusy = busyState[1];
      var error = errorState[0], setError = errorState[1];
      var confirming = confirmState[0], setConfirming = confirmState[1];
      var picked = pickState[0], setPicked = pickState[1];
      // The disconnect confirmation expires by itself, so a stray first click
      // can never arm the destructive action indefinitely.
      React.useEffect(function () {
        if (!confirming) return undefined;
        var timer = setTimeout(function () { setConfirming(false); }, 5000);
        return function () { clearTimeout(timer); };
      }, [confirming]);
      React.useEffect(function () {
        if (pendingRemove === null) return undefined;
        var timer = setTimeout(function () { setPendingRemove(null); }, 5000);
        return function () { clearTimeout(timer); };
      }, [pendingRemove]);

      var hosts = status && Array.isArray(status.hosts) ? status.hosts : [];
      var tunnels = status && Array.isArray(status.tunnels) ? status.tunnels : [];
      var discovered = status && Array.isArray(status.discovered) ? status.discovered : [];
      var hiddenKeys = status && Array.isArray(status.hidden) ? status.hidden : [];

      function target() {
        if (picked !== null && picked !== "") return picked;
        if (tunnels.length > 0) return tunnels[0].alias;
        return hosts.length > 0 ? hosts[0].alias : undefined;
      }

      // Multi-host: the pane is about the selected host, not about "a" tunnel.
      var alias = target();
      var current = null;
      for (var index = 0; index < tunnels.length; index += 1) {
        if (tunnels[index].alias === alias) { current = tunnels[index]; break; }
      }

      function work(mode, promise) {
        setBusy(mode);
        setError(null);
        setConfirming(false);
        promise.then(function () { setBusy(""); refresh(); },
          function (failure) { setBusy(""); setError(textOf(failure)); });
      }

      function start() {
        if (alias === undefined) {
          setError("先添加一台主机:点面板里的「+ 手动添加主机」,或从「发现的主机」一键添加");
          return;
        }
        work("up", callHost("up?host=" + encodeURIComponent(alias)));
      }

      function stop() {
        if (alias === undefined) return;
        work("down", callHost("down?host=" + encodeURIComponent(alias)));
      }

      // Adding a host by hand. The rules mirror the host half's own validation,
      // so an obviously bad alias never leaves the pane — and the server checks
      // again, which is what keeps the two paths honest.
      var ALIAS_INPUT = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
      var HOST_INPUT = /^[A-Za-z0-9._:\[\]-]{1,255}$/;

      function toggleForm() {
        if (form !== null) {
          setForm(null);
          setFormError(null);
          return;
        }
        setForm({ alias: "", host: "", port: "22", user: "", workspace: "" });
        setFormError(null);
      }

      function updateForm(field, value) {
        var next = Object.assign({}, form);
        next[field] = value;
        setForm(next);
      }

      function submitForm() {
        var alias = String(form.alias || "").trim();
        var host = String(form.host || "").trim();
        var port = Number.parseInt(String(form.port || "22").trim(), 10);
        var user = String(form.user || "").trim();
        var workspace = String(form.workspace || "").trim();
        if (!ALIAS_INPUT.test(alias)) {
          setFormError("别名:字母/数字/._@-,首字符是字母或数字,最长 64");
          return;
        }
        if (!HOST_INPUT.test(host)) {
          setFormError("主机:域名、IPv4 或 [IPv6]");
          return;
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          setFormError("端口:1-65535");
          return;
        }
        setFormError(null);
        var query = "hosts/add?confirm=1&alias=" + encodeURIComponent(alias)
          + "&host=" + encodeURIComponent(host) + "&port=" + encodeURIComponent(String(port));
        if (user !== "") query += "&user=" + encodeURIComponent(user);
        if (workspace !== "") query += "&workspace=" + encodeURIComponent(workspace);
        // The form closes only on success, so a rejected field keeps its text.
        work("form", callHost(query).then(function (result) { setForm(null); return result; }));
      }

      function formRow(field, label, placeholder) {
        return h("div", { key: field, style: S.formRow }, [
          h("span", { key: "l", style: S.formLabel }, label),
          h("input", {
            key: "i", style: S.input, value: form[field], placeholder: placeholder,
            onChange: function (event) { updateForm(field, event.target.value); }
          })
        ]);
      }

      function openIn(mode) {
        if (mode === "browser") {
          work("browser", callHost("open?mode=browser" + hostQuery(alias)));
          return;
        }
        work("panel", callHost("open?mode=panel" + hostQuery(alias)).then(function (state) {
          if (typeof openTabFromPane !== "function") {
            throw new Error("the sidebarRight service is unavailable (no Browser panel here)");
          }
          openTabFromPane(state, info && info.tab ? info.tab.actions : undefined);
          return state;
        }));
      }

      // Host writes: both routes demand confirm=1, so the panel spells it out.
      function addHost(candidate) {
        // The host half proposes the alias: a known_hosts spelling such as
        // `host:port` is display text, not a legal alias (nor a legal file name).
        work("add:" + candidate.alias, callHost("hosts/add?confirm=1"
          + "&alias=" + encodeURIComponent(candidate.suggestedAlias || candidate.alias)
          + "&host=" + encodeURIComponent(candidate.host)
          + "&port=" + encodeURIComponent(String(candidate.port))));
      }

      function removeHost(entry) {
        setPendingRemove(null);
        work("remove:" + entry.alias, callHost("hosts/remove?confirm=1&alias=" + encodeURIComponent(entry.alias)));
      }

      // Hiding is a pane preference: it writes the plugin's config.yaml, never
      // ~/.ssh, and the entry can always be brought back from 已隐藏 below.
      function setHidden(key, hide) {
        work("hide:" + key, callHost("hosts/hide?confirm=1&key=" + encodeURIComponent(key) + (hide ? "" : "&hidden=0")));
      }

      var children = [
        h("div", { key: "head", style: S.head },
          h("span", null, TAB_TITLE),
          // The desktop app's Plugins page renders no version, so the pane
          // carries the one the host half reported.
          status !== null && typeof status.version === "string"
            ? h("span", { key: "version", style: S.muted }, "v" + status.version)
            : null,
          h("span", { key: "state", style: S.badge, title: "隧道状态 / tunnel" },
            h("span", { style: Object.assign({}, S.dot, { background: current !== null ? TONE.ok : TONE.running }) }),
            current !== null ? "已连接 / connected" : "未连接 / not connected"))
      ];

      if (status !== null && hosts.length > 1) {
        children.push(h("div", { key: "pick", style: S.row },
          h("span", { style: S.muted }, "主机 / host"),
          h("select", {
            style: S.select,
            value: alias === undefined ? "" : alias,
            onChange: function (event) { setPicked(event.target.value); }
          }, hosts.map(function (item) {
            return h("option", { key: item.alias, value: item.alias, style: S.option }, item.alias + " · " + item.host + ":" + item.port);
          }))));
      }

      children.push(h("div", { key: "tunnel", style: S.muted },
        current !== null
          ? "隧道:" + current.alias + " · " + current.host + ":" + current.remotePort + " · " + current.url + (current.workspace ? " · " + current.workspace : "")
          : (status === null ? "读取状态中… / reading status" : "当前没有隧道在跑 / no tunnel is up")));

      var buttons = [];
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
      buttons.push(h("button", { key: "panel", style: S.button, disabled: busy !== "", onClick: function () { openIn("panel"); } },
        busy === "panel" ? "打开中…" : "在侧栏打开"));
      buttons.push(h("button", { key: "browser", style: S.button, disabled: busy !== "", onClick: function () { openIn("browser"); } },
        busy === "browser" ? "打开中…" : "在浏览器打开"));
      buttons.push(h("button", { key: "refresh", style: S.button, disabled: busy !== "", onClick: refresh }, "刷新 / refresh"));
      children.push(h("div", { key: "buttons", style: S.row }, buttons));

      if (confirming) {
        children.push(h("div", { key: "warn", style: S.muted },
          "再次点击「确认断开?」将停止隧道、停掉服务器上的 dsh-web 并释放端口(5 秒后自动取消)"));
      }

      if (status !== null) {
        var managedRows = hosts.map(function (entry) {
          var removable = entry.origin === "plugin-config";
          var row = [
            h("span", { key: "n", style: S.mono }, entry.alias + " · " + entry.host + ":" + entry.port)
          ];
          if (removable) {
            row.push(h("button", {
              key: "rm",
              style: pendingRemove === entry.alias ? S.danger : S.dockButton,
              disabled: busy !== "",
              onClick: function () {
                if (pendingRemove === entry.alias) removeHost(entry);
                else setPendingRemove(entry.alias);
              }
            }, busy === "remove:" + entry.alias ? "删除中…" : pendingRemove === entry.alias ? "确认删除?" : "删除"));
          } else {
            row.push(h("span", { key: "src", style: S.muted }, "来自 ~/.ssh/config"));
            row.push(h("button", {
              key: "hide", style: S.dockButton, disabled: busy !== "",
              onClick: function () { setHidden(entry.alias, true); }
            }, busy === "hide:" + entry.alias ? "隐藏中…" : "隐藏"));
          }
          return h("div", { key: "m-" + entry.alias, style: S.hostRow }, row);
        });
        children.push(h("div", { key: "managed", style: S.section },
          [h("div", { key: "t", style: S.sectionHead }, [
            h("span", { style: S.sectionTitle }, "已配置主机 / managed hosts"),
            h("button", {
              key: "addhost", style: S.dockButton, disabled: busy !== "",
              onClick: toggleForm
            }, form === null ? "+ 手动添加主机" : "收起表单")
          ])].concat(managedRows)));

        // The first-run path: a host can be defined here, without the CLI.
        if (form !== null) {
          children.push(h("div", { key: "form", style: S.section }, [
            h("div", { key: "t", style: S.sectionTitle }, "手动添加主机 / add a host"),
            formRow("alias", "别名", "lab"),
            formRow("host", "主机", "192.0.2.10"),
            formRow("port", "端口", "22"),
            formRow("user", "用户", "留空 = ssh 默认"),
            formRow("workspace", "workspace", "留空 = 远端 home"),
            formError !== null ? h("div", { key: "e", style: S.error }, formError) : null,
            h("div", { key: "actions", style: S.row }, [
              h("button", { key: "ok", style: S.button, disabled: busy !== "", onClick: submitForm },
                busy === "form" ? "添加中…" : "添加"),
              h("button", { key: "cancel", style: S.button, disabled: busy !== "", onClick: toggleForm }, "取消")
            ])
          ]));
        }

        // ~/.ssh/known_hosts proves a connection happened; these become usable
        // once added, so the pane offers them with one click. The section is
        // always drawn and carries its own refresh: a host the user connects to
        // while this pane is open should be one click away from appearing here.
        if (Array.isArray(status.discovered)) {
          var shown = discovered.slice(0, 8);
          var foundRows = shown.map(function (candidate) {
            return h("div", { key: "d-" + candidate.alias, style: S.hostRow }, [
              h("span", { key: "n", style: S.mono }, candidate.alias + " · " + candidate.host + ":" + candidate.port),
              h("button", {
                key: "add", style: S.dockButton, disabled: busy !== "",
                onClick: function () { addHost(candidate); }
              }, busy === "add:" + candidate.alias ? "添加中…" : "添加"),
              h("button", {
                key: "ignore", style: S.dockButton, disabled: busy !== "",
                onClick: function () { setHidden(candidate.key, true); }
              }, busy === "hide:" + candidate.key ? "忽略中…" : "忽略")
            ]);
          });
          if (foundRows.length === 0) {
            foundRows = [h("div", { key: "none", style: S.muted }, "暂时没有新主机 —— 用 ssh 连过一次的机器会出现在这里")];
          }
          children.push(h("div", { key: "discovered", style: S.section },
            [h("div", { key: "t", style: S.sectionHead }, [
              h("span", { style: S.sectionTitle }, "发现的主机 / discovered in ~/.ssh"),
              h("button", {
                key: "rescan", style: S.dockButton, disabled: busy !== "",
                onClick: function () { work("scan", callHost("status")); }
              }, busy === "scan" ? "刷新中…" : "刷新")
            ])].concat(foundRows)));
          if (discovered.length > shown.length) {
            children.push(h("div", { key: "more", style: S.muted },
              "还有 " + (discovered.length - shown.length) + " 台未显示"));
          }
        }
        // Anything hidden above is listed here, so hiding is always reversible
        // from the pane itself.
        if (hiddenKeys.length > 0) {
          var hiddenRows = hiddenKeys.map(function (key) {
            return h("div", { key: "h-" + key, style: S.hostRow }, [
              h("span", { key: "n", style: S.mono }, key),
              h("button", {
                key: "show", style: S.dockButton, disabled: busy !== "",
                onClick: function () { setHidden(key, false); }
              }, busy === "hide:" + key ? "恢复中…" : "恢复")
            ]);
          });
          children.push(h("div", { key: "hidden", style: S.section },
            [h("div", { key: "t", style: S.sectionTitle }, "已隐藏 / hidden in this pane")].concat(hiddenRows)));
        }
        if (status.discovery && status.discovery.hashed > 0) {
          children.push(h("div", { key: "hashed", style: S.muted },
            status.discovery.hashed + " 条 known_hosts 记录已哈希(HashKnownHosts),无法反解出主机名"));
        }
      }
      if (status !== null && hosts.length === 0) {
        children.push(h("div", { key: "guide", style: S.section }, [
          h("div", { key: "t", style: S.sectionTitle }, "还没有任何主机 —— 三步开始 / no host yet"),
          h("div", { key: "s1", style: S.guideLine }, "① 添加主机:点「+ 手动添加主机」填表,或从「发现的主机」一键添加"),
          h("div", { key: "s2", style: S.guideLine }, "② 启动隧道 / up:在本机开一条到服务器的 SSH 隧道"),
          h("div", { key: "s3", style: S.guideLine }, "③ 在侧栏打开:远端 dsh web 就出现在这个面板里"),
          h("div", { key: "pre", style: S.muted },
            "前提:本机 ssh <别名> 能登录;远端要装好 dsh(命令行:dsh --profile remote bootstrap <别名>)")
        ]));
      }
      if (error !== null) children.push(h("div", { key: "error", style: S.error }, error));
      return h("div", { style: S.card }, children);
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

        /**
         * Put a tunnel into the sidebar, for a caller *inside* the sidebar.
         *
         * The tab domain's own action is the documented door from within a page
         * (the guide uses it: `tab.actions.openTab`); the root service's openTab
         * is the outside opener the card and the dock call. Both are reached
         * here, in the plugin context, and the pane gets this function through
         * the seam above.
         */
        openTabFromPane = function (state, tabActions) {
          if (tabActions !== undefined && typeof tabActions.openTab === "function") {
            try {
              tabActions.openTab("browser", { params: { url: state.authUrl } });
              report("open-panel", "tab.actions");
              return;
            } catch (error) {
              report("open-panel-fallback", textOf(error));
            }
          }
          var service = sidebar();
          if (service === undefined || service === null || typeof service.openTab !== "function") {
            throw new Error("the sidebarRight service is unavailable (no Browser panel here)");
          }
          service.openTab("browser", { params: { url: state.authUrl } });
          report("open-panel", "sidebarRight");
        };

        async function openPanel(host) {
          var service = sidebar();
          if (service === undefined || service === null || typeof service.openTab !== "function") {
            throw new Error("the sidebarRight service is unavailable (no Browser panel here)");
          }
          var state = await callHost("open?mode=panel" + hostQuery(host));
          service.openTab("browser", { params: { url: state.authUrl } });
          return state;
        }

        function Card(props) {
          var node = props && props.node ? props.node : {};
          var outcome = node.outcome || null;
          var tunnelState = useTunnelStatus();
          var status = tunnelState.status;
          var refresh = tunnelState.refresh;
          var busyState = React.useState("");
          var errorState = React.useState(null);
          var confirmState = React.useState(false);
          var pickState = React.useState(null);
          var busy = busyState[0], setBusy = busyState[1];
          var error = errorState[0], setError = errorState[1];
          var confirming = confirmState[0], setConfirming = confirmState[1];
          var picked = pickState[0], setPicked = pickState[1];
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
                return h("option", { key: item.alias, value: item.alias, style: S.option }, item.alias + " · " + item.host + ":" + item.port);
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

        /**
         * The strip above the composer.
         *
         * It exists because the chat transcript — and therefore the /remote card
         * — is not rendered at all until the session has model history, so a
         * fresh conversation would otherwise give no sign that the tunnel is
         * reachable, and a card buried in history is hard to find again.
         */
        function Dock() {
          var tunnelState = useTunnelStatus();
          var status = tunnelState.status;
          var refresh = tunnelState.refresh;
          var busyState = React.useState("");
          var errorState = React.useState(null);
          var busy = busyState[0], setBusy = busyState[1];
          var error = errorState[0], setError = errorState[1];

          if (status === null) return null;
          if (status.config && status.config.dock === false) return null;

          var current = status.tunnels && status.tunnels.length > 0 ? status.tunnels[0] : null;
          var alias = current !== null
            ? current.alias
            : (status.hosts && status.hosts.length > 0 ? status.hosts[0].alias : undefined);

          function run(mode, promise) {
            setBusy(mode);
            setError(null);
            promise.then(function () { setBusy(""); refresh(); },
              function (failure) { setBusy(""); setError(textOf(failure)); });
          }

          var children = [
            h("span", { key: "label", style: S.dockLabel },
              h("span", { style: Object.assign({}, S.dot, { background: current !== null ? TONE.ok : TONE.running }) }),
              "远程隧道 / remote tunnel"),
            h("span", { key: "state", style: S.muted },
              current !== null
                ? current.alias + " · " + current.url
                : (alias === undefined ? "未配置主机 / no host" : "未连接 / not connected"))
          ];

          if (current !== null) {
            children.push(h("button", {
              key: "panel", style: S.dockButton, disabled: busy !== "",
              onClick: function () { run("panel", openPanel(alias)); }
            }, busy === "panel" ? "打开中…" : "在侧栏打开"));
            children.push(h("button", {
              key: "browser", style: S.dockButton, disabled: busy !== "",
              onClick: function () { run("browser", callHost("open?mode=browser" + hostQuery(alias))); }
            }, busy === "browser" ? "打开中…" : "在浏览器打开"));
            children.push(h("button", {
              key: "down", style: S.dockButton, disabled: busy !== "",
              onClick: function () { run("down", callHost("down?host=" + encodeURIComponent(alias))); }
            }, busy === "down" ? "断开中…" : "断开"));
          } else if (alias !== undefined) {
            children.push(h("button", {
              key: "up", style: S.dockButton, disabled: busy !== "",
              onClick: function () { run("up", callHost("up?host=" + encodeURIComponent(alias))); }
            }, busy === "up" ? "连接中…" : "启动隧道 / up"));
          }
          if (error !== null) children.push(h("span", { key: "error", style: S.error }, error));
          return h("div", { style: S.dock }, children);
        }

        globalThis.__dshRemoteTunnel = { openPanel: openPanel, callHost: callHost, report: report };

        report("loaded");

        whenService(ctx, "sidebarRight", function (service) {
          sidebarService = service;
          report("service", "sidebarRight");
        });

        // The right sidebar's tab type. `register` throws on a duplicate id, so
        // the disposer must be owned by this plugin's own context: that is what
        // ctx.effect is for, and it is also how the shipped types do it.
        whenService(ctx, "sidebarRightTabs", function (tabs) {
          try {
            var registerType = function () { return tabs.register(hostsDefinition()); };
            if (typeof ctx.effect === "function") ctx.effect(registerType, "dsh-remote-tunnel: remote-hosts tab type");
            else registerType();
            // Reported after the call, so the event means the type is really in
            // the registry — not merely that we asked for it.
            report("tab-type", TAB_KIND);
          } catch (error) {
            report("error", "tab-type: " + textOf(error));
          }
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
            slots.inject(DOCK, function () {
              var disposer = slots.register({ name: DOCK, id: "remote-tunnel", order: 10 }, Dock);
              report("dock", DOCK + "#remote-tunnel");
              return disposer;
            });
            // The body of the tab type registered above: the framework injects
            // useTabInfo() into its props and forwards navigation.params.
            slots.inject(TAB_PANE, function () {
              var disposer = slots.register({ name: TAB_PANE, key: TAB_ID }, HostsPanel);
              report("pane", TAB_PANE + "#" + TAB_ID);
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
