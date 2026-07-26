"use client";

import { useCallback, useEffect, useState } from "react";

export type ServiceHealthStatus = "idle" | "checking" | "online" | "offline";

export type ServiceHealthSnapshot = {
  status: ServiceHealthStatus;
  latencyMs: number | null;
  message: string;
  details: string[];
  checkedAt: number;
};

type ServiceHealth = {
  musicApi: ServiceHealthSnapshot;
  relay: ServiceHealthSnapshot;
};

type Options = {
  enabled: boolean;
  musicApiBase: string;
  relayBase: string;
};

const IDLE_HEALTH: ServiceHealthSnapshot = {
  status: "idle",
  latencyMs: null,
  message: "尚未检查",
  details: [],
  checkedAt: 0,
};

function healthUrl(base: string) {
  try {
    const url = new URL(base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.pathname = "/health";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function offline(message: string): ServiceHealthSnapshot {
  return {
    status: "offline",
    latencyMs: null,
    message,
    details: [],
    checkedAt: Date.now(),
  };
}

async function probeService(
  base: string,
  kind: "musicApi" | "relay",
  signal: AbortSignal,
): Promise<ServiceHealthSnapshot> {
  const url = healthUrl(base);
  if (!url) return offline("服务地址无效");
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || payload?.ok !== true) {
      return offline(`健康检查失败（HTTP ${response.status}）`);
    }
    const details = kind === "relay"
      ? [
          `${Math.max(0, Number(payload.rooms) || 0)} 个房间`,
          `${Math.max(0, Number(payload.devices) || 0)} 台在线设备`,
        ]
      : [
          Array.isArray(payload.providers)
            ? `${payload.providers.map(String).join(" / ")} 音源`
            : "音乐接口已响应",
        ];
    return {
      status: "online",
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      message: kind === "relay" ? "局域网中继在线" : "第三方音乐接口在线",
      details,
      checkedAt: Date.now(),
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return offline(error instanceof TypeError ? "无法连接此服务" : "健康检查超时或失败");
  }
}

export function useServiceHealth({ enabled, musicApiBase, relayBase }: Options) {
  const [health, setHealth] = useState<ServiceHealth>({
    musicApi: IDLE_HEALTH,
    relay: IDLE_HEALTH,
  });
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = useCallback(() => setRefreshVersion((version) => version + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let checking = false;
    const controllers = new Set<AbortController>();

    const timedProbe = async (base: string, kind: "musicApi" | "relay") => {
      const controller = new AbortController();
      controllers.add(controller);
      const timeout = setTimeout(
        () => controller.abort(new DOMException("Service health timeout", "TimeoutError")),
        5000,
      );
      try {
        return await probeService(base, kind, controller.signal);
      } catch {
        return offline("健康检查超时");
      } finally {
        clearTimeout(timeout);
        controllers.delete(controller);
      }
    };

    const check = async (showChecking: boolean) => {
      if (checking) return;
      checking = true;
      if (showChecking) {
        setHealth((current) => ({
          musicApi: { ...current.musicApi, status: "checking", message: "正在检查…" },
          relay: { ...current.relay, status: "checking", message: "正在检查…" },
        }));
      }
      try {
        const [musicApi, relay] = await Promise.all([
          timedProbe(musicApiBase, "musicApi"),
          timedProbe(relayBase, "relay"),
        ]);
        if (!disposed) setHealth({ musicApi, relay });
      } finally {
        checking = false;
      }
    };

    void check(true);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void check(false);
    }, 10_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, [enabled, musicApiBase, refreshVersion, relayBase]);

  return { ...health, refresh };
}
