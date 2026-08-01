"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createClockSample,
  targetRoomPosition,
  updateClockEstimate,
  type ClockEstimate,
  type ClockSample,
} from "../lib/room-sync-timing.mjs";
import {
  ROOM_SYNC_PROTOCOL_VERSION,
  type RoomCommand,
  type RoomJoinMessage,
  type RoomState,
  type SyncStatus,
} from "../lib/sync-types";

function asWebSocketUrl(value: string) {
  const input = value.trim();
  if (!input) return "";
  try {
    const url = new URL(input);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    if (!url.pathname || url.pathname === "/") url.pathname = "/ws";
    return url.toString();
  } catch {
    return "";
  }
}

function toHttpBase(value: string) {
  try {
    const url = new URL(asWebSocketUrl(value));
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

type Options = {
  enabled: boolean;
  roomCode: string;
  relayUrl: string;
  deviceName: string;
};

function syncErrorMessage(code: string) {
  const messages: Record<string, string> = {
    buffer_contract_required: "设备没有上报完整缓冲数据，已暂停本轮同步启动",
    buffer_not_ready: "设备缓冲尚未达到同步启动要求，正在重新等待",
    command_failed: "同步命令执行失败，请稍后重试",
    device_not_found: "目标设备已离开房间，请刷新设备列表后重试",
    invalid_calibration: "设备校准参数无效，请将音量微调设为 -24 至 +12 dB、延迟设为 0 至 500 ms",
    invalid_command: "中继无法识别此同步操作，请更新主机 LAN 服务",
    invalid_json: "同步数据格式错误，请刷新页面后重试",
    invalid_room: "房间码无效，请使用 4–8 位字母或数字",
    invalid_track: "这首歌曲无法通过局域网中继播放",
    leader_only: "只有房间主控可以执行此操作",
    not_joined: "设备尚未加入房间，正在重新连接",
    quality_unavailable: "当前歌曲或账号暂不支持所选音质",
    rate_limited: "操作过快，请稍后再试",
    room_full: "房间已达到 64 台设备上限",
    strict_sync_required: "当前设备未启用严格同步协议，请刷新播放器后重试",
  };
  return messages[code] || `同步服务返回错误：${code}`;
}

export function useRoomSync({ enabled, roomCode, relayUrl, deviceName }: Options) {
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [state, setState] = useState<RoomState | null>(null);
  const [clientId, setClientId] = useState("");
  const [isLeader, setIsLeader] = useState(false);
  const [latency, setLatency] = useState(0);
  const [clockQuality, setClockQuality] = useState({ ready: false, jitterMs: 0 });
  const [addresses, setAddresses] = useState<string[]>([]);
  const [error, setError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const clientIdRef = useRef("");
  const offsetRef = useRef(0);
  const clockSamplesRef = useRef<ClockSample[]>([]);
  const clockEstimateRef = useRef<ClockEstimate>({
    samples: [],
    offsetMs: 0,
    latencyMs: 0,
    jitterMs: 0,
    initialized: false,
  });
  const wsUrl = useMemo(() => asWebSocketUrl(relayUrl), [relayUrl]);
  const httpBase = useMemo(() => toHttpBase(relayUrl), [relayUrl]);

  useEffect(() => {
    let disposed = false;
    const resetClockEstimate = () => {
      clockSamplesRef.current = [];
      clockEstimateRef.current = {
        samples: [],
        offsetMs: 0,
        latencyMs: 0,
        jitterMs: 0,
        initialized: false,
      };
      offsetRef.current = 0;
      setLatency(0);
      setClockQuality({ ready: false, jitterMs: 0 });
    };
    // Reset connection-derived React state at an asynchronous boundary. This
    // keeps the effect itself focused on wiring the WebSocket lifecycle and
    // avoids a synchronous cascade when connection inputs change together.
    queueMicrotask(() => {
      if (disposed) return;
      resetClockEstimate();
      setState(null);
      setIsLeader(false);
      setClientId("");
    });
    if (!enabled || !roomCode || !wsUrl) {
      return () => {
        disposed = true;
      };
    }

    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let attempt = 0;
    let hiddenAt = document.visibilityState === "hidden" ? Date.now() : 0;

    function connect() {
      if (disposed) return;
      setStatus(attempt ? "reconnecting" : "connecting");
      setError("");
      const socket = new WebSocket(wsUrl);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        attempt = 0;
        setStatus("connected");
        resetClockEstimate();
        const ping = () => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "ping", clientTime: Date.now() }));
          }
        };
        ping();
        const joinMessage: RoomJoinMessage = {
          type: "join",
          room: roomCode,
          name: deviceName,
          protocolVersion: ROOM_SYNC_PROTOCOL_VERSION,
          capabilities: {
            bufferContract: true,
            armedPlayback: true,
          },
        };
        socket.send(JSON.stringify(joinMessage));
        pingTimer = setInterval(ping, 2500);
      });

      socket.addEventListener("message", (event) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.type === "welcome") {
          const id = String(message.clientId || "");
          clientIdRef.current = id;
          setClientId(id);
          setAddresses(Array.isArray(message.addresses) ? message.addresses.map(String) : []);
          const serverTime = Number(message.serverTime);
          if (!clockEstimateRef.current.initialized && Number.isFinite(serverTime)) {
            offsetRef.current = serverTime - Date.now();
          }
          return;
        }
        if (message.type === "joined") {
          const id = String(message.clientId || clientIdRef.current);
          clientIdRef.current = id;
          setClientId(id);
          setIsLeader(Boolean(message.leader));
          if (message.state) setState(message.state as RoomState);
          return;
        }
        if (message.type === "state" && message.state) {
          const next = message.state as RoomState;
          setState(next);
          setIsLeader(next.leaderId === clientIdRef.current);
          return;
        }
        if (message.type === "pong") {
          const receivedAt = Date.now();
          const sentAt = Number(message.clientTime) || receivedAt;
          const serverSentAt = Number(message.serverTime) || receivedAt;
          const serverReceivedAt = Number(message.serverReceivedAt) || serverSentAt;
          const sample = createClockSample(sentAt, receivedAt, serverReceivedAt, serverSentAt);
          const estimate = updateClockEstimate(
            clockSamplesRef.current,
            sample,
            clockEstimateRef.current,
          );
          clockSamplesRef.current = estimate.samples;
          clockEstimateRef.current = estimate;
          offsetRef.current = estimate.offsetMs;
          setLatency(Math.round(estimate.latencyMs));
          setClockQuality({ ready: estimate.initialized, jitterMs: estimate.jitterMs });
          return;
        }
        if (message.type === "error") {
          const code = String(message.code || "unknown_error");
          setError(syncErrorMessage(code));
        }
      });

      socket.addEventListener("close", () => {
        if (pingTimer) clearInterval(pingTimer);
        if (disposed) return;
        resetClockEstimate();
        attempt += 1;
        setStatus("reconnecting");
        const delay = Math.min(8000, 500 * 2 ** Math.min(attempt - 1, 4));
        reconnectTimer = setTimeout(connect, delay + Math.random() * 220);
      });

      socket.addEventListener("error", () => {
        setError("无法连接局域网中继，请确认主机已运行 LAN 模式");
        setStatus("error");
      });
    }

    connect();
    const resync = (event: Event) => {
      if (event.type === "visibilitychange") {
        if (document.visibilityState === "hidden") {
          hiddenAt = Date.now();
          return;
        }
        if (hiddenAt && Date.now() - hiddenAt >= 10_000) resetClockEstimate();
        hiddenAt = 0;
      } else {
        resetClockEstimate();
      }
      if (document.visibilityState === "visible" && socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "ping", clientTime: Date.now() }));
      }
    };
    const onOffline = () => {
      resetClockEstimate();
      setStatus("reconnecting");
      socketRef.current?.close(4001, "network_offline");
    };
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("online", resync);
    window.addEventListener("offline", onOffline);

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("online", resync);
      window.removeEventListener("offline", onOffline);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [deviceName, enabled, roomCode, wsUrl]);

  const sendCommand = useCallback((command: RoomCommand) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    const payload = command.action === "progress"
      ? { ...command, sampledServerTime: Date.now() + offsetRef.current }
      : command;
    socket.send(JSON.stringify({ type: "command", ...payload }));
    return true;
  }, []);

  const targetPosition = useCallback((roomState: RoomState) => {
    return targetRoomPosition(roomState, Date.now(), offsetRef.current);
  }, []);
  const serverNow = useCallback(() => Date.now() + offsetRef.current, []);

  const publicStatus: SyncStatus = !enabled ? "idle" : !wsUrl ? "error" : status;
  const publicError = !enabled ? "" : !wsUrl ? "中继地址无效" : error;

  return {
    status: publicStatus,
    state,
    clientId,
    isLeader,
    latency,
    clockReady: clockQuality.ready,
    clockJitter: clockQuality.jitterMs,
    addresses,
    error: publicError,
    httpBase,
    sendCommand,
    targetPosition,
    serverNow,
  };
}
