window.__ModuleLoader__.load({
  id: "dsh-plugin-fleet-monitor",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var jsx = require("react/jsx-runtime");

    var NS = "fleet-monitor";
    var EXPECTED_HOST = "1.2.0";
    var DICT = {
      es: {
        tab: "Monitor en Vivo",
        title: "Monitor de Flota y Motores",
        desc: "Abre una terminal interactiva en el escritorio con el estado en vivo de todos tus proyectos y agentes, refrescándose cada segundo.",
        btn: "\uD83D\uDE80 Abrir Terminal en Vivo",
        refresh: "Actualizar estado",
        launching: "Lanzando terminal\u2026",
        opened: "\u00a1Terminal abierta con el escritorio!",
        terminal: "terminal",
        started: "lanzada",
        engine: "Motor actual",
        dshPid: "DSH pid",
        fleet: "Sesiones en disco",
        live: "activas ahora",
        monitors: "Monitores abiertos",
        desktop: "Escritorio",
        noDesktop: "sin sesi\u00f3n gr\u00e1fica detectable",
        hostVersion: "Host",
        clientVersion: "Cliente",
        staleHost: "El host cargado es antiguo. Reinicia dsh web para activar la v1.2 (la terminal sigue funcionando con lo que hay).",
        noHost: "No responden las rutas del plugin. Comprueba que dsh-plugin-fleet-monitor est\u00e1 montado en el perfil web.",
        error: "Error",
        keys: "Dentro del monitor: [p] PTC \u00b7 [s] Standard \u00b7 [t] Team \u00b7 [m] Minimal \u00b7 [c] Creator \u00b7 [f] filtro \u00b7 [q] salir",
        loading: "Consultando estado\u2026",
      },
      en: {
        tab: "Live Monitor",
        title: "Fleet & Mode Monitor",
        desc: "Opens an interactive desktop terminal with the live state of every project and agent, refreshing every second.",
        btn: "\uD83D\uDE80 Launch Live Terminal",
        refresh: "Refresh status",
        launching: "Launching terminal\u2026",
        opened: "Terminal opened on the desktop!",
        terminal: "terminal",
        started: "launched",
        engine: "Current engine",
        dshPid: "DSH pid",
        fleet: "Sessions on disk",
        live: "live now",
        monitors: "Open monitors",
        desktop: "Desktop",
        noDesktop: "no graphical session detected",
        hostVersion: "Host",
        clientVersion: "Client",
        staleHost: "The loaded host is stale. Restart dsh web to activate v1.2 (the terminal still works as is).",
        noHost: "The plugin routes are not answering. Check that dsh-plugin-fleet-monitor is mounted in the web profile.",
        error: "Error",
        keys: "Inside the monitor: [p] PTC \u00b7 [s] Standard \u00b7 [t] Team \u00b7 [m] Minimal \u00b7 [c] Creator \u00b7 [f] filter \u00b7 [q] quit",
        loading: "Reading status\u2026",
      },
    };

    var box = { border: "1px solid rgba(127,127,127,0.28)", borderRadius: "8px", padding: "12px 14px" };
    var dim = { opacity: 0.75, fontSize: "12px" };
    var label = { opacity: 0.65, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em" };

    function buttonStyle(primary) {
      return {
        padding: "8px 16px",
        cursor: "pointer",
        fontWeight: "bold",
        fontSize: "13px",
        borderRadius: "6px",
        border: primary ? "none" : "1px solid rgba(127,127,127,0.45)",
        background: primary ? "#3b82f6" : "transparent",
        color: primary ? "#fff" : "inherit",
        opacity: 1,
      };
    }

    function cell(t, key, value, accent) {
      return jsx.jsxs("div", {
        style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: "110px" },
        children: [
          jsx.jsx("span", { style: label, children: t(key) }),
          jsx.jsx("span", {
            style: { fontSize: "14px", fontWeight: "600", color: accent || "inherit" },
            children: value,
          }),
        ],
      });
    }

    function FleetMonitorTab(props) {
      var t = (props && props.t) || function (key) { return key; };
      var hostState = react.useState(null);
      var host = hostState[0];
      var setHost = hostState[1];
      var msgState = react.useState("");
      var msg = msgState[0];
      var setMsg = msgState[1];
      var toneState = react.useState("ok");
      var tone = toneState[0];
      var setTone = toneState[1];
      var busyState = react.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      var readStatus = react.useCallback(function () {
        return fetch("/__dsh_fleet/status", { method: "GET", cache: "no-store" })
          .then(function (res) { return res.json(); })
          .then(function (json) {
            setHost(json && json.ok !== false ? json : null);
            return json;
          })
          .catch(function () {
            setHost(null);
            return null;
          });
      }, []);

      react.useEffect(function () {
        readStatus();
        var timer = setInterval(readStatus, 5000);
        return function () { clearInterval(timer); };
      }, [readStatus]);

      var launch = react.useCallback(function () {
        setBusy(true);
        setMsg(t("launching"));
        setTone("ok");
        fetch("/__dsh_fleet/launch-terminal", { method: "POST", cache: "no-store" })
          .then(function (res) { return res.json(); })
          .then(function (json) {
            if (json && json.ok) {
              setMsg(t("opened") + "  \u00b7  " + t("terminal") + ": " + json.terminal + " (" + t("started") + " pid " + json.pid + ")");
              setTone("ok");
              readStatus();
            } else {
              setMsg(t("error") + ": " + ((json && json.error) || "?"));
              setTone("error");
            }
          })
          .catch(function (error) {
            setMsg(t("error") + ": " + String(error));
            setTone("error");
          })
          .then(function () { setBusy(false); });
      }, [t, readStatus]);

      var hostVersion = host && host.version ? host.version : null;
      var stale = host === null || hostVersion !== EXPECTED_HOST;
      var engine = (host && host.engine) || {};
      var fleet = (host && host.fleet) || {};
      var monitors = (host && host.monitors) || [];
      var desktop = host && host.desktop;
      var desktopText = desktop
        ? (desktop.display || desktop.wayland || "?") + " \u00b7 " + desktop.source
        : t("noDesktop");

      var engineBadge = jsx.jsxs("div", {
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "3px 10px",
          borderRadius: "999px",
          background: "rgba(59,130,246,0.15)",
          border: "1px solid rgba(59,130,246,0.5)",
          color: "#60a5fa",
          fontWeight: "700",
          fontSize: "12px",
          textTransform: "uppercase",
        },
        children: [
          jsx.jsx("span", { children: (engine.mode || "?").toUpperCase() }),
          engine.alive ? null : jsx.jsx("span", { style: { color: "#ef4444" }, children: "\u2717" }),
        ],
      });

      var statusBlock = host
        ? jsx.jsxs("div", {
            style: Object.assign({}, box, { display: "flex", flexWrap: "wrap", gap: "22px", marginTop: "4px" }),
            children: [
              jsx.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }, children: [
                jsx.jsx("span", { style: label, children: t("engine") }),
                engineBadge,
              ] }),
              cell(t, "dshPid", engine.pid ? String(engine.pid) : "-"),
              cell(t, "fleet", String(fleet.sessions || 0) + "  (" + String(fleet.live || 0) + " " + t("live") + ")"),
              cell(t, "monitors", String(monitors.length)),
              cell(t, "desktop", desktopText, desktop ? "#22c55e" : "#f59e0b"),
              cell(t, "hostVersion", hostVersion || "?"),
            ],
          })
        : null;

      var notice = stale
        ? jsx.jsx("div", {
            style: {
              marginTop: "10px",
              padding: "8px 10px",
              borderRadius: "6px",
              fontSize: "12px",
              background: "rgba(245,158,11,0.12)",
              border: "1px solid rgba(245,158,11,0.45)",
              color: "#fbbf24",
            },
            children: host === null ? t("noHost") : t("staleHost") + "  (" + t("hostVersion") + " v" + (hostVersion || "?") + " \u2192 v" + EXPECTED_HOST + ")",
          })
        : null;

      return jsx.jsxs("div", {
        style: { padding: "16px 0", display: "flex", flexDirection: "column", gap: "10px" },
        children: [
          jsx.jsx("h3", { style: { margin: 0, fontSize: "16px" }, children: t("title") }),
          jsx.jsx("div", { style: dim, children: t("desc") }),
          jsx.jsx("div", { style: { display: "flex", gap: "10px", alignItems: "center", marginTop: "6px", flexWrap: "wrap" }, children: [
            jsx.jsx("button", { onClick: launch, disabled: busy, style: buttonStyle(true), children: busy ? t("launching") : t("btn") }),
            jsx.jsx("button", { onClick: readStatus, disabled: busy, style: buttonStyle(false), children: t("refresh") }),
            jsx.jsx("span", { style: Object.assign({}, dim, { fontSize: "11px" }), children: "cliente v" + EXPECTED_HOST }),
          ] }),
          msg
            ? jsx.jsx("div", {
                style: {
                  fontSize: "13px",
                  fontWeight: "bold",
                  color: tone === "error" ? "#ef4444" : "#22c55e",
                },
                children: msg,
              })
            : null,
          notice,
          statusBlock,
          jsx.jsx("div", { style: Object.assign({}, dim, { fontSize: "11px", marginTop: "4px" }), children: t("keys") }),
        ],
      });
    }

    var inject = ["slots", "locale"];

    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, DICT); }, "fleet-monitor: diccionarios");
      ctx.slots.inject("settings.plugins.tab", function () {
        return ctx.slots.register({
          name: "settings.plugins.tab",
          id: "fleet-monitor",
          order: 40,
          label: function () { return t("tab"); },
          locale: NS,
          inject: function () { return { t: t }; },
        }, FleetMonitorTab);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.FleetMonitorTab = FleetMonitorTab;
    return module.exports;
  },
});
