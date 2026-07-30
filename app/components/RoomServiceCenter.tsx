"use client";

import { useEffect, useRef, useState } from "react";
import type { PlaybackQuality, RoomDeviceState, RoomState, SyncStatus } from "../lib/sync-types";
import type { ServiceHealthSnapshot } from "../hooks/use-service-health";

type Props = {
  clientId: string;
  clockReady: boolean;
  localJitterMs: number;
  localLatencyMs: number;
  musicApiBase: string;
  musicApiHealth: ServiceHealthSnapshot;
  relayBase: string;
  relayHealth: ServiceHealthSnapshot;
  roomCode: string;
  roomError: string;
  roomIsLeader: boolean;
  roomState: RoomState | null;
  roomStatus: SyncStatus;
  onCalibrateDevice: (clientId: string, calibration: { volumeTrimDb: number; delayMs: number }) => void;
  onRefresh: () => void;
};

const QUALITY_LABELS: Record<PlaybackQuality, string> = {
  jymaster: "蝰蛇母带",
  hires: "Hi-Res",
  lossless: "无损",
  exhigh: "超高",
  standard: "标准",
};

function endpointLabel(value: string) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return value || "未配置";
  }
}

function healthTone(status: ServiceHealthSnapshot["status"]) {
  if (status === "online") return "is-online";
  if (status === "offline") return "is-offline";
  return "is-checking";
}

function bufferStateLabel(device: RoomDeviceState) {
  if (device.ready || device.bufferState === "ready") return "已就绪";
  if (device.bufferState === "unlock_required") return "需要点按播放授权";
  if (device.bufferState === "stalled") return "数据传输停滞";
  if (device.bufferState === "error") return "音频加载失败";
  if (device.bufferState === "buffering") return "正在补充缓冲";
  return device.participant ? "正在接收音频" : "已连接";
}

function formatMetric(value: number, suffix: string, digits = 0) {
  if (!Number.isFinite(value)) return "—";
  return `${Math.abs(value) < 0.05 ? 0 : value.toFixed(digits)}${suffix}`;
}

function DeviceRow({
  clientId,
  device,
  onCalibrate,
  roomIsLeader,
}: {
  clientId: string;
  device: RoomDeviceState;
  onCalibrate: Props["onCalibrateDevice"];
  roomIsLeader: boolean;
}) {
  const progress = Math.max(0, Math.min(1, Number(device.bufferProgress) || 0));
  const quality = device.quality ? QUALITY_LABELS[device.quality] : "跟随房间";
  const ready = device.ready || device.prepared || device.bufferState === "ready";
  const [volumeTrimDb, setVolumeTrimDb] = useState(device.volumeTrimDb || 0);
  const [delayMs, setDelayMs] = useState(device.delayMs || 0);
  const calibrationRef = useRef({
    volumeTrimDb: device.volumeTrimDb || 0,
    delayMs: device.delayMs || 0,
  });
  const calibrationCommitTimerRef = useRef<number | null>(null);
  const commitCalibration = () => {
    if (calibrationCommitTimerRef.current != null) {
      window.clearTimeout(calibrationCommitTimerRef.current);
      calibrationCommitTimerRef.current = null;
    }
    onCalibrate(device.clientId, { ...calibrationRef.current });
  };
  const scheduleCalibration = () => {
    if (calibrationCommitTimerRef.current != null) window.clearTimeout(calibrationCommitTimerRef.current);
    calibrationCommitTimerRef.current = window.setTimeout(() => {
      calibrationCommitTimerRef.current = null;
      onCalibrate(device.clientId, { ...calibrationRef.current });
    }, 90);
  };
  useEffect(() => () => {
    if (calibrationCommitTimerRef.current != null) window.clearTimeout(calibrationCommitTimerRef.current);
  }, []);
  return (
    <li className={`device-diagnostic ${ready ? "is-ready" : ""} ${device.blocked ? "is-blocked" : ""}`}>
      <div className="device-diagnostic-heading">
        <span className={`service-dot ${ready ? "is-online" : device.blocked ? "is-offline" : "is-checking"}`} aria-hidden="true" />
        <strong>{device.name || "未命名设备"}</strong>
        <span className="device-badges">
          {device.clientId === clientId ? <em>本机</em> : null}
          {device.leader ? <em>主控</em> : null}
        </span>
      </div>
      <div className="device-buffer-copy">
        <span>{bufferStateLabel(device)}</span>
        <span>
          {formatMetric(device.bufferedSeconds, "s", 1)}
          {device.bufferGoalSeconds > 0 ? ` / ${formatMetric(device.bufferGoalSeconds, "s", 1)}` : ""}
        </span>
      </div>
      <progress
        className="device-buffer-progress"
        max="1"
        value={progress}
        aria-label={`${device.name || "设备"}缓冲进度 ${Math.round(progress * 100)}%`}
      />
      <dl className="device-metrics">
        <div><dt>延迟</dt><dd>{formatMetric(device.latencyMs, " ms")}</dd></div>
        <div><dt>抖动</dt><dd>{formatMetric(device.jitterMs, " ms")}</dd></div>
        <div><dt>漂移</dt><dd>{formatMetric(device.driftMs, " ms")}</dd></div>
        <div><dt>音质</dt><dd>{quality}</dd></div>
      </dl>
      <div className="device-calibration-summary">
        <span>输出校准</span>
        <strong>{volumeTrimDb >= 0 ? "+" : ""}{volumeTrimDb.toFixed(1)} dB · {Math.round(delayMs)} ms</strong>
      </div>
      {roomIsLeader ? (
        <div className="device-calibration-controls">
          <label>
            <span>音量微调</span>
            <input
              type="range"
              min="-24"
              max="12"
              step="0.5"
              value={volumeTrimDb}
              onChange={(event) => {
                const next = Number(event.target.value);
                calibrationRef.current.volumeTrimDb = next;
                setVolumeTrimDb(next);
                scheduleCalibration();
              }}
              onPointerUp={commitCalibration}
              onKeyUp={commitCalibration}
              onBlur={commitCalibration}
              aria-label={`${device.name}音量微调`}
            />
          </label>
          <label>
            <span>延迟补偿</span>
            <input
              type="range"
              min="0"
              max="500"
              step="5"
              value={delayMs}
              onChange={(event) => {
                const next = Number(event.target.value);
                calibrationRef.current.delayMs = next;
                setDelayMs(next);
                scheduleCalibration();
              }}
              onPointerUp={commitCalibration}
              onKeyUp={commitCalibration}
              onBlur={commitCalibration}
              aria-label={`${device.name}延迟补偿`}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              calibrationRef.current = { volumeTrimDb: 0, delayMs: 0 };
              setVolumeTrimDb(0);
              setDelayMs(0);
              onCalibrate(device.clientId, { volumeTrimDb: 0, delayMs: 0 });
            }}
          >重置</button>
        </div>
      ) : null}
    </li>
  );
}

export function RoomServiceCenter({
  clientId,
  clockReady,
  localJitterMs,
  localLatencyMs,
  musicApiBase,
  musicApiHealth,
  relayBase,
  relayHealth,
  roomCode,
  roomError,
  roomIsLeader,
  roomState,
  roomStatus,
  onCalibrateDevice,
  onRefresh,
}: Props) {
  const devices = roomState?.devices || [];
  const waitingDevices = devices.filter((device) => device.participant && !device.ready);
  const failedIds = new Set(roomState?.prepareErrorClientIds || []);
  const failedDevices = devices.filter((device) => device.blocked || failedIds.has(device.clientId));
  const roomOnline = roomStatus === "connected";
  const roomMessage = roomOnline
    ? roomState?.preparing
      ? `缓冲屏障 ${roomState.readyCount}/${Math.max(1, roomState.requiredCount)}`
      : roomState?.prepareError
        ? "同步启动未完成"
        : "房间时间线已连接"
    : roomStatus === "reconnecting"
      ? "连接中断，正在自动重连"
      : roomStatus === "connecting"
        ? "正在加入同步房间"
        : "房间尚未连接";

  return (
    <section className="room-service-center" aria-labelledby="service-center-title">
      <div className="service-center-heading">
        <div>
          <span>SERVICE &amp; DEVICES</span>
          <h3 id="service-center-title">服务与设备中心</h3>
        </div>
        <button type="button" onClick={onRefresh}>重新检查</button>
      </div>

      <div className="service-health-grid">
        <article className={`service-health-card ${healthTone(musicApiHealth.status)}`}>
          <div><span className={`service-dot ${healthTone(musicApiHealth.status)}`} aria-hidden="true" /><strong>Music API</strong></div>
          <p>{musicApiHealth.message}</p>
          <small>{endpointLabel(musicApiBase)}{musicApiHealth.latencyMs == null ? "" : ` · ${musicApiHealth.latencyMs} ms`}</small>
          {musicApiHealth.details.map((detail) => <em key={detail}>{detail}</em>)}
        </article>
        <article className={`service-health-card ${healthTone(relayHealth.status)}`}>
          <div><span className={`service-dot ${healthTone(relayHealth.status)}`} aria-hidden="true" /><strong>LAN Relay</strong></div>
          <p>{relayHealth.message}</p>
          <small>{endpointLabel(relayBase)}{relayHealth.latencyMs == null ? "" : ` · ${relayHealth.latencyMs} ms`}</small>
          {relayHealth.details.map((detail) => <em key={detail}>{detail}</em>)}
        </article>
        <article className={`service-health-card room-health-card ${roomOnline ? "is-online" : roomStatus === "error" ? "is-offline" : "is-checking"}`}>
          <div><span className={`service-dot ${roomOnline ? "is-online" : roomStatus === "error" ? "is-offline" : "is-checking"}`} aria-hidden="true" /><strong>同步房间</strong></div>
          <p>{roomMessage}</p>
          <small>{roomCode ? `${roomCode} · ${roomIsLeader ? "主控" : "跟随"}` : "未加入房间"}</small>
          <em>{clockReady ? `校时完成 · ${Math.round(localLatencyMs)} ms / 抖动 ${Math.round(localJitterMs)} ms` : "正在校准设备时钟"}</em>
        </article>
      </div>

      {roomError ? <p className="room-diagnostic-alert is-error">{roomError}</p> : null}
      {roomState?.prepareError ? (
        <p className="room-diagnostic-alert is-error">
          {roomState.prepareError === "start_failed" ? "有设备未能在计划时间启动" : "缓冲等待已到上限"}
          {failedDevices.length ? `：${failedDevices.map((device) => device.name).join("、")}` : ""}
        </p>
      ) : null}
      {roomState?.preparing ? (
        <div className="room-preparation-summary">
          <div>
            <span>全房间缓冲</span>
            <strong>{Math.round(Math.max(0, Math.min(1, roomState.bufferProgress || 0)) * 100)}%</strong>
          </div>
          <progress max="1" value={Math.max(0, Math.min(1, roomState.bufferProgress || 0))} aria-label="全房间平均缓冲进度" />
          <p>
            {waitingDevices.length
              ? `仍在等待：${waitingDevices.map((device) => `${device.name}（${Math.round(device.bufferProgress * 100)}%）`).join("、")}`
              : "所有设备已就绪，正在安排统一启动时间。"}
          </p>
          {roomState.prepareDeadline ? <small>本轮动态等待至 {new Date(roomState.prepareDeadline).toLocaleTimeString("zh-CN", { hour12: false })}</small> : null}
        </div>
      ) : null}

      <div className="device-center-heading">
        <strong>房间设备</strong>
        <span>{devices.length || roomState?.deviceCount || 0} 台</span>
      </div>
      {devices.length ? (
        <ul className="device-diagnostic-list">
          {devices.map((device) => (
            <DeviceRow
              clientId={clientId}
              device={device}
              key={`${device.clientId}:${device.volumeTrimDb || 0}:${device.delayMs || 0}`}
              onCalibrate={onCalibrateDevice}
              roomIsLeader={roomIsLeader}
            />
          ))}
        </ul>
      ) : (
        <p className="device-diagnostic-empty">
          {roomOnline ? "中继已连接，但尚未返回设备诊断；请确认主机 LAN 服务已更新。" : "加入房间后会在这里显示每台设备的缓冲和时钟状态。"}
        </p>
      )}
    </section>
  );
}
