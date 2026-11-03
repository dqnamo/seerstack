// The browser script served at /s.js. No cookies or storage: the server
// derives a daily-rotating visitor ID from the request.
//
//   <script defer src="https://seerstack.com/s.js" data-key="pk_…"></script>
//   window.seerstack.track("signup", { plan: "pro" });
//   window.seerstack.identify(user.id, { email: user.email });
//
// Pageviews are sent on load and on SPA navigations (pushState/popstate).
// Add data-allow-localhost to track while developing. Set
// localStorage.seerstack_ignore = "1" to exclude your own browser.

export const TRACKER_JS = `(function () {
  var script = document.currentScript;
  if (!script || window.seerstack) return;
  var key = script.getAttribute("data-key");
  var endpoint = new URL("/e", script.src).href;
  var allowLocal = script.hasAttribute("data-allow-localhost");
  var userId = "";
  var lastUrl = "";

  function ignored() {
    if (!key || navigator.webdriver || location.protocol === "file:") return true;
    if (!allowLocal && /^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname)) return true;
    try { return localStorage.getItem("seerstack_ignore") === "1"; } catch (e) { return false; }
  }

  function send(event, properties, referrer) {
    if (ignored()) return;
    var body = JSON.stringify({
      key: key,
      event: event,
      properties: properties || {},
      url: location.href,
      referrer: referrer === undefined ? document.referrer : referrer,
      user_id: userId || undefined,
      lib: "seerstack-web"
    });
    // A string body is sent as text/plain, so there is no CORS preflight.
    if (navigator.sendBeacon && navigator.sendBeacon(endpoint, body)) return;
    fetch(endpoint, { method: "POST", body: body, keepalive: true }).catch(function () {});
  }

  function pageview() {
    var url = location.origin + location.pathname;
    if (url === lastUrl) return;
    // After the first view, the referrer is the previous page, so SPA
    // navigations don't re-count the original external referrer.
    var referrer = lastUrl || document.referrer;
    lastUrl = url;
    send("$pageview", {}, referrer);
  }

  var pushState = history.pushState;
  history.pushState = function () {
    pushState.apply(this, arguments);
    pageview();
  };
  window.addEventListener("popstate", pageview);

  window.seerstack = {
    track: function (event, properties) { send(String(event), properties); },
    identify: function (id, traits) {
      userId = String(id);
      send("$identify", traits);
    }
  };

  pageview();
})();
`;
