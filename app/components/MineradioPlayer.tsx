"use client";

/* eslint-disable @next/next/no-img-element -- vinext does not provide a working image optimizer route. */

import {
  ArrowsClockwise,
  CaretLeft,
  Check,
  Copy,
  CornersOut,
  GearSix,
  Heart,
  House,
  List,
  MagnifyingGlass,
  MusicNotes,
  Pause,
  Play,
  Plus,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  UploadSimple,
  UsersThree,
  Waveform,
  WifiHigh,
  X,
} from "@phosphor-icons/react";
import {
  type CSSProperties,
  type ChangeEvent,
  type FormEvent,
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
  const [roomPanelOpen, setRoomPanelOpen] = useState(Boolean(initialRoom));
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [liked, setLiked] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [legacyPanel, setLegacyPanel] = useState<"login" | "daily" | "recommend" | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const stageRef = useRef<HTMLElement>(null);
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
      setNotice("声音已启用，这台设备会自动追赶房间进度。");
    } catch {
      setNotice("浏览器仍阻止播放，请检查静音开关或媒体权限。");
    }
  }, [audioSource, ensureAudioGraph, mode, room]);

  const onFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      if (!file.type.startsWith("audio/")) {
        setNotice("请选择浏览器支持的音频文件。");
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setNotice("文件超过 512 MB，请选择更小的音频。");
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
        setNotice("歌曲只保留在当前设备；创建房间后可分享给局域网设备。");
        return;
      }
      if (!room.isLeader || !roomConnected || !room.httpBase) {
        setNotice("请等待房间连接；只有主控设备可以更换歌曲。");
        return;
      }
      setUploading(true);
      setNotice("正在把歌曲发送到局域网中继…");
      try {
        const endpoint = new URL("/api/tracks", room.httpBase);
        endpoint.searchParams.set("name", file.name.replace(/\.[^.]+$/, ""));
        endpoint.searchParams.set("type", file.type);
        const response = await fetch(endpoint, { method: "POST", body: file });
        const result = (await response.json()) as TrackDescriptor & { error?: string };
        if (!response.ok) throw new Error(result.error || "upload_failed");
        room.sendCommand({ action: "track", track: result });
        setNotice("歌曲已送达房间，所有设备会加载同一份音频。");
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
    setRoomPanelOpen(true);
    updateRoomInUrl(code);
    setNotice("房间已创建；连接后你将成为主控设备。");
  }, []);

  const joinRoom = useCallback(() => {
    const code = roomInput.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (code.length < 4) {
      setNotice("请输入 4–8 位房间码。");
      return;
    }
    setMode("room");
    setRoomCode(code);
    setRoomInput(code);
    setRoomPanelOpen(true);
    updateRoomInUrl(code);
  }, [roomInput]);

  const leaveRoom = useCallback(() => {
    setMode("solo");
    setRoomCode("");
    updateRoomInUrl("");
    setNeedsUnlock(false);
    setNotice("已回到单机模式。");
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

  const onSearchSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (searchText.trim()) {
      setNotice(`网页改编版不调用第三方搜索接口；请从本机导入“${searchText.trim()}”。`);
    }
    fileInputRef.current?.click();
  }, [searchText]);

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
  const overlayOpen = roomPanelOpen || Boolean(legacyPanel) || lyricsOpen;

  const handleHomeCardAction = useCallback((action: "file" | "daily" | "recommend" | "play" | "profile") => {
    if (action === "file") fileInputRef.current?.click();
    else if (action === "daily") setLegacyPanel("daily");
    else if (action === "recommend") setLegacyPanel("recommend");
    else if (action === "play") void togglePlayback();
    else setNotice("听歌画像将在积累更多本地播放记录后生成。");
  }, [togglePlayback]);

  const homeCards = [
    {
      label: "LIBRARY",
      title: "我的歌单",
      sub: effectiveTrack ? `正在听：${effectiveTrack.name}` : "从本地音乐开始",
      tone: "mint",
      action: "file" as const,
    },
    {
      label: "DAILY",
      title: "每日推荐",
      sub: "登录后同步你的今日歌曲",
      tone: "blue",
      action: "daily" as const,
    },
    {
      label: "SONG",
      title: "推荐歌曲",
      sub: "登录后同步更多歌曲",
      tone: "ice",
      action: "recommend" as const,
    },
    {
      label: "CONTINUE",
      title: "继续听",
      sub: duration ? `${formatTime(progress)} / ${formatTime(duration)}` : "最近播放会出现在这里",
      tone: "silver",
      action: effectiveTrack ? "play" as const : "file" as const,
    },
    {
      label: "PROFILE",
      title: "听歌画像",
      sub: "播放几首后生成偏好",
      tone: "cyan",
      action: "profile" as const,
    },
    {
      label: "VISUAL",
      title: "更多歌曲",
      sub: "播放后会继续补全推荐",
      tone: "gold",
      action: "recommend" as const,
    },
  ];

  return (
    <main ref={stageRef} className="mineradio-shell" style={stageStyle}>
      <audio ref={audioRef} crossOrigin="anonymous" preload="metadata" />
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept="audio/*,.flac,.m4a,.mp3,.ogg,.wav,.aac"
        onChange={onFile}
      />

      <div className="starfield" aria-hidden="true" />

      <header className="mineradio-topbar" inert={overlayOpen}>
        <form className="search-glass" role="search" onSubmit={onSearchSubmit}>
          <MagnifyingGlass size={18} weight="regular" aria-hidden="true" />
          <input
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="搜索歌曲、歌手…"
            aria-label="搜索歌曲或歌手"
          />
          <button type="submit" aria-label="从本机导入音乐">
            <UploadSimple size={18} aria-hidden="true" />
          </button>
        </form>

        <nav className="top-actions" aria-label="播放器导航">
          <button className="round-glass" type="button" aria-label="回到音乐库">
            <House size={19} weight="fill" aria-hidden="true" />
          </button>
          <button
            className={`room-capsule ${roomConnected ? "is-connected" : ""}`}
            type="button"
            onClick={() => setRoomPanelOpen(true)}
            aria-label="打开同步房间"
          >
            <WifiHigh size={17} aria-hidden="true" />
            <span>{syncLabel}</span>
            {mode === "room" && roomConnected ? <small>{room.latency} ms</small> : null}
          </button>
          <button className="login-capsule" type="button" onClick={() => setLegacyPanel("login")}>登录</button>
        </nav>
      </header>

      <section className="home-workspace" aria-label="Mineradio 音乐库" inert={overlayOpen}>
        <article className="home-hero-card">
          <div className="hero-copy">
            <span className="micro-label">MINERADIO · YOUR LIBRARY</span>
            <h1>{effectiveTrack ? effectiveTrack.name : "我的音乐库"}</h1>
            <p>
              {effectiveTrack
                ? mode === "room"
                  ? "同一音源、同一时间线和同一应用内音量，所有设备保持同步。"
                  : "歌曲只在这台设备播放；随时可以创建局域网房间。"
                : "从本地音乐或同步房间开始，歌曲、进度和音量会在你的设备之间保持一致。"}
            </p>
            <div className="hero-meta">
              <span>{mode === "room" ? `房间 ${roomCode}` : "本机播放"}</span>
              <span>{effectivePlaying ? "正在播放" : "等待播放"}</span>
            </div>
          </div>

          <div className={`hero-disc-stack ${effectivePlaying ? "is-playing" : ""}`} aria-hidden="true">
            <img className="disc-card disc-card-one" src="/mineradio-card-art.png" width="115" height="115" alt="" />
            <img className="disc-card disc-card-two" src="/mineradio-card-art.png" width="115" height="115" alt="" />
            <img className="disc-card disc-card-three" src="/mineradio-card-art.png" width="115" height="115" alt="" />
          </div>

          <div className="wave-panel" aria-hidden="true">
            <img src="/mineradio-wave.png" width="516" height="105" alt="" />
          </div>

          <div className="hero-actions">
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading || (mode === "room" && !room.isLeader)}>
              <UploadSimple size={15} aria-hidden="true" />
              {uploading ? "正在上传…" : effectiveTrack ? "更换歌曲" : "导入本地音乐"}
            </button>
            <button type="button" onClick={() => setRoomPanelOpen(true)}>
              <UsersThree size={15} aria-hidden="true" />
              同步房间
            </button>
          </div>
        </article>

        <div className="home-side">
          <div className="home-card-grid">
            {homeCards.map((card) => (
              <button className={`home-card tone-${card.tone}`} type="button" onClick={() => handleHomeCardAction(card.action)} key={card.label}>
                <span className="home-card-label">{card.label}</span>
                <strong>{card.title}</strong>
                <small>{card.sub}</small>
                <img className="home-card-art" src="/mineradio-card-art.png" width="115" height="115" alt="" />
              </button>
            ))}
          </div>

          <section className="start-rail" aria-labelledby="start-title">
            <div className="start-heading">
              <h2 id="start-title">先从这里开始</h2>
              <span>局域网模式无需账号</span>
            </div>
            <div className="start-tile-row">
              <button type="button" onClick={() => fileInputRef.current?.click()}>
                <span className="tile-art"><img src="/mineradio-tile-art.png" width="102" height="93" alt="" /></span>
                <strong>导入本地音乐</strong>
              </button>
              <button type="button" onClick={createRoom}>
                <span className="tile-icon"><Plus size={28} aria-hidden="true" /></span>
                <strong>创建同步房间</strong>
              </button>
              <button type="button" onClick={() => setRoomPanelOpen(true)}>
                <span className="tile-icon"><UsersThree size={28} aria-hidden="true" /></span>
                <strong>加入局域网房间</strong>
              </button>
              <button type="button" onClick={() => setLyricsOpen((value) => !value)}>
                <span className="tile-icon"><Waveform size={28} aria-hidden="true" /></span>
                <strong>打开歌词舞台</strong>
              </button>
            </div>
          </section>
        </div>
      </section>

      {lyricsOpen ? (
        <section className="lyrics-stage" aria-label="歌词舞台">
          <button type="button" onClick={() => setLyricsOpen(false)} aria-label="关闭歌词舞台">
            <X size={20} aria-hidden="true" />
          </button>
          <span>{effectiveTrack ? "NOW PLAYING" : "MINERADIO"}</span>
          <h2>{effectiveTrack?.name || "导入一首歌，让视觉舞台醒来"}</h2>
          <p>{mode === "room" ? "歌词视觉与房间时间线保持同一拍" : "本地播放 · 私人视觉电台"}</p>
        </section>
      ) : null}

      {legacyPanel ? (
        <>
        <button className="legacy-scrim" type="button" onClick={() => setLegacyPanel(null)} aria-label="关闭原版云端面板" />
        <section className="legacy-modal" role="dialog" aria-modal="true" aria-labelledby="legacy-title">
          <button type="button" onClick={() => setLegacyPanel(null)} aria-label="关闭原版云端面板"><X size={20} aria-hidden="true" /></button>
          <span>MINERADIO CLOUD</span>
          <h2 id="legacy-title">{legacyPanel === "login" ? "登录" : legacyPanel === "daily" ? "每日推荐" : "推荐歌曲"}</h2>
          <p>该入口保留原版云端服务边界，不经过局域网同步中继。登录状态和推荐数据仍由原版接口提供。</p>
          <div className="legacy-state">
            <ArrowsClockwise size={20} aria-hidden="true" />
            <span>{legacyPanel === "login" ? "等待原版登录服务" : "登录后同步云端内容"}</span>
          </div>
          <button className="legacy-close" type="button" onClick={() => setLegacyPanel(null)}>返回音乐库</button>
        </section>
        </>
      ) : null}

      <aside className={`room-drawer ${roomPanelOpen ? "is-open" : ""}`} aria-labelledby="room-title" aria-hidden={!roomPanelOpen} inert={!roomPanelOpen}>
        <div className="drawer-heading">
          <button className="drawer-back" type="button" onClick={() => setRoomPanelOpen(false)} aria-label="关闭同步房间">
            <CaretLeft size={20} aria-hidden="true" />
          </button>
          <div>
            <span>LISTEN TOGETHER</span>
            <h2 id="room-title">局域网同步房间</h2>
          </div>
          {mode === "room" ? <button className="drawer-leave" type="button" onClick={leaveRoom}>退出</button> : null}
        </div>

        {mode === "solo" ? (
          <div className="room-lobby">
            <p>房间内会自动同步歌曲、播放状态、进度与应用内音量。</p>
            <button className="drawer-primary" type="button" onClick={createRoom}>
              <UsersThree size={19} aria-hidden="true" />
              创建同步房间
            </button>
            <label className="field-label" htmlFor="room-code-input">房间码</label>
            <div className="join-room-row">
              <input
                id="room-code-input"
                value={roomInput}
                onChange={(event) => setRoomInput(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
                placeholder="例如 A7K9Q2"
                autoCapitalize="characters"
              />
              <button type="button" onClick={joinRoom}>加入</button>
            </div>
          </div>
        ) : (
          <div className="room-live">
            <div className="room-code-card">
              <span>ROOM CODE</span>
              <strong>{roomCode}</strong>
              <button type="button" onClick={copyShareLink} disabled={!shareUrl}>
                {copied ? <Check size={17} aria-hidden="true" /> : <Copy size={17} aria-hidden="true" />}
                {copied ? "已复制" : "复制局域网链接"}
              </button>
            </div>
            <dl className="room-stats">
              <div><dt>角色</dt><dd>{room.isLeader ? "主控设备" : "同步跟随"}</dd></div>
              <div><dt>设备</dt><dd>{room.state?.deviceCount || 1} 台</dd></div>
              <div><dt>延迟</dt><dd>{roomConnected ? `${room.latency} ms` : "—"}</dd></div>
              <div><dt>状态</dt><dd>{roomConnected ? "已同步" : "等待连接"}</dd></div>
            </dl>
            {!room.isLeader ? <p className="follower-note">进度和应用内音量由主控自动同步；系统音量仍由本机按键控制。</p> : null}
          </div>
        )}

        <details className="relay-settings">
          <summary><GearSix size={17} aria-hidden="true" />局域网中继设置</summary>
          <label><span>中继地址</span><input value={relayUrl} onChange={(event) => setRelayUrl(event.target.value)} spellCheck="false" /></label>
          <label><span>设备名称</span><input value={deviceName} onChange={(event) => setDeviceName(event.target.value.slice(0, 32))} /></label>
          <p>主机运行桌面启动脚本后，同一 Wi‑Fi 的设备使用主机 IP 即可加入。</p>
        </details>
      </aside>
      {roomPanelOpen ? <button className="drawer-scrim" type="button" onClick={() => setRoomPanelOpen(false)} aria-label="关闭同步房间" /> : null}

      <section className="player-dock" aria-label="播放控制台" inert={overlayOpen}>
        <input
          aria-label="播放进度"
          className="dock-progress"
          type="range"
          min="0"
          max={duration || 1}
          step="0.05"
          value={Math.min(progress, duration || 1)}
          disabled={!effectiveTrack || !canControl}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <div className="dock-controls">
          <div className="dock-cluster dock-track">
            <img src="/mineradio-card-art.png" width="52" height="52" alt="" />
            <div className="dock-meta">
              <strong>{effectiveTrack?.name || "还没有播放歌曲"}</strong>
              <span>{mode === "room" ? `同步房间 ${roomCode}` : "Mineradio · 本地音乐"}</span>
            </div>
            <button className={liked ? "is-active" : ""} type="button" onClick={() => setLiked((value) => !value)} aria-label={liked ? "取消喜欢" : "喜欢"}>
              <Heart size={21} weight={liked ? "fill" : "regular"} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => fileInputRef.current?.click()} aria-label="添加歌曲">
              <Plus size={20} aria-hidden="true" />
            </button>
          </div>

          <div className="dock-cluster dock-transport">
            <button type="button" disabled aria-label="循环播放">
              <ArrowsClockwise size={20} aria-hidden="true" />
            </button>
            <button type="button" disabled aria-label="上一首">
              <SkipBack size={21} weight="fill" aria-hidden="true" />
            </button>
            <button className="dock-play" type="button" onClick={togglePlayback} disabled={!effectiveTrack || !canControl} aria-label={effectivePlaying ? "暂停" : "播放"}>
              {effectivePlaying ? <Pause size={24} weight="fill" aria-hidden="true" /> : <Play size={24} weight="fill" aria-hidden="true" />}
            </button>
            <button type="button" disabled aria-label="下一首">
              <SkipForward size={21} weight="fill" aria-hidden="true" />
            </button>
            <button type="button" onClick={() => setRoomPanelOpen(true)} aria-label="当前房间">
              <List size={21} aria-hidden="true" />
            </button>
          </div>

          <div className="dock-cluster dock-modes">
            <button className={lyricsOpen ? "is-active" : ""} type="button" onClick={() => setLyricsOpen((value) => !value)} aria-label="歌词舞台">
              <span className="lyrics-glyph">词</span>
            </button>
            <label className="dock-volume">
              <SpeakerHigh size={20} aria-hidden="true" />
              <input
                aria-label="应用内音量"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={effectiveVolume}
                disabled={!canControl}
                onChange={(event) => setVolume(Number(event.target.value))}
              />
            </label>
            <button type="button" onClick={() => setRoomPanelOpen(true)} aria-label="同步设备">
              <UsersThree size={20} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => setLyricsOpen(true)} aria-label="沉浸模式">
              <CornersOut size={20} aria-hidden="true" />
            </button>
            <time>{formatTime(progress)} / {formatTime(duration)}</time>
          </div>
        </div>
      </section>

      {needsUnlock ? (
        <div className="unlock-banner" role="alert">
          <span>浏览器需要你点按一次，才能响应房间播放。</span>
          <button type="button" onClick={unlockAudio}>启用声音并追赶</button>
        </div>
      ) : null}

      {(notice || room.error) ? (
        <div className="toast" role="status">
          <MusicNotes size={18} aria-hidden="true" />
          <span>{room.error || notice}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={17} aria-hidden="true" /></button>
        </div>
      ) : null}
    </main>
  );
}
