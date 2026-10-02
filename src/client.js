// dsh-remote-tunnel — browser half.
//
// Hand-written in the bundle format the client module system loads
// (window.__ModuleLoader__.load({ id, factory })), so the package needs no
// build step: npm, GitHub and local-directory installs ship this same file.
//
// The host half owns ssh and the tunnel; this half only asks it for the
// authenticated URL and hands that to the right sidebar.
window.__ModuleLoader__.load({
  id: "dsh-remote-tunnel",
  factory(require) {
    "use strict";
    var ROUTE = "/remote-tunnel/";

    async function callHost(action) {
      const response = await fetch(ROUTE + action, { headers: { accept: "application/json" } });
      let body = {};
      try {
        body = await response.json();
      } catch (error) {
        body = {};
      }
      if (!response.ok) throw new Error(body.error || "remote-tunnel: HTTP " + response.status);
      return body;
    }

    return {
      inject: ["sidebarRight"],
      apply(ctx) {
        /** Open the remote dsh web inside the right sidebar. */
        async function openPanel(host) {
          const state = await callHost("open" + (host ? "?host=" + encodeURIComponent(host) : ""));
          ctx.sidebarRight.openTab("browser", { params: { url: state.authUrl } });
          return state;
        }

        // Handy from the console while the UI is still being built.
        globalThis.__dshRemoteTunnel = { openPanel: openPanel, callHost: callHost };

        // Ignition: prove a third-party bundle can open the panel. Replaced by
        // an explicit gesture + openIn config in the next step.
        if (globalThis.__dshRemoteTunnelIgnited !== true) {
          globalThis.__dshRemoteTunnelIgnited = true;
          (async function ignite() {
            let last;
            for (let attempt = 1; attempt <= 10; attempt += 1) {
              try {
                await openPanel();
                return;
              } catch (error) {
                last = error;
                // At boot the sidebar store only exists once a Session is on
                // screen; the tunnel may also still be coming up.
                await new Promise(function (resolve) { setTimeout(resolve, 2000); });
              }
            }
            console.warn("[remote-tunnel] panel ignition gave up:", last && last.message ? last.message : last);
          })();
        }
      }
    };
  }
});
