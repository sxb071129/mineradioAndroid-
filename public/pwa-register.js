(function registerMrRoomPwa() {
  "use strict";

  if (!window.isSecureContext || !("serviceWorker" in navigator)) return;

  navigator.serviceWorker
    .register("/sw.js", { scope: "/", updateViaCache: "none" })
    .then(function (registration) {
      window.dispatchEvent(new CustomEvent("mrroom:pwa-status", {
        detail: { state: "ready", registration: registration },
      }));
      registration.update().catch(function () {
        // Registration remains usable when an opportunistic update check fails.
      });
    })
    .catch(function (error) {
      window.dispatchEvent(new CustomEvent("mrroom:pwa-status", {
        detail: {
          state: "error",
          message: error && error.message
            ? error.message
            : "service_worker_registration_failed",
        },
      }));
    });
})();
