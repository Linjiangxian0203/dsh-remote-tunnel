// dsh-remote-tunnel — browser half.
//
// Hand-written in the bundle format the client module system loads
// (window.__ModuleLoader__.load({ id, factory })), so the package needs no
// build step: npm, GitHub and local-directory installs ship this same file.
//
// The host half owns ssh and the tunnel; this half asks it for the
// authenticated URL and hands that to the right sidebar. It deliberately
// declares no `inject`: the service is resolved lazily, so the plugin always
// applies and can report what happened even when a service is missing.
window.__ModuleLoader__.load({
  id: "dsh-remote-tunnel",
  factory(require) {
    "use strict";
    var ROUTE = "/remote-tunnel/";

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

    return {
      name: "remote-tunnel",
      apply: function (ctx) {
        function sidebar() {
          var service;
          try {
            service = ctx.get ? ctx.get("sidebarRight") : undefined;
          } catch (error) {
            service = undefined;
          }
          return service || ctx.sidebarRight;
        }

        async function openPanel(host) {
          var service = sidebar();
          if (service === undefined || typeof service.openTab !== "function") {
            throw new Error("sidebarRight service is unavailable");
          }
          var state = await callHost("open" + (host ? "?host=" + encodeURIComponent(host) : ""));
          service.openTab("browser", { params: { url: state.authUrl } });
          return state;
        }

        globalThis.__dshRemoteTunnel = { openPanel: openPanel, callHost: callHost, report: report };

        report("loaded");

        // Ignition: prove a third-party bundle can drive the right sidebar.
        // Replaced by an explicit gesture + an openIn setting in the next step.
        if (globalThis.__dshRemoteTunnelIgnited !== true) {
          globalThis.__dshRemoteTunnelIgnited = true;
          (async function ignite() {
            var last;
            for (var attempt = 1; attempt <= 15; attempt += 1) {
              try {
                var state = await openPanel();
                report("opened", state && state.alias ? state.alias : "ok");
                return;
              } catch (error) {
                last = error;
                if (attempt === 1 || attempt % 5 === 0) {
                  report("retry", attempt + ": " + (error && error.message ? error.message : String(error)));
                }
                // At boot the sidebar store only exists once a Session is on
                // screen; the tunnel may also still be coming up.
                await new Promise(function (resolve) { setTimeout(resolve, 2000); });
              }
            }
            report("error", last && last.message ? last.message : String(last));
          })();
        }
      }
    };
  }
});
