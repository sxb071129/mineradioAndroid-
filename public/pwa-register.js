(function registerMrRoomPwa() {
  "use strict";

  if (!window.isSecureContext || !("serviceWorker" in navigator)) return;

  var UPDATE_MESSAGE = "MRROOM_ACTIVATE_UPDATE";
  var RELOAD_GUARD_KEY = "mrroom-pwa-version-reload-v1";
  var hadController = Boolean(navigator.serviceWorker.controller);
  var reloading = false;
  var activationTimer = 0;

  function playbackIsBusy() {
    var media = window.audio;
    if (media && media.paused === false && media.ended !== true) return true;
    var sync = window.MineradioWebBridge && window.MineradioWebBridge.sync;
    return Boolean(sync && sync.connected && sync.preparing);
  }

  function recentVersionReload() {
    try {
      return Date.now() - Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0) < 30000;
    } catch {
      return false;
    }
  }

  function rememberVersionReload() {
    try { sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now())); } catch {}
  }

  function requestIdleActivation(registration) {
    if (activationTimer) {
      clearTimeout(activationTimer);
      activationTimer = 0;
    }
    var worker = registration && registration.waiting;
    if (!worker) return;
    if (playbackIsBusy()) {
      activationTimer = setTimeout(function () {
        requestIdleActivation(registration);
      }, 1500);
      return;
    }
    worker.postMessage({ type: UPDATE_MESSAGE });
  }

  function watchRegistration(registration) {
    requestIdleActivation(registration);
    function watchInstalling(installing) {
      if (!installing) return;
      function activateInstalledUpdate() {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          requestIdleActivation(registration);
        }
      }
      activateInstalledUpdate();
      installing.addEventListener("statechange", activateInstalledUpdate);
    }
    watchInstalling(registration.installing);
    registration.addEventListener("updatefound", function () {
      watchInstalling(registration.installing);
    });
  }

  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (!hadController || reloading || recentVersionReload()) return;
    reloading = true;
    rememberVersionReload();
    window.location.reload();
  });

  navigator.serviceWorker
    .register("/sw.js", { scope: "/", updateViaCache: "none" })
    .then(function (registration) {
      window.dispatchEvent(new CustomEvent("mrroom:pwa-status", {
        detail: { state: "ready", registration: registration },
      }));
      watchRegistration(registration);
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
