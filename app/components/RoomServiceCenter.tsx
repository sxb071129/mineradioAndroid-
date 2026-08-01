"use client";

import type { RoomDeviceState, RoomState, SyncStatus } from "../lib/sync-types";
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

function healthTone(status: ServiceHealthSnapshot["status"]) {
  if (status === "online") return "is-online";
  if (status === "offline") return "is-offline";
  return "is-checking";
}

function bufferStateLabel(device: RoomDeviceState) {
  if (device.blocked || device.bufferState === "error") return "等待重新播放";
  if (device.ready || device.prepared || device.bufferState === "ready") return "已就绪";
  if (device.bufferState === "unlock_required") return "需要点按播放授权";
  if (device.bufferState === "stalled") return "正在自动恢复";
  if (device.bufferState === "buffering") return "正在补充缓冲";
  return device.participant ? "正在接收音频" : "已连接";
}

function DeviceRow({ clientId, device }: { clientId: string; device: RoomDeviceState }) {
  const progress = Math.max(0, Math.min(1, Number(device.bufferProgress) || 0));
  const ready = device.ready || device.prepared || device.bufferState === "ready";
  const preparing = device.participant && !ready;

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
        {preparing ? <span>{Math.round(progress * 100)}%</span> : null}
      </div>
      {preparing ? (
        <progress
          className="device-buffer-progress"
          max="1"
          value={progress}
          aria-label={`${device.name || "设备"}同步准备 ${Math.round(progress * 100)}%`}
        />
      ) : null}
    </li>
  );
}

export function RoomServiceCenter({
  clientId,
  musicApiHealth,
  relayHealth,
  roomCode,
  roomError,
  roomIsLeader,
  roomState,
  roomStatus,
  onRefresh,
}: Props) {
  const devices = roomState?.devices || [];
  const waitingDevices = devices.filter((device) => device.participant && !device.ready);
  const failedIds = new Set(roomState?.prepareErrorClientIds || []);
  const failedDevices = devices.filter((device) => device.blocked || failedIds.has(device.clientId));
  const roomOnline = roomStatus === "connected";
  const roomMessage = roomOnline
    ? roomState?.preparing
      ? roomState.commitState === "tentative"
        ? `确认同步启动 ${roomState.armedCount}/${Math.max(1, roomState.strictRequiredCount)}`
        : `缓冲准备 ${roomState.readyCount}/${Math.max(1, roomState.requiredCount)}`
      : roomState?.prepareError
        ? "本轮同步已暂停"
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
          <h3 id="service-center-title">连接与设备</h3>
        </div>
        <button type="button" onClick={onRefresh}>重新检查</button>
      </div>

      <div className="service-health-grid">
        <article className={`service-health-card ${healthTone(musicApiHealth.status)}`}>
          <div><span className={`service-dot ${healthTone(musicApiHealth.status)}`} aria-hidden="true" /><strong>音乐服务</strong></div>
          <p>{musicApiHealth.message}</p>
          <small>后台自动检测</small>
        </article>
        <article className={`service-health-card ${healthTone(relayHealth.status)}`}>
          <div><span className={`service-dot ${healthTone(relayHealth.status)}`} aria-hidden="true" /><strong>局域网同步</strong></div>
          <p>{relayHealth.message}</p>
          <small>断线后自动重连</small>
        </article>
        <article className={`service-health-card room-health-card ${roomOnline ? "is-online" : roomStatus === "error" ? "is-offline" : "is-checking"}`}>
          <div><span className={`service-dot ${roomOnline ? "is-online" : roomStatus === "error" ? "is-offline" : "is-checking"}`} aria-hidden="true" /><strong>同步房间</strong></div>
          <p>{roomMessage}</p>
          <small>{roomCode ? `${roomCode} · ${roomIsLeader ? "主控" : "跟随"}` : "未加入房间"}</small>
          <em>时钟、进度和音量在后台自动校准</em>
        </article>
      </div>

      {roomError ? <p className="room-diagnostic-alert is-error">{roomError}</p> : null}
      {roomState?.prepareError ? (
        <p className="room-diagnostic-alert is-error">
          {roomState.prepareError === "start_failed" ? "设备启动未完成，请重新点击播放" : "缓冲未完成，请重新点击播放"}
          {failedDevices.length ? `：${failedDevices.map((device) => device.name).join("、")}` : ""}
        </p>
      ) : null}
      {roomState?.preparing ? (
        <div className="room-preparation-summary">
          <div>
            <span>同步准备</span>
            <strong>{Math.round(Math.max(0, Math.min(1, roomState.bufferProgress || 0)) * 100)}%</strong>
          </div>
          <progress max="1" value={Math.max(0, Math.min(1, roomState.bufferProgress || 0))} aria-label="全房间同步准备进度" />
          <p>
            {waitingDevices.length
              ? `正在等待：${waitingDevices.map((device) => device.name).join("、")}`
              : "所有设备已就绪，正在统一起播时刻。"}
          </p>
          <small>网络变化时会自动重新规划起播时刻</small>
        </div>
      ) : null}

      <div className="device-center-heading">
        <strong>房间设备</strong>
        <span>{devices.length || roomState?.deviceCount || 0} 台</span>
      </div>
      {devices.length ? (
        <ul className="device-diagnostic-list">
          {devices.map((device) => <DeviceRow clientId={clientId} device={device} key={device.clientId} />)}
        </ul>
      ) : (
        <p className="device-diagnostic-empty">
          {roomOnline ? "正在同步设备状态。" : "加入房间后会自动显示已连接设备。"}
        </p>
      )}
    </section>
  );
}
