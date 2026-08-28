(function (w, d) {
  var KEY = "cashline_events";
  var script = d.currentScript || d.querySelector('script[src*="snippet.js"]');
  var srcQ = {};
  try { if (script && script.src) srcQ = new URL(script.src, w.location.href).searchParams; } catch (e) {}
  var pageQ = {};
  try { pageQ = new URL(w.location.href).searchParams; } catch (e) {}
  var sid = (srcQ.get && srcQ.get("sid")) || (script && script.getAttribute("data-sid")) || (pageQ.get && pageQ.get("sid")) || "demo";

  function vid() {
    var v = null;
    try { v = w.localStorage.getItem("cashline_vid"); } catch (e) {}
    if (!v) {
      v = "v_" + Math.random().toString(36).slice(2, 12);
      try { w.localStorage.setItem("cashline_vid", v); } catch (e) {}
    }
    return v;
  }
  function load() {
    try { return JSON.parse(w.localStorage.getItem(KEY) || "[]"); } catch (e) { return []; }
  }
  function save(evs) {
    if (evs.length > 2000) evs = evs.slice(-2000);
    try { w.localStorage.setItem(KEY, JSON.stringify(evs)); } catch (e) {}
  }
  function emit(type, extra) {
    extra = extra || {};
    var ev = {
      t: type,
      ts: Date.now(),
      sid: sid,
      vid: vid(),
      path: w.location.pathname + (w.location.search || ""),
      ref: d.referrer || "",
      example: false
    };
    if (extra.amount != null && extra.amount !== "") ev.amount = +extra.amount;
    if (extra.currency) ev.currency = String(extra.currency);
    var evs = load();
    evs.push(ev);
    save(evs);
    try {
      if (w.fetch) {
        w.fetch("/cashline/collect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(ev),
          keepalive: true
        }).catch(function () {});
      }
    } catch (e) {}
    return ev;
  }
  function cashline(cmd, payload) {
    if (cmd === "pageview") return emit("pageview", payload);
    if (cmd === "purchase") return emit("purchase", payload || {});
  }
  w.cashline = cashline;
  cashline("pageview");
})(window, document);
