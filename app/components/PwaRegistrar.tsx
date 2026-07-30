"use client";

import { useEffect } from "react";

const PWA_STATUS_EVENT = "mrroom:pwa-status";

function dispatchStatus(
  detail:
    | { state: "ready"; registration: ServiceWorkerRegistration }
    | { state: "error"; message: string },
) {
  window.dispatchEvent(new CustomEvent(PWA_STATUS_EVENT, { detail }));
}

export function PwaRegistrar() {
  useEffect(() => {
    if (
      !window.isSecureContext ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }

    let disposed = false;

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        if (disposed) return;
        dispatchStatus({ state: "ready", registration });
        void registration.update().catch(() => undefined);
      } catch (error) {
        if (disposed) return;
        dispatchStatus({
          state: "error",
          message: error instanceof Error ? error.message : "service_worker_registration_failed",
        });
      }
    };

    void register();

    return () => {
      disposed = true;
    };
  }, []);

  return null;
}
