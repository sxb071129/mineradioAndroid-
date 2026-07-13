"use client";

import {
  type CSSProperties,
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRoomSync } from "../hooks/use-room-sync";
import type { TrackDescriptor } from "../lib/sync-types";

type LocalTrack = TrackDescriptor & { url: string };
type AudioWindow = Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext };

const DEFAULT_VOLUME = 0.72;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

function defaultRelayUrl() {
  if (typeof window === "undefined") return "ws://localhost:8787/ws";
  const saved = window.localStorage.getItem("mineradio-lan-settings-v1");
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as { relayUrl?: string };
      if (parsed.relayUrl) return parsed.relayUrl;
    } catch {
      // Ignore stale settings and fall back to the current host.
    }
  }
  const secure = window.location.protocol === "https:";
  const port = secure ? window.location.port || "443" : "8787";
  return `${secure ? "wss" : "ws"}://${window.location.hostname}:${port}/${secure ? "sync" : "ws"}`;
}

function defaultDeviceName() {
  if (typeof navigator === "undefined") return "网页设备";
  const platform = navigator.userAgent.match(/Android|iPhone|iPad|Macintosh|Windows/i)?.[0];
  return `${platform || "网页"}设备`;
}

function roomFromUrl() {
  if (typeof window === "undefined") return "";
  return (new URL(window.location.href).searchParams.get("room") || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
}

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function updateRoomInUrl(room: string) {
  const url = new URL(window.location.href);
  if (room) url.searchParams.set("room", room);
  else url.searchParams.delete("room");
  window.history.replaceState({}, "", url);
}

export function MineradioPlayer() {
  const initialRoom = useMemo(() => roomFromUrl(), []);
  const [mode, setMode] = useState<"solo" | "room">(initialRoom ? "room" : "solo");
  const [roomCode, setRoomCode] = useState(initialRoom);
  const [roomInput, setRoomInput] = useState(initialRoom);
  const [relayUrl, setRelayUrl] = useState(defaultRelayUrl);
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [localTrack, setLocalTrack] = useState<LocalTrack | null>(null);
  const [soloPlaying, setSoloPlaying] = useState(false);
  const [soloVolume, setSoloVolume] = useState(DEFAULT_VOLUME);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState("");
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [copied, setCopied] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceCreatedRef = useRef(false);
  const objectUrlRef = useRef("");

  const room = useRoomSync({
    enabled: mode === "room" && Boolean(roomCode),
    roomCode,
    relayUrl,
    deviceName,
  });

  const roomState = room.state;
  const roomIsLeader = room.isLeader;
  const sendRoomCommand = room.sendCommand;
  const getRoomTargetPosition = room.targetPosition;

  const roomTrack = roomState?.track || null;
  const effectiveTrack = mode === "room" ? roomTrack : localTrack;
  const effectivePlaying = mode === "room" ? Boolean(roomState?.playing) : soloPlaying;
  const effectiveVolume = mode === "room" ? roomState?.volume ?? DEFAULT_VOLUME : soloVolume;
  const canControl = mode === "solo" || roomIsLeader;
  const roomConnected = room.status === "connected";
  const audioSource = useMemo(() => {
    if (!effectiveTrack) return "";
    if (mode === "solo") return localTrack?.url || "";
    if (!room.httpBase) return "";
    return new URL(effectiveTrack.path, room.httpBase).toString();
  }, [effectiveTrack, localTrack?.url, mode, room.httpBase]);

  useEffect(() => {
    window.localStorage.setItem(
      "mineradio-lan-settings-v1",
      JSON.stringify({ relayUrl, version: 1 }),
    );
  }, [relayUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    if (audioSource) audio.src = audioSource;
    audio.load();
    setProgress(0);
    setDuration(0);
  }, [audioSource]);

  const ensureAudioGraph = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    const Context = window.AudioContext || (window as AudioWindow).webkitAudioContext;
    if (!Context) return;
    if (!audioContextRef.current) audioContextRef.current = new Context();
    const context = audioContextRef.current;
    if (!sourceCreatedRef.current) {
      const source = context.createMediaElementSource(audio);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.78;
      source.connect(analyser);
      analyser.connect(context.destination);
      analyserRef.current = analyser;
      sourceCreatedRef.current = true;
    }
    if (context.state === "suspended") await context.resume();
  }, []);

  useEffect(() => {
    let frame = 0;
    let bass = 0;
    let mid = 0;
    let treble = 0;
    const values = new Uint8Array(128);
    const draw = () => {
      const analyser = analyserRef.current;
      const stage = stageRef.current;
      if (analyser && stage) {
        analyser.getByteFrequencyData(values);
        const average = (start: number, end: number) => {
          let total = 0;
          for (let index = start; index < end; index += 1) total += values[index];
          return total / Math.max(1, end - start) / 255;
        };
        const active = Boolean(audioRef.current && !audioRef.current.paused);
        const lowTarget = active ? average(1, 8) : 0;
        const midTarget = active ? average(8, 28) : 0;
        const highTarget = active ? average(28, 64) : 0;
        bass += (lowTarget - bass) * 0.16;
        mid += (midTarget - mid) * 0.12;
        treble += (highTarget - treble) * 0.1;
        stage.style.setProperty("--bass", bass.toFixed(3));
        stage.style.setProperty("--mid", mid.toFixed(3));
        stage.style.setProperty("--treble", treble.toFixed(3));
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    const state = roomState;
    if (!audio || mode !== "room" || !state || !audioSource) return;
    audio.volume = state.volume;
    const target = Math.min(getRoomTargetPosition(state), audio.duration || Infinity);
    const drift = target - (audio.currentTime || 0);
    if (Math.abs(drift) > 0.28 && Number.isFinite(target)) {
      audio.currentTime = target;
      audio.playbackRate = 1;
    } else if (state.playing && Math.abs(drift) > 0.08) {
      audio.playbackRate = drift > 0 ? 1.025 : 0.975;
    } else {
      audio.playbackRate = 1;
    }
    if (state.playing) {
      audio.play().then(() => setNeedsUnlock(false)).catch(() => setNeedsUnlock(true));
    } else {
      audio.pause();
    }
    const resetRate = window.setTimeout(() => {
      audio.playbackRate = 1;
    }, 1200);
    return () => window.clearTimeout(resetRate);
  }, [audioSource, getRoomTargetPosition, mode, roomState]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || mode !== "solo") return;
    audio.volume = soloVolume;
  }, [mode, soloVolume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let lastPaint = 0;
    let frame = 0;
    const update = (timestamp = 0) => {
      if (timestamp - lastPaint > 180) {
        setProgress(audio.currentTime || 0);
        if (Number.isFinite(audio.duration)) setDuration(audio.duration || 0);
        lastPaint = timestamp;
      }
      frame = requestAnimationFrame(update);
    };
    const onDuration = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const onEnded = () => {
      if (mode === "solo") setSoloPlaying(false);
      else if (roomIsLeader) sendRoomCommand({ action: "pause" });
    };
    audio.addEventListener("loadedmetadata", onDuration);
    audio.addEventListener("durationchange", onDuration);
    audio.addEventListener("ended", onEnded);
    frame = requestAnimationFrame(update);
    return () => {
      cancelAnimationFrame(frame);
      audio.removeEventListener("loadedmetadata", onDuration);
      audio.removeEventListener("durationchange", onDuration);
      audio.removeEventListener("ended", onEnded);
    };
  }, [mode, roomIsLeader, sendRoomCommand]);

  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      audioContextRef.current?.close();
    },
    [],
  );

  const togglePlayback = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !effectiveTrack || !canControl) return;
    await ensureAudioGraph();
    if (mode === "room") {
      room.sendCommand({ action: room.state?.playing ? "pause" : "play" });
      return;
    }
    if (audio.paused) {
      await audio.play();
      setSoloPlaying(true);
    } else {
      audio.pause();
      setSoloPlaying(false);
    }
  }, [canControl, effectiveTrack, ensureAudioGraph, mode, room]);

  const unlockAudio = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      await ensureAudioGraph();
      if (mode === "room" && room.state?.playing) {
        audio.currentTime = room.targetPosition(room.state);
        await audio.play();
      } else if (audioSource) {
        await audio.play();
        audio.pause();
      }
      setNeedsUnlock(false);
      setNotice("声音已启用，设备会自动追赶房间进度");
    } catch {
      setNotice("浏览器仍阻止播放，请检查静音开关或媒体权限");
    }
  }, [audioSource, ensureAudioGraph, mode, room]);

  const onFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      if (!file.type.startsWith("audio/")) {
        setNotice("请选择浏览器支持的音频文件");
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setNotice("文件超过 512 MB，请选择更小的音频");
        return;
      }
      await ensureAudioGraph();
      if (mode === "solo") {
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        const url = URL.createObjectURL(file);
        objectUrlRef.current = url;
        setLocalTrack({
          id: `local-${file.lastModified}-${file.size}`,
          name: file.name.replace(/\.[^.]+$/, ""),
          type: file.type,
          size: file.size,
          path: "",
          url,
        });
        setSoloPlaying(false);
        setNotice("文件只保留在此设备；创建房间后才会分享给局域网设备");
        return;
      }
      if (!room.isLeader || !roomConnected || !room.httpBase) {
        setNotice("请等待房间连接，且只有主控可以更换歌曲");
        return;
      }
      setUploading(true);
      setNotice("正在把歌曲安全地送到局域网中继…");
      try {
        const endpoint = new URL("/api/tracks", room.httpBase);
        endpoint.searchParams.set("name", file.name.replace(/\.[^.]+$/, ""));
        endpoint.searchParams.set("type", file.type);
        const response = await fetch(endpoint, { method: "POST", body: file });
        const result = (await response.json()) as TrackDescriptor & { error?: string };
        if (!response.ok) throw new Error(result.error || "upload_failed");
        room.sendCommand({ action: "track", track: result });
        setNotice("歌曲已送达房间，所有设备将加载同一份音频");
      } catch (error) {
        setNotice(`上传失败：${error instanceof Error ? error.message : "未知错误"}`);
      } finally {
        setUploading(false);
      }
    },
    [ensureAudioGraph, mode, room, roomConnected],
  );

  const seek = useCallback(
    (value: number) => {
      const audio = audioRef.current;
      if (!audio || !canControl) return;
      if (mode === "room") room.sendCommand({ action: "seek", position: value });
      else {
        audio.currentTime = value;
        setProgress(value);
      }
    },
    [canControl, mode, room],
  );

  const setVolume = useCallback(
    (value: number) => {
      if (!canControl) return;
      if (mode === "room") room.sendCommand({ action: "volume", volume: value });
      else setSoloVolume(value);
    },
    [canControl, mode, room],
  );

  const createRoom = useCallback(() => {
    const code = createRoomCode();
    setMode("room");
    setRoomCode(code);
    setRoomInput(code);
    updateRoomInUrl(code);
    setNotice("房间已创建；连接后你将成为主控");
  }, []);

  const joinRoom = useCallback(() => {
    const code = roomInput.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (code.length < 4) {
      setNotice("请输入 4–8 位房间码");
      return;
    }
    setMode("room");
    setRoomCode(code);
    setRoomInput(code);
    updateRoomInUrl(code);
  }, [roomInput]);

  const leaveRoom = useCallback(() => {
    setMode("solo");
    setRoomCode("");
    updateRoomInUrl("");
    setNeedsUnlock(false);
    setNotice("已回到单机模式");
  }, []);

  const shareUrl = useMemo(() => {
    if (typeof window === "undefined" || !roomCode) return "";
    const url = new URL(window.location.href);
    url.searchParams.set("room", roomCode);
    if (["localhost", "127.0.0.1"].includes(url.hostname) && room.addresses[0]) {
      url.hostname = room.addresses[0];
      if (!url.port) url.port = "3000";
      url.protocol = "http:";
    }
    return url.toString();
  }, [room.addresses, roomCode]);

  const copyShareLink = useCallback(async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, [shareUrl]);

  const stageStyle = {
    "--progress": `${duration ? Math.min(1, progress / duration) : 0}`,
  } as CSSProperties;

  const syncLabel =
    mode === "solo"
      ? "仅本机"
      : room.status === "connected"
        ? `${room.isLeader ? "主控" : "跟随"} · ${room.state?.deviceCount || 1} 台设备`
        : room.status === "reconnecting"
          ? "正在重连"
          : "等待中继";

  return (
    <main className="app-shell">
      <audio ref={audioRef} crossOrigin="anonymous" preload="metadata" />
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept="audio/*,.flac,.m4a,.mp3,.ogg,.wav,.aac"
        onChange={onFile}
      />

      <header className="topbar">
        <a className="brand" href="#player" aria-label="回到播放器">
          <span className="brand-mark" aria-hidden="true">MR</span>
          <span><strong>ROOM RADIO</strong><small>based on Mineradio</small></span>
        </a>
        <div className="status-cluster" aria-live="polite">
          <span className={`status-dot ${roomConnected ? "is-online" : ""}`} />
          <span>{syncLabel}</span>
          {mode === "room" && roomConnected ? <span className="latency">{room.latency} ms</span> : null}
        </div>
      </header>

      <section id="player" ref={stageRef} className="player-grid" style={stageStyle}>
        <div className="sound-stage">
          <div className="ambient ambient-one" aria-hidden="true" />
          <div className="ambient ambient-two" aria-hidden="true" />
          <div className="stage-copy">
            <span className="eyebrow">{mode === "room" ? `SYNC ROOM / ${roomCode || "—"}` : "PRIVATE LISTENING"}</span>
            <h1>{effectiveTrack?.name || "把一首歌放进房间"}</h1>
            <p>
              {effectiveTrack
                ? mode === "room"
                  ? "同一音源、同一时间线、同一房间音量。"
                  : "本地播放不会上传；随时可以创建局域网房间。"
                : "选择本地音频，或创建房间后分享给同一 Wi‑Fi 下的设备。"}
            </p>
          </div>

          <div className={`record-orbit ${effectivePlaying ? "is-playing" : ""}`} aria-hidden="true">
            <div className="record-disc">
              <div className="record-label">
                <span>ROOM</span><strong>{effectiveTrack ? "LIVE" : "IDLE"}</strong><small>{mode === "room" ? roomCode || "SYNC" : "SOLO"}</small>
              </div>
            </div>
          </div>

          <div className="transport" aria-label="播放控制">
            <button
              className="track-button"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || (mode === "room" && !room.isLeader)}
            >
              {uploading ? "正在上传…" : effectiveTrack ? "更换歌曲" : "选择歌曲"}
            </button>
            <button
              className="play-button"
              type="button"
              onClick={togglePlayback}
              disabled={!effectiveTrack || !canControl}
              aria-label={effectivePlaying ? "暂停" : "播放"}
            >
              <span aria-hidden="true">{effectivePlaying ? "Ⅱ" : "▶"}</span>
            </button>
            <div className="time-block">
              <div className="time-row"><span>{formatTime(progress)}</span><span>{formatTime(duration)}</span></div>
              <input
                aria-label="播放进度"
                className="progress-slider"
                type="range"
                min="0"
                max={duration || 1}
                step="0.05"
                value={Math.min(progress, duration || 1)}
                disabled={!effectiveTrack || !canControl}
                onChange={(event) => seek(Number(event.target.value))}
              />
            </div>
            <label className="volume-block">
              <span>ROOM VOL</span>
              <input
                aria-label="房间音量"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={effectiveVolume}
                disabled={!canControl}
                onChange={(event) => setVolume(Number(event.target.value))}
              />
              <output>{Math.round(effectiveVolume * 100)}%</output>
            </label>
          </div>
        </div>

        <aside className="room-panel" aria-labelledby="room-title">
          <div className="panel-heading">
            <div><span className="eyebrow">LISTEN TOGETHER</span><h2 id="room-title">局域网同步房间</h2></div>
            {mode === "room" ? <button className="text-button" type="button" onClick={leaveRoom}>退出</button> : null}
          </div>

          {mode === "solo" ? (
            <div className="lobby-stack">
              <div className="solo-note"><span className="note-index">01</span><p>单机模式下，音频只在当前浏览器内播放，不会上传。</p></div>
              <button className="primary-action" type="button" onClick={createRoom}>创建同步房间<span aria-hidden="true">↗</span></button>
              <div className="join-row">
                <label>
                  <span>房间码</span>
                  <input
                    value={roomInput}
                    onChange={(event) => setRoomInput(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
                    placeholder="例如 A7K9Q2"
                    autoCapitalize="characters"
                    inputMode="text"
                  />
                </label>
                <button type="button" onClick={joinRoom}>加入</button>
              </div>
            </div>
          ) : (
            <div className="room-stack">
              <div className="room-code-card">
                <span>ROOM CODE</span><strong>{roomCode}</strong>
                <button type="button" onClick={copyShareLink} disabled={!shareUrl}>{copied ? "已复制" : "复制局域网链接"}</button>
              </div>
              <dl className="room-stats">
                <div><dt>角色</dt><dd>{room.isLeader ? "主控设备" : "同步跟随"}</dd></div>
                <div><dt>设备</dt><dd>{room.state?.deviceCount || 1} 台</dd></div>
                <div><dt>延迟</dt><dd>{roomConnected ? `${room.latency} ms` : "—"}</dd></div>
                <div><dt>状态</dt><dd>{roomConnected ? "已同步" : "等待连接"}</dd></div>
              </dl>
              {!room.isLeader ? <div className="follower-note">进度与应用内音量由主控自动同步；系统音量仍由本机按键控制。</div> : null}
            </div>
          )}

          <details className="relay-settings">
            <summary>局域网中继设置</summary>
            <label><span>中继地址</span><input value={relayUrl} onChange={(event) => setRelayUrl(event.target.value)} spellCheck="false" /></label>
            <label><span>设备名称</span><input value={deviceName} onChange={(event) => setDeviceName(event.target.value.slice(0, 32))} /></label>
            <p>在主机运行 LAN 模式后，同一 Wi‑Fi 的设备使用主机 IP 即可加入。</p>
          </details>

          <div className="capability-list" aria-label="同步能力">
            <span>同曲目</span><span>进度校准</span><span>房间音量</span><span>自动重连</span>
          </div>
        </aside>
      </section>

      {needsUnlock ? (
        <div className="unlock-banner" role="alert"><span>浏览器需要你点按一次，才能响应房间播放。</span><button type="button" onClick={unlockAudio}>启用声音并追赶</button></div>
      ) : null}

      {(notice || room.error) ? (
        <div className="toast" role="status">{room.error || notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice("")}>×</button></div>
      ) : null}

      <footer className="site-footer">
        <span>MR//ROOM 01</span>
        <p>受 Mineradio 启发的 GPL-3.0 网页改编 · 音频只在你选择的设备和局域网中继间流动</p>
        <a href="https://github.com/zws84952324-create/Mineradio-Kugou-Modified" target="_blank" rel="noreferrer">上游项目 ↗</a>
      </footer>
    </main>
  );
}
