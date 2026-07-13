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
  SlidersHorizontal,
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
import {
  AUDIO_EFFECTS,
  applyAudioEffect,
  getAudioEffect,
  type AudioEffectNodes,
  type AudioEffectPreset,
} from "../lib/audio-effects";
import type { PlaybackQuality, TrackDescriptor } from "../lib/sync-types";

type LocalTrack = TrackDescriptor & { url: string };
type AudioWindow = Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext };
type CloudPanel = "login" | "library" | "daily" | "recommend" | "search";
type MusicProvider = "netease" | "kugou";
type CloudSong = {
  id: string;
  provider?: MusicProvider;
  playKey?: string;
  name: string;
  artist: string;
  album: string;
  cover: string;
  duration: number;
  qualities?: PlaybackQuality[];
};
type CloudUser = {
  loggedIn: boolean;
  provider?: MusicProvider;
  userId?: string;
  nickname?: string;
  avatar?: string;
  vipLabel?: string;
};
type CloudHome = {
  loggedIn: boolean;
  user: CloudUser | null;
  dailySongs: CloudSong[];
};
type CloudPlaylist = {
  id: string;
  name: string;
  cover: string;
  trackCount: number;
};

const DEFAULT_VOLUME = 0.72;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const QUALITY_OPTIONS: readonly { id: PlaybackQuality; label: string; shortLabel: string; detail: string }[] = [
  { id: "jymaster", label: "超清母带", shortLabel: "母带", detail: "最高规格 · 有则优先" },
  { id: "hires", label: "高清臻音", shortLabel: "臻音", detail: "默认 · 高解析优先" },
  { id: "lossless", label: "无损 SQ", shortLabel: "SQ", detail: "FLAC 优先" },
  { id: "exhigh", label: "极高 HQ", shortLabel: "HQ", detail: "320 kbps 优先" },
  { id: "standard", label: "标准", shortLabel: "STD", detail: "128 kbps" },
];

function readPlaybackQuality(): PlaybackQuality {
  if (typeof window === "undefined") return "hires";
  const value = window.localStorage.getItem("mineradio-playback-quality-v1");
  return QUALITY_OPTIONS.some((option) => option.id === value) ? value as PlaybackQuality : "hires";
}

function readAudioEffect(): AudioEffectPreset {
  if (typeof window === "undefined") return "original";
  return getAudioEffect(window.localStorage.getItem("mineradio-audio-effect-v1")).id;
}

function parseCloudTrackId(value: string | undefined) {
  const legacy = /^cloud-([1-9]\d{0,19})$/.exec(value || "");
  if (legacy) return { provider: "netease" as const, sourceId: legacy[1], quality: "standard" as PlaybackQuality };
  const match = /^cloud-v2-(netease|kugou)-([A-Za-z0-9]+)-(jymaster|hires|lossless|exhigh|standard)$/.exec(value || "");
  if (!match) return null;
  return { provider: match[1] as MusicProvider, sourceId: match[2], quality: match[3] as PlaybackQuality };
}

function cloudTrackPath(provider: MusicProvider, sourceId: string, quality: PlaybackQuality) {
  return `/api/cloud/v2/${provider}/${sourceId}/${quality}`;
}

function cloudStreamPath(provider: MusicProvider, sourceId: string, quality: PlaybackQuality) {
  const params = new URLSearchParams({ provider, id: sourceId, quality });
  return `/api/stream?${params.toString()}`;
}

function qualityShortLabel(quality: PlaybackQuality, provider?: MusicProvider) {
  if (provider === "kugou" && quality === "hires") return "HiRes";
  return QUALITY_OPTIONS.find((option) => option.id === quality)?.shortLabel || "臻音";
}

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

function defaultMusicApiUrl() {
  if (typeof window === "undefined") return "http://localhost:8790";
  const saved = window.localStorage.getItem("mineradio-lan-settings-v1");
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as { musicApiUrl?: string };
      if (parsed.musicApiUrl) return parsed.musicApiUrl;
    } catch {
      // Ignore stale settings and fall back to the current host.
    }
  }
  if (window.location.protocol === "https:") return window.location.origin;
  return `http://${window.location.hostname}:8790`;
}

async function requestCloud<T>(baseUrl: string, pathname: string, signal?: AbortSignal) {
  const endpoint = new URL(pathname, `${baseUrl.replace(/\/+$/, "")}/`);
  const response = await fetch(endpoint, { signal });
  const value = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(value.error || `HTTP_${response.status}`);
  return value;
}

function cloudErrorMessage(error: unknown) {
  const code = error instanceof Error ? error.message : "third_party_unavailable";
  if (code === "third_party_timeout" || code === "provider_timeout") return "第三方音乐服务响应超时，请稍后重试。";
  if (code === "origin_not_allowed") return "音乐接口拒绝了当前网页地址，请从启动窗口显示的局域网网址打开。";
  if (code === "track_unavailable") return "该歌曲暂时没有可用音源，可能受版权或会员限制。";
  if (code === "kugou_login_required") return "请先登录酷狗音乐，再尝试播放这首歌曲。";
  if (code === "track_key_expired") return "该酷狗播放标识已过期，请重新打开歌单选择歌曲。";
  return "无法连接第三方音乐接口。请确认桌面启动窗口中的 Music API 已在 8790 端口运行。";
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
  const [mode, setMode] = useState<"solo" | "room">("solo");
  const [roomCode, setRoomCode] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [relayUrl, setRelayUrl] = useState("ws://localhost:8787/ws");
  const [musicApiUrl, setMusicApiUrl] = useState("http://localhost:8790");
  const [deviceName, setDeviceName] = useState("网页设备");
  const [localTrack, setLocalTrack] = useState<LocalTrack | null>(null);
  const [soloPlaying, setSoloPlaying] = useState(false);
  const [soloVolume, setSoloVolume] = useState(DEFAULT_VOLUME);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState("");
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [copied, setCopied] = useState(false);
  const [roomPanelOpen, setRoomPanelOpen] = useState(false);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [liked, setLiked] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [legacyPanel, setLegacyPanel] = useState<CloudPanel | null>(null);
  const [loginProvider, setLoginProvider] = useState<MusicProvider>("netease");
  const [cloudSongs, setCloudSongs] = useState<CloudSong[]>([]);
  const [cloudPlaylists, setCloudPlaylists] = useState<CloudPlaylist[]>([]);
  const [cloudPlaylistName, setCloudPlaylistName] = useState("");
  const [cloudUser, setCloudUser] = useState<CloudUser | null>(null);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudError, setCloudError] = useState("");
  const [cloudStatus, setCloudStatus] = useState("");
  const [cloudQrImage, setCloudQrImage] = useState("");
  const [cloudQrKey, setCloudQrKey] = useState("");
  const [cloudRefresh, setCloudRefresh] = useState(0);
  const [playbackQuality, setPlaybackQualityState] = useState<PlaybackQuality>("hires");
  const [audioEffect, setAudioEffect] = useState<AudioEffectPreset>("original");
  const [qualityOpen, setQualityOpen] = useState(false);
  const [audioEffectOpen, setAudioEffectOpen] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const effectNodesRef = useRef<AudioEffectNodes | null>(null);
  const volumeGainRef = useRef<GainNode | null>(null);
  const playbackVolumeRef = useRef(DEFAULT_VOLUME);
  const audioEffectRef = useRef<AudioEffectPreset>(audioEffect);
  const resumeAfterSourceChangeRef = useRef<{ position: number; playing: boolean; source: string } | null>(null);
  const settingsHydratedRef = useRef(false);
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
  const effectiveQuality = effectiveTrack?.quality || playbackQuality;
  const canControl = mode === "solo" || roomIsLeader;
  const roomConnected = room.status === "connected";
  const audioSource = useMemo(() => {
    if (!effectiveTrack) return "";
    if (mode === "solo") return localTrack?.url || "";
    if (!room.httpBase) return "";
    return new URL(effectiveTrack.path, room.httpBase).toString();
  }, [effectiveTrack, localTrack?.url, mode, room.httpBase]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const initialRoom = roomFromUrl();
      setMode(initialRoom ? "room" : "solo");
      setRoomCode(initialRoom);
      setRoomInput(initialRoom);
      setRoomPanelOpen(Boolean(initialRoom));
      setRelayUrl(defaultRelayUrl());
      setMusicApiUrl(defaultMusicApiUrl());
      setDeviceName(defaultDeviceName());
      setPlaybackQualityState(readPlaybackQuality());
      setAudioEffect(readAudioEffect());
      settingsHydratedRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!settingsHydratedRef.current) return;
    window.localStorage.setItem(
      "mineradio-lan-settings-v1",
      JSON.stringify({ relayUrl, musicApiUrl, version: 2 }),
    );
  }, [musicApiUrl, relayUrl]);

  useEffect(() => {
    if (!legacyPanel) return;
    const controller = new AbortController();

    const load = async () => {
      setCloudLoading(true);
      setCloudError("");
      setCloudStatus("");
      setCloudSongs([]);
      setCloudPlaylists([]);
      setCloudPlaylistName("");
      setCloudQrImage("");
      setCloudQrKey("");
      try {
        if (legacyPanel === "search") {
          const query = searchText.trim();
          if (!query) throw new Error("keywords_required");
          const result = await requestCloud<{ songs: CloudSong[] }>(
            musicApiUrl,
            `/api/search?keywords=${encodeURIComponent(query)}&limit=18`,
            controller.signal,
          );
          setCloudSongs(result.songs || []);
          setCloudStatus(result.songs?.length ? `找到 ${result.songs.length} 首歌曲` : "没有找到匹配的歌曲");
          return;
        }

        if (legacyPanel === "library") {
          const status = await requestCloud<CloudUser>(musicApiUrl, "/api/kugou/login/status", controller.signal);
          setCloudUser(status);
          if (!status.loggedIn) {
            setCloudStatus("登录酷狗音乐后可同步你的云端歌单");
            return;
          }
          const result = await requestCloud<CloudUser & { playlists: CloudPlaylist[] }>(
            musicApiUrl,
            "/api/kugou/user/playlists",
            controller.signal,
          );
          setCloudUser(result);
          setCloudPlaylists(result.playlists || []);
          setCloudStatus(result.playlists?.length ? `已同步 ${result.playlists.length} 个酷狗歌单` : "账号内暂时没有可用歌单");
          return;
        }

        if (legacyPanel === "daily" || legacyPanel === "recommend") {
          const result = await requestCloud<CloudHome>(musicApiUrl, "/api/discover/home", controller.signal);
          setCloudUser(result.user);
          setCloudSongs(result.dailySongs || []);
          setCloudStatus(result.loggedIn ? "推荐已从第三方音乐服务同步" : "登录后可读取你的每日推荐");
          return;
        }

        const isKugou = loginProvider === "kugou";
        const status = await requestCloud<CloudUser>(
          musicApiUrl,
          isKugou ? "/api/kugou/login/status" : "/api/login/status",
          controller.signal,
        );
        setCloudUser(status);
        if (status.loggedIn) {
          setCloudStatus(`已登录${status.nickname ? ` · ${status.nickname}` : ""}`);
          return;
        }
        const keyResult = await requestCloud<{ key: string; img?: string }>(
          musicApiUrl,
          isKugou ? "/api/kugou/login/qr/key" : "/api/login/qr/key",
          controller.signal,
        );
        const qrResult = isKugou
          ? keyResult
          : await requestCloud<{ img: string }>(
              musicApiUrl,
              `/api/login/qr/create?key=${encodeURIComponent(keyResult.key)}`,
              controller.signal,
            );
        setCloudQrKey(keyResult.key);
        setCloudQrImage(qrResult.img || "");
        setCloudStatus(`请使用${isKugou ? "酷狗音乐" : "网易云音乐"} App 扫码，并在手机上确认登录`);
      } catch (error) {
        if (!controller.signal.aborted) setCloudError(cloudErrorMessage(error));
      } finally {
        if (!controller.signal.aborted) setCloudLoading(false);
      }
    };

    void load();
    return () => controller.abort();
  }, [cloudRefresh, legacyPanel, loginProvider, musicApiUrl, searchText]);

  useEffect(() => {
    if (legacyPanel !== "login" || !cloudQrKey || cloudUser?.loggedIn) return;
    let stopped = false;
    let timer = 0;

    const poll = async () => {
      try {
        const isKugou = loginProvider === "kugou";
        const result = await requestCloud<CloudUser & { code: number; message?: string }>(
          musicApiUrl,
          `${isKugou ? "/api/kugou/login/qr/check" : "/api/login/qr/check"}?key=${encodeURIComponent(cloudQrKey)}`,
        );
        if (stopped) return;
        if (result.code === 803) {
          setCloudQrImage("");
          setCloudQrKey("");
          if (result.loggedIn) {
            setCloudUser(result);
            setCloudStatus(isKugou ? "酷狗登录成功，云歌单现在可以使用。" : "登录成功，云端推荐现在可以使用。");
          } else {
            setCloudUser({ loggedIn: false });
            setCloudError(isKugou
              ? "手机已确认扫码，但酷狗没有返回可用登录凭证。请刷新二维码后重试。"
              : "手机已确认扫码，但暂时无法读取账号状态。请刷新二维码后重试。");
          }
          return;
        }
        if (result.code === 802) setCloudStatus("二维码已扫描，请在手机上确认登录");
        else if (result.code === 800) {
          setCloudQrImage("");
          setCloudQrKey("");
          setCloudError("二维码已过期，请刷新后重试。");
          return;
        }
      } catch (error) {
        if (!stopped) setCloudError(cloudErrorMessage(error));
        return;
      }
      if (!stopped) timer = window.setTimeout(poll, 2200);
    };

    timer = window.setTimeout(poll, 2200);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [cloudQrKey, cloudUser?.loggedIn, legacyPanel, loginProvider, musicApiUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    if (audioSource) audio.src = audioSource;
    audio.load();
    setProgress(resumeAfterSourceChangeRef.current?.position || 0);
    setDuration(0);
  }, [audioSource]);

  const ensureAudioGraph = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return false;
    const Context = window.AudioContext || (window as AudioWindow).webkitAudioContext;
    if (!Context) return false;
    if (!audioContextRef.current) audioContextRef.current = new Context();
    const context = audioContextRef.current;
    if (!sourceCreatedRef.current) {
      const source = context.createMediaElementSource(audio);
      const low = context.createBiquadFilter();
      low.type = "lowshelf";
      low.frequency.value = 120;
      const presence = context.createBiquadFilter();
      presence.type = "peaking";
      presence.frequency.value = 1_800;
      presence.Q.value = 0.8;
      const high = context.createBiquadFilter();
      high.type = "highshelf";
      high.frequency.value = 7_000;
      const compressor = context.createDynamicsCompressor();
      compressor.attack.value = 0.012;
      compressor.release.value = 0.24;
      const output = context.createGain();
      const volume = context.createGain();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.78;
      source.connect(low);
      low.connect(presence);
      presence.connect(high);
      high.connect(compressor);
      compressor.connect(output);
      output.connect(volume);
      volume.connect(analyser);
      analyser.connect(context.destination);
      const nodes = { low, presence, high, compressor, output };
      applyAudioEffect(nodes, audioEffectRef.current, context.currentTime);
      volume.gain.value = playbackVolumeRef.current;
      audio.volume = 1;
      effectNodesRef.current = nodes;
      volumeGainRef.current = volume;
      analyserRef.current = analyser;
      sourceCreatedRef.current = true;
    }
    if (context.state === "suspended") await context.resume();
    return true;
  }, []);

  useEffect(() => {
    audioEffectRef.current = audioEffect;
    const context = audioContextRef.current;
    const nodes = effectNodesRef.current;
    if (context && nodes) applyAudioEffect(nodes, audioEffect, context.currentTime);
  }, [audioEffect]);

  useEffect(() => {
    const value = Math.max(0, Math.min(effectiveVolume, 1));
    playbackVolumeRef.current = value;
    const audio = audioRef.current;
    const context = audioContextRef.current;
    const volume = volumeGainRef.current;
    if (context && volume) {
      if (audio) audio.volume = 1;
      volume.gain.cancelScheduledValues(context.currentTime);
      volume.gain.setTargetAtTime(value, context.currentTime, 0.025);
    } else if (audio) {
      audio.volume = value;
    }
  }, [effectiveVolume]);

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
    const updateDuration = () => {
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    };
    const onLoadedMetadata = () => {
      updateDuration();
      const resume = resumeAfterSourceChangeRef.current;
      if (!resume || !Number.isFinite(audio.duration)) return;
      resumeAfterSourceChangeRef.current = null;
      if (audio.currentSrc !== resume.source) return;
      audio.currentTime = Math.min(resume.position, Math.max(0, audio.duration - 0.05));
      setProgress(audio.currentTime);
      if (resume.playing) {
        void audio.play().then(() => setSoloPlaying(true)).catch(() => {
          setSoloPlaying(false);
          setNotice("音质已切换；请点击播放继续。");
        });
      }
    };
    const onEnded = () => {
      if (mode === "solo") setSoloPlaying(false);
      else if (roomIsLeader) sendRoomCommand({ action: "pause" });
    };
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("durationchange", updateDuration);
    audio.addEventListener("ended", onEnded);
    frame = requestAnimationFrame(update);
    return () => {
      cancelAnimationFrame(frame);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("durationchange", updateDuration);
      audio.removeEventListener("ended", onEnded);
    };
  }, [mode, roomIsLeader, sendRoomCommand]);

  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const context = audioContextRef.current;
      audioContextRef.current = null;
      analyserRef.current = null;
      effectNodesRef.current = null;
      volumeGainRef.current = null;
      if (context && context.state !== "closed") void context.close().catch(() => {});
    },
    [],
  );

  const togglePlayback = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !effectiveTrack || !canControl) return;
    try {
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
    } catch {
      setSoloPlaying(false);
      setNotice("浏览器无法开始播放，请检查媒体权限，或尝试另一首歌曲。");
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
      resumeAfterSourceChangeRef.current = null;
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

  const loadKugouPlaylist = useCallback(async (playlist: CloudPlaylist) => {
    setCloudLoading(true);
    setCloudError("");
    try {
      const result = await requestCloud<{ tracks: CloudSong[] }>(
        musicApiUrl,
        `/api/kugou/playlist/tracks?id=${encodeURIComponent(playlist.id)}`,
      );
      setCloudSongs(result.tracks || []);
      setCloudPlaylistName(playlist.name);
      setCloudStatus(result.tracks?.length ? `${playlist.name} · ${result.tracks.length} 首` : `${playlist.name} 暂无可播放歌曲`);
    } catch (error) {
      setCloudError(cloudErrorMessage(error));
    } finally {
      setCloudLoading(false);
    }
  }, [musicApiUrl]);

  const selectCloudSong = useCallback((song: CloudSong) => {
    resumeAfterSourceChangeRef.current = null;
    const provider = song.provider === "kugou" ? "kugou" : "netease";
    const sourceId = provider === "kugou" ? String(song.playKey || song.id) : String(song.id);
    const quality = playbackQuality;
    const track: TrackDescriptor = {
      id: `cloud-v2-${provider}-${sourceId}-${quality}`,
      name: song.artist ? `${song.name} · ${song.artist}` : song.name,
      type: "audio/mpeg",
      size: 0,
      path: cloudTrackPath(provider, sourceId, quality),
      provider,
      quality,
    };
    if (mode === "room") {
      if (!roomConnected || !roomIsLeader) {
        setNotice("请等待房间连接；只有主控设备可以更换在线歌曲。");
        return;
      }
      sendRoomCommand({ action: "track", track });
      setNotice("在线歌曲已送入同步房间，所有设备将从同一受限音频代理加载。");
    } else {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = "";
      setLocalTrack({
        ...track,
        url: `${musicApiUrl.replace(/\/+$/, "")}${cloudStreamPath(provider, sourceId, quality)}`,
      });
      setSoloPlaying(false);
      setNotice("已从第三方音乐接口加载歌曲，点击播放即可开始。");
    }
    setLegacyPanel(null);
  }, [mode, musicApiUrl, playbackQuality, roomConnected, roomIsLeader, sendRoomCommand]);

  const changePlaybackQuality = useCallback((quality: PlaybackQuality) => {
    setPlaybackQualityState(quality);
    window.localStorage.setItem("mineradio-playback-quality-v1", quality);
    setQualityOpen(false);
    const cloud = parseCloudTrackId(effectiveTrack?.id);
    const label = QUALITY_OPTIONS.find((option) => option.id === quality)?.label || quality;
    if (!cloud) {
      setNotice(`音质偏好已设为 ${label}，下次播放在线歌曲时生效。`);
      return;
    }
    if (mode === "room") {
      if (!roomIsLeader) {
        setNotice("音质由房间主控设备统一切换。");
        return;
      }
      sendRoomCommand({ action: "quality", quality });
      setNotice(`正在为房间切换到 ${label}，所有设备会从当前进度续播。`);
      return;
    }
    const audio = audioRef.current;
    const source = `${musicApiUrl.replace(/\/+$/, "")}${cloudStreamPath(cloud.provider, cloud.sourceId, quality)}`;
    resumeAfterSourceChangeRef.current = {
      position: audio?.currentTime || 0,
      playing: Boolean(audio && !audio.paused),
      source,
    };
    setLocalTrack((current) => current ? {
      ...current,
      id: `cloud-v2-${cloud.provider}-${cloud.sourceId}-${quality}`,
      path: cloudTrackPath(cloud.provider, cloud.sourceId, quality),
      provider: cloud.provider,
      quality,
      url: source,
    } : current);
    setNotice(`正在切换到 ${label}，可用档位由账号与版权权限决定。`);
  }, [effectiveTrack?.id, mode, musicApiUrl, roomIsLeader, sendRoomCommand]);

  const logoutCloud = useCallback(async () => {
    setCloudLoading(true);
    setCloudError("");
    try {
      await requestCloud<{ ok: boolean }>(musicApiUrl, loginProvider === "kugou" ? "/api/kugou/logout" : "/api/logout");
      setCloudUser({ loggedIn: false });
      setCloudStatus("已退出登录，账号凭证已从本机清除。");
      setCloudRefresh((value) => value + 1);
    } catch (error) {
      setCloudError(cloudErrorMessage(error));
    } finally {
      setCloudLoading(false);
    }
  }, [loginProvider, musicApiUrl]);

  const onSearchSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!searchText.trim()) {
      setNotice("请输入歌曲或歌手名称后再搜索。");
      return;
    }
    setLegacyPanel("search");
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

  useEffect(() => {
    if (!overlayOpen) return;
    const frame = window.requestAnimationFrame(() => {
      setQualityOpen(false);
      setAudioEffectOpen(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [overlayOpen]);

  const handleHomeCardAction = useCallback((action: "library" | "file" | "daily" | "recommend" | "play" | "profile") => {
    if (action === "file") fileInputRef.current?.click();
    else if (action === "library") setLegacyPanel("library");
    else if (action === "daily") setLegacyPanel("daily");
    else if (action === "recommend") setLegacyPanel("recommend");
    else if (action === "play") void togglePlayback();
    else setNotice("听歌画像将在积累更多本地播放记录后生成。");
  }, [togglePlayback]);

  const homeCards = [
    {
      label: "LIBRARY",
      title: "我的歌单",
      sub: "同步酷狗账号内的云歌单",
      tone: "mint",
      action: "library" as const,
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
      <audio
        ref={audioRef}
        crossOrigin="anonymous"
        preload="metadata"
        onError={() => {
          resumeAfterSourceChangeRef.current = null;
          if (mode === "solo") setSoloPlaying(false);
          if (audioSource) setNotice("音源加载失败，歌曲可能受版权、会员或网络限制。请尝试另一首。");
        }}
      />
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
          <button type="submit" aria-label="调用第三方音乐接口搜索">
            <MagnifyingGlass size={18} aria-hidden="true" />
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
          <button className="legacy-scrim" type="button" onClick={() => setLegacyPanel(null)} aria-label="关闭云端音乐面板" />
          <section className="legacy-modal cloud-modal" role="dialog" aria-modal="true" aria-labelledby="legacy-title">
            <button type="button" onClick={() => setLegacyPanel(null)} aria-label="关闭云端音乐面板"><X size={20} aria-hidden="true" /></button>
            <span>MINERADIO CLOUD · LOCAL RESTRICTED ADAPTER</span>
            <h2 id="legacy-title">
              {legacyPanel === "login"
                ? "登录"
                : legacyPanel === "library"
                  ? cloudPlaylistName || "我的酷狗歌单"
                : legacyPanel === "daily"
                  ? "每日推荐"
                  : legacyPanel === "recommend"
                    ? "推荐歌曲"
                    : `搜索“${searchText.trim()}”`}
            </h2>
            <p>
              {legacyPanel === "login"
                ? "扫码登录由本机第三方适配服务完成；账号 Cookie 只保存在这台电脑，不会发送到浏览器或同步房间。"
                : legacyPanel === "library"
                  ? "酷狗账号和高音质权限沿用原平台规则；浏览器只接收歌单资料与受限播放标识，不接收账号 token 或真实音源地址。"
                : legacyPanel === "search"
                  ? "搜索结果来自第三方网易云兼容接口；可直接加载到本机或当前局域网同步房间。"
                  : "云端推荐从第三方音乐服务读取；在线音源仍会经过受限代理，真实地址不会进入房间状态。"}
            </p>

            {legacyPanel === "login" ? (
              <div className="provider-tabs" role="tablist" aria-label="选择音乐平台">
                <button
                  className={loginProvider === "netease" ? "is-active" : ""}
                  type="button"
                  role="tab"
                  aria-selected={loginProvider === "netease"}
                  onClick={() => setLoginProvider("netease")}
                >网易云音乐</button>
                <button
                  className={loginProvider === "kugou" ? "is-active" : ""}
                  type="button"
                  role="tab"
                  aria-selected={loginProvider === "kugou"}
                  onClick={() => setLoginProvider("kugou")}
                >酷狗音乐</button>
              </div>
            ) : null}

            {cloudLoading ? (
              <div className="legacy-state is-loading" role="status">
                <ArrowsClockwise size={20} aria-hidden="true" />
                <span>正在连接第三方音乐服务…</span>
              </div>
            ) : null}

            {cloudError ? (
              <div className="cloud-error" role="alert">
                <span>{cloudError}</span>
                <button type="button" onClick={() => setCloudRefresh((value) => value + 1)}>重试</button>
              </div>
            ) : null}

            {!cloudLoading && !cloudError && legacyPanel === "login" ? (
              cloudUser?.loggedIn ? (
                <div className="cloud-profile">
                  <img src={cloudUser.avatar || "/mineradio-card-art.png"} width="72" height="72" alt="" />
                  <div>
                    <small>{loginProvider === "kugou" ? "酷狗音乐账号" : "网易云账号"}{cloudUser.vipLabel ? ` · ${cloudUser.vipLabel}` : ""}</small>
                    <strong>{cloudUser.nickname || "已登录用户"}</strong>
                  </div>
                  <button type="button" onClick={() => void logoutCloud()}>退出登录</button>
                </div>
              ) : (
                <div className="cloud-login">
                  {cloudQrImage ? <img className="cloud-qr" src={cloudQrImage} width="190" height="190" alt={`${loginProvider === "kugou" ? "酷狗音乐" : "网易云音乐"}扫码登录二维码`} /> : null}
                  <span>{cloudStatus || "正在生成登录二维码…"}</span>
                </div>
              )
            ) : null}

            {!cloudLoading && !cloudError && legacyPanel !== "login" ? (
              legacyPanel !== "search" && !cloudUser?.loggedIn ? (
                <div className="cloud-empty">
                  <strong>需要先登录</strong>
                  <span>{cloudStatus || (legacyPanel === "library" ? "酷狗云歌单与账号关联。" : "每日推荐与账号偏好相关。")}</span>
                  <button type="button" onClick={() => {
                    if (legacyPanel === "library") setLoginProvider("kugou");
                    setLegacyPanel("login");
                  }}>扫码登录</button>
                </div>
              ) : (
                <>
                  {cloudStatus ? <div className="cloud-result-status">{cloudStatus}</div> : null}
                  {legacyPanel === "library" && !cloudPlaylistName ? (
                    <div className="cloud-playlist-list" role="list">
                      {cloudPlaylists.map((playlist) => (
                        <button type="button" onClick={() => void loadKugouPlaylist(playlist)} key={playlist.id}>
                          <img src={playlist.cover || "/mineradio-card-art.png"} width="54" height="54" alt="" />
                          <span><strong>{playlist.name}</strong><small>{playlist.trackCount} 首 · 酷狗音乐</small></span>
                          <CaretLeft className="playlist-enter" size={17} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <>
                      {legacyPanel === "library" && cloudPlaylistName ? (
                        <button className="cloud-list-back" type="button" onClick={() => {
                          setCloudSongs([]);
                          setCloudPlaylistName("");
                          setCloudStatus(`已同步 ${cloudPlaylists.length} 个酷狗歌单`);
                        }}><CaretLeft size={16} aria-hidden="true" />返回歌单</button>
                      ) : null}
                      <div className="cloud-song-list" role="list">
                        {cloudSongs.map((song) => (
                          <button type="button" onClick={() => selectCloudSong(song)} key={`${song.provider || "netease"}:${song.id}`}>
                            <img src={song.cover || "/mineradio-card-art.png"} width="54" height="54" alt="" />
                            <span><strong>{song.name}</strong><small>{[song.artist, song.album].filter(Boolean).join(" · ") || (song.provider === "kugou" ? "酷狗音乐" : "网易云音乐")}</small></span>
                            <time>{formatTime(song.duration / 1000)}</time>
                            <Play size={17} weight="fill" aria-hidden="true" />
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )
            ) : null}

            <div className="cloud-modal-footer">
              <small>本机接口 {musicApiUrl.replace(/^https?:\/\//, "")}</small>
              <button className="legacy-close" type="button" onClick={() => setLegacyPanel(null)}>返回音乐库</button>
            </div>
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
            <p>房间内会自动同步歌曲、音质、播放状态、进度与应用内音量；本机音色按设备单独保留。</p>
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
            {!room.isLeader ? <p className="follower-note">音质、进度和应用内音量由主控自动同步；本机音色与系统音量仍由当前设备控制。</p> : null}
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
            <div className={`dock-setting quality-setting ${qualityOpen ? "is-open" : ""}`}>
              <button
                className="quality-pill"
                type="button"
                aria-label={`音质：${qualityShortLabel(effectiveQuality, effectiveTrack?.provider)}`}
                aria-expanded={qualityOpen}
                onClick={() => {
                  setQualityOpen((value) => !value);
                  setAudioEffectOpen(false);
                }}
              >{qualityShortLabel(effectiveQuality, effectiveTrack?.provider)}</button>
              <div className="dock-setting-popover quality-popover" role="menu" aria-label="播放音质">
                <span>播放音质</span>
                {QUALITY_OPTIONS.map((option) => (
                  <button
                    className={effectiveQuality === option.id ? "is-active" : ""}
                    type="button"
                    role="menuitemradio"
                    aria-checked={effectiveQuality === option.id}
                    disabled={mode === "room" && !canControl}
                    onClick={() => changePlaybackQuality(option.id)}
                    key={option.id}
                  ><strong>{effectiveTrack?.provider === "kugou" && option.id === "hires" ? "Hi-Res" : option.label}</strong><small>{option.detail}</small></button>
                ))}
                <p>实际档位由平台、账号与版权权限决定。</p>
              </div>
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
            <div className={`dock-setting quality-setting mobile-quality-setting ${qualityOpen ? "is-open" : ""}`}>
              <button
                className="quality-pill"
                type="button"
                aria-label={`音质：${qualityShortLabel(effectiveQuality, effectiveTrack?.provider)}`}
                aria-expanded={qualityOpen}
                onClick={() => {
                  setQualityOpen((value) => !value);
                  setAudioEffectOpen(false);
                }}
              >{qualityShortLabel(effectiveQuality, effectiveTrack?.provider)}</button>
              <div className="dock-setting-popover quality-popover" role="menu" aria-label="播放音质">
                <span>播放音质</span>
                {QUALITY_OPTIONS.map((option) => (
                  <button
                    className={effectiveQuality === option.id ? "is-active" : ""}
                    type="button"
                    role="menuitemradio"
                    aria-checked={effectiveQuality === option.id}
                    disabled={mode === "room" && !canControl}
                    onClick={() => changePlaybackQuality(option.id)}
                    key={option.id}
                  ><strong>{option.label}</strong><small>{option.detail}</small></button>
                ))}
                <p>实际档位由平台、账号与版权权限决定。</p>
              </div>
            </div>
            <div className={`dock-setting effect-setting ${audioEffectOpen ? "is-open" : ""}`}>
              <button
                className={audioEffect !== "original" ? "is-active" : ""}
                type="button"
                onClick={() => {
                  setAudioEffectOpen((value) => !value);
                  setQualityOpen(false);
                }}
                aria-label={`本机音色：${getAudioEffect(audioEffect).label}`}
                aria-expanded={audioEffectOpen}
              ><SlidersHorizontal size={20} aria-hidden="true" /></button>
              <div className="dock-setting-popover effect-popover" role="menu" aria-label="本机音色预设">
                <span>本机音色 · 不随房间同步</span>
                {AUDIO_EFFECTS.map((effect) => (
                  <button
                    className={audioEffect === effect.id ? "is-active" : ""}
                    type="button"
                    role="menuitemradio"
                    aria-checked={audioEffect === effect.id}
                    onClick={() => {
                      audioEffectRef.current = effect.id;
                      setAudioEffect(effect.id);
                      window.localStorage.setItem("mineradio-audio-effect-v1", effect.id);
                      setAudioEffectOpen(false);
                      void ensureAudioGraph().then((enabled) => {
                        setNotice(enabled
                          ? `本机音色已切换为 ${effect.label}。`
                          : `已保存 ${effect.label}；当前浏览器不支持 Web Audio 音色处理。`);
                      }).catch(() => {
                        setNotice(`已保存 ${effect.label}；请先允许浏览器播放声音后再启用音色。`);
                      });
                    }}
                    key={effect.id}
                  ><strong>{effect.label}</strong><small>{effect.description}</small></button>
                ))}
                <p>这是本机 Web Audio 处理，不是平台官方音效。</p>
              </div>
            </div>
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
            <button className="dock-device-button" type="button" onClick={() => setRoomPanelOpen(true)} aria-label="同步设备">
              <UsersThree size={20} aria-hidden="true" />
            </button>
            <button className="dock-immersive-button" type="button" onClick={() => setLyricsOpen(true)} aria-label="沉浸模式">
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

      {(notice || room.error) && !legacyPanel ? (
        <div className="toast" role="status">
          <MusicNotes size={18} aria-hidden="true" />
          <span>{room.error || notice}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={17} aria-hidden="true" /></button>
        </div>
      ) : null}
    </main>
  );
}
