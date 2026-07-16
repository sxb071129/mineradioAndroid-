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
  Shuffle,
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
  useReducer,
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
import {
  createQueueState,
  deserializeQueueState,
  getCurrentTrack,
  queueReducer,
  serializeQueueState,
  type QueueAction,
  type QueueState,
  type RepeatMode,
} from "../lib/player-queue.mjs";
import { preferredLanHost } from "../lib/lan-address.mjs";
import { playbackCorrection } from "../lib/room-sync-timing.mjs";
import type { PlaybackQuality, TrackDescriptor } from "../lib/sync-types";

type LocalTrack = TrackDescriptor & {
  url: string;
  sourceId?: string;
  cover?: string;
};
type PlayerQueueAction = QueueAction<LocalTrack>
  | { type: "hydrate"; state: QueueState<LocalTrack> }
  | { type: "update-track"; index: number; track: LocalTrack };
type AudioWindow = Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext };
type RoomControlThrottle = {
  lastSentAt: number;
  pending: number | null;
  timer: ReturnType<typeof setTimeout> | null;
};
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
  hasLocalSession?: boolean;
  accountValidated?: boolean;
  validationState?: "unvalidated" | "valid" | "stale" | "unavailable";
  deviceRegistered?: boolean;
  deviceRegistrationState?: "unregistered" | "registered" | "failed";
  playbackReady?: boolean;
  restrictionCode?: string;
};
type KugouRestriction = {
  category?: string;
  code?: number;
  action?: string;
  message?: string;
};
type KugouPrepareResponse = {
  playable?: boolean;
  provider?: string;
  trackRef?: string;
  requestedQuality?: string;
  resolvedQuality?: string | null;
  attemptId?: string;
  streamPath?: string;
  restriction?: KugouRestriction | null;
  error?: string;
};
type KugouPrepareOutcome =
  | { kind: "prepared"; source: string; resolvedQuality: PlaybackQuality }
  | { kind: "legacy" }
  | { kind: "failed"; code: string };
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
const PLAYER_QUEUE_STORAGE_KEY = "mineradio-player-queue-v2";
const LIKED_TRACKS_STORAGE_KEY = "mineradio-liked-tracks-v1";
const ROOM_CONTROL_THROTTLE_MS = 80;
const REPEAT_LABELS: Record<RepeatMode, string> = {
  off: "循环关闭",
  all: "列表循环",
  one: "单曲循环",
};
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

async function copyTextWithFallback(value: string) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Plain HTTP LAN pages use the selection fallback below.
    }
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.readOnly = true;
  input.style.position = "fixed";
  input.style.left = "-9999px";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  input.setSelectionRange(0, input.value.length);
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("copy_failed");
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

const KUGOU_COMPATIBILITY_NOTICE = "当前 Music API 版本较旧，已切换兼容播放模式；建议更新桌面服务。";

function kugouRecoveryMessage(code: string) {
  if (code === "login_required" || code === "kugou_login_required") return "请先登录酷狗音乐，再重新选择这首歌曲。";
  if (code === "stale_session") return "酷狗登录会话已失效，请重新扫码登录后再试。";
  if (code === "device_registration_failed") return "酷狗设备注册失败，播放尚未就绪；请重试登录或稍后再试。";
  if (code === "paid_required" || code === "track_trial_only") return "当前账号没有这首歌曲所需的会员或付费播放权限。";
  if (code === "copyright_unavailable" || code === "track_unavailable") return "该歌曲因版权限制暂时无法播放。";
  if (code === "region_restricted") return "该歌曲在当前地区不可播放。";
  if (code === "quality_unavailable") return "当前音质不可用，请选择其他音质后重试。";
  if (code === "stream_host_rejected") return "酷狗返回了不受信任的音源地址，已阻止播放。";
  if (code === "provider_contract_changed") return "酷狗播放接口已变化，当前 Music API 暂时无法解析；请更新服务后重试。";
  if (code === "provider_unavailable") return "酷狗音乐服务暂时不可用，请稍后重试。";
  if (code === "track_key_expired") return "该酷狗播放标识已过期，请重新打开歌单选择歌曲。";
  if (
    code === "provider_stream_failed"
    || code === "third_party_timeout"
    || code === "provider_timeout"
    || code === "third_party_unavailable"
    || code === "music_api_unavailable"
    || code === "network_error"
  ) return "酷狗音源或网络暂时不可用，请检查 Music API 和网络后重试。";
  return "这首酷狗歌曲暂时无法播放，请稍后重试或选择其他歌曲。";
}

function isPlaybackQuality(value: unknown): value is PlaybackQuality {
  return typeof value === "string" && QUALITY_OPTIONS.some((option) => option.id === value);
}

function validKugouStreamPath(
  value: unknown,
  trackRef: string,
  requestedQuality: PlaybackQuality,
  baseUrl: string,
) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "";
  try {
    const base = new URL(`${baseUrl.replace(/\/+$/, "")}/`);
    const stream = new URL(value, base);
    const match = /^\/api\/v2\/stream\/([a-f0-9]{24})$/.exec(stream.pathname);
    if (!/^https?:$/.test(base.protocol) || base.username || base.password) return "";
    if (stream.origin !== base.origin || match?.[1] !== trackRef || stream.hash) return "";
    const qualities = stream.searchParams.getAll("quality");
    if (
      qualities.length !== 1
      || qualities[0] !== requestedQuality
      || Array.from(stream.searchParams.keys()).some((key) => key !== "quality")
    ) return "";
    return stream.toString();
  } catch {
    return "";
  }
}

function kugouAccountStatus(user: CloudUser) {
  if (user.validationState === "stale" || user.restrictionCode === "stale_session") {
    return "本机保存了酷狗会话，但登录已失效，请重新扫码登录。";
  }
  if (user.deviceRegistrationState === "failed" || user.restrictionCode === "device_registration_failed") {
    return "酷狗设备注册未完成；播放器仍会直接使用本机会话尝试播放。";
  }
  if (user.hasLocalSession && !user.accountValidated) return "酷狗会话已保存；播放时会继续确认账号与歌曲权限。";
  if (user.hasLocalSession && !user.playbackReady) return "酷狗已登录，但播放环境尚未就绪。";
  return "";
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

function hasBufferedPlaybackWindow(audio: HTMLAudioElement, target: number) {
  const requiredEnd = Number.isFinite(audio.duration)
    ? Math.min(audio.duration, target + 1.2)
    : target + 1.2;
  for (let index = 0; index < audio.buffered.length; index += 1) {
    if (audio.buffered.start(index) <= target + 0.08
      && audio.buffered.end(index) >= requiredEnd - 0.05) return true;
  }
  return false;
}

function updateRoomInUrl(room: string) {
  const url = new URL(window.location.href);
  if (room) url.searchParams.set("room", room);
  else url.searchParams.delete("room");
  window.history.replaceState({}, "", url);
}

function playerQueueReducer(state: QueueState<LocalTrack>, action: PlayerQueueAction) {
  if (action.type === "hydrate") return createQueueState(action.state);
  if (action.type === "update-track") {
    if (action.index < 0 || action.index >= state.queue.length) return state;
    const queue = state.queue.map((track, index) => index === action.index ? action.track : track);
    return createQueueState({ ...state, queue });
  }
  return queueReducer(state, action);
}

function nextRepeatMode(value: RepeatMode): RepeatMode {
  if (value === "off") return "all";
  if (value === "all") return "one";
  return "off";
}

function cloudSongIdentity(song: CloudSong) {
  const provider: MusicProvider = song.provider === "kugou" ? "kugou" : "netease";
  const sourceId = provider === "kugou" ? String(song.playKey || song.id).toLowerCase() : String(song.id);
  if (provider === "kugou" && !/^[a-f0-9]{24}$/.test(sourceId)) return null;
  if (provider === "netease" && !/^[1-9]\d{0,19}$/.test(sourceId)) return null;
  return { provider, sourceId };
}

function cloudSongToQueueTrack(song: CloudSong, quality: PlaybackQuality): LocalTrack | null {
  const identity = cloudSongIdentity(song);
  if (!identity) return null;
  return {
    id: `cloud-v2-${identity.provider}-${identity.sourceId}-${quality}`,
    name: song.artist ? `${song.name} · ${song.artist}` : song.name,
    type: "audio/mpeg",
    size: 0,
    path: cloudTrackPath(identity.provider, identity.sourceId, quality),
    provider: identity.provider,
    quality,
    sourceId: identity.sourceId,
    cover: song.cover,
    url: "",
  };
}

function isSupportedAudioFile(file: File) {
  return file.type.startsWith("audio/") || /\.(?:aac|flac|m4a|mp3|ogg|opus|wav)$/i.test(file.name);
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
  const [queuePanelOpen, setQueuePanelOpen] = useState(false);
  const [queuePersistenceReady, setQueuePersistenceReady] = useState(false);
  const [queueActivationVersion, setQueueActivationVersion] = useState(0);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [likedTrackIds, setLikedTrackIds] = useState<string[]>([]);
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
  const [queueState, dispatchQueue] = useReducer(playerQueueReducer, createQueueState<LocalTrack>());
  const queueStateRef = useRef(queueState);
  const audioRef = useRef<HTMLAudioElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const lyricsDialogRef = useRef<HTMLElement>(null);
  const legacyDialogRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const effectNodesRef = useRef<AudioEffectNodes | null>(null);
  const volumeGainRef = useRef<GainNode | null>(null);
  const playbackVolumeRef = useRef(DEFAULT_VOLUME);
  const audioEffectRef = useRef<AudioEffectPreset>(audioEffect);
  const resumeAfterSourceChangeRef = useRef<{ position: number; playing: boolean; source: string } | null>(null);
  const prepareSequenceRef = useRef(0);
  const prepareControllerRef = useRef<AbortController | null>(null);
  const audioErrorControllerRef = useRef<AbortController | null>(null);
  const audioErrorProbeSourceRef = useRef("");
  const roomReadyPrepareRef = useRef("");
  const suppressRoomMediaEventsRef = useRef(false);
  const roomControlThrottleRef = useRef<Record<"seek" | "volume", RoomControlThrottle>>({
    seek: { lastSentAt: 0, pending: null, timer: null },
    volume: { lastSentAt: 0, pending: null, timer: null },
  });
  const queueTransitionRef = useRef<{ autoplay: boolean; position: number } | null>(null);
  const cloudSourceCacheRef = useRef(new Map<string, string>());
  const settingsHydratedRef = useRef(false);
  const sourceCreatedRef = useRef(false);
  const objectUrlsRef = useRef(new Map<string, string>());

  const room = useRoomSync({
    enabled: mode === "room" && Boolean(roomCode),
    roomCode,
    relayUrl,
    deviceName,
  });

  const roomState = room.state;
  const roomIsLeader = room.isLeader;
  const roomLatency = room.latency;
  const roomClockJitter = room.clockJitter;
  const sendRoomCommand = room.sendCommand;
  const getRoomTargetPosition = room.targetPosition;
  const getRoomServerNow = room.serverNow;
  const roomTrack = roomState?.track || null;
  const queuedTrack = getCurrentTrack(queueState);
  const queuedTrackKey = queuedTrack
    ? `${queuedTrack.id}:${queuedTrack.url}:${queuedTrack.quality || "local"}`
    : "";
  const effectiveTrack = mode === "room" ? roomTrack : localTrack;
  const effectivePlaying = mode === "room"
    ? Boolean(roomState?.playing || roomState?.preparing)
    : soloPlaying;
  const effectiveVolume = mode === "room" ? roomState?.volume ?? DEFAULT_VOLUME : soloVolume;
  const effectiveQuality = effectiveTrack?.quality || playbackQuality;
  const liked = Boolean(effectiveTrack?.id && likedTrackIds.includes(effectiveTrack.id));
  const canControl = mode === "solo" || roomIsLeader;
  const roomConnected = room.status === "connected";
  const audioSource = useMemo(() => {
    if (!effectiveTrack) return "";
    if (mode === "solo") return localTrack?.url || "";
    if (!room.httpBase) return "";
    return new URL(effectiveTrack.path, room.httpBase).toString();
  }, [effectiveTrack, localTrack?.url, mode, room.httpBase]);

  const beginPrepareRequest = useCallback(() => {
    prepareSequenceRef.current += 1;
    prepareControllerRef.current?.abort();
    audioErrorControllerRef.current?.abort();
    audioErrorControllerRef.current = null;
    const controller = new AbortController();
    prepareControllerRef.current = controller;
    return { controller, sequence: prepareSequenceRef.current };
  }, []);

  const isCurrentPrepareRequest = useCallback((sequence: number, controller: AbortController) => (
    prepareSequenceRef.current === sequence && !controller.signal.aborted
  ), []);

  const prepareKugouPlayback = useCallback(async (
    trackRef: string,
    quality: PlaybackQuality,
    controller: AbortController,
  ): Promise<KugouPrepareOutcome> => {
    const baseUrl = musicApiUrl.replace(/\/+$/, "");
    try {
      const response = await fetch(new URL("/api/v2/playback/prepare", `${baseUrl}/`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Mineradio-Application": "mineradio-web-v1",
        },
        body: JSON.stringify({ provider: "kugou", trackRef, quality }),
        signal: controller.signal,
      });
      const value = (await response.json().catch(() => ({}))) as KugouPrepareResponse;
      const responseCode = value.restriction?.category || value.error || "";
      if (responseCode && responseCode !== "method_not_allowed" && responseCode !== "not_found") {
        return { kind: "failed", code: responseCode };
      }
      if (
        response.status === 404
        || response.status === 405
        || responseCode === "method_not_allowed"
        || responseCode === "not_found"
      ) return { kind: "legacy" };
      if (!response.ok) return { kind: "failed", code: "network_error" };
      if (!value.playable) return { kind: "failed", code: value.restriction?.category || "provider_unavailable" };
      if (
        value.provider !== "kugou"
        || value.trackRef !== trackRef
        || value.requestedQuality !== quality
        || !isPlaybackQuality(value.resolvedQuality)
      ) return { kind: "failed", code: "provider_contract_changed" };
      const source = validKugouStreamPath(value.streamPath, trackRef, quality, baseUrl);
      if (!source) return { kind: "failed", code: "provider_contract_changed" };
      return { kind: "prepared", source, resolvedQuality: value.resolvedQuality };
    } catch (error) {
      if (
        controller.signal.aborted
        || (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
      ) throw error;
      return { kind: "failed", code: "network_error" };
    }
  }, [musicApiUrl]);

  const resolveQueueTrack = useCallback(async (track: LocalTrack) => {
    if (track.url) return track;
    const cached = cloudSourceCacheRef.current.get(track.id);
    if (cached) return { ...track, url: cached };
    const provider = track.provider;
    const quality = track.quality;
    const parsed = parseCloudTrackId(track.id);
    const sourceId = track.sourceId || parsed?.sourceId || "";
    if (!provider || !quality || !sourceId) return null;

    let source = "";
    if (provider === "kugou") {
      const { controller, sequence } = beginPrepareRequest();
      setNotice("正在确认酷狗播放权限与音源…");
      let outcome: KugouPrepareOutcome;
      try {
        outcome = await prepareKugouPlayback(sourceId, quality, controller);
      } catch {
        return null;
      }
      if (!isCurrentPrepareRequest(sequence, controller)) return null;
      prepareControllerRef.current = null;
      if (outcome.kind === "failed") {
        setNotice(kugouRecoveryMessage(outcome.code));
        return null;
      }
      source = outcome.kind === "legacy"
        ? `${musicApiUrl.replace(/\/+$/, "")}${cloudStreamPath(provider, sourceId, quality)}`
        : outcome.source;
      if (outcome.kind === "legacy") setNotice(KUGOU_COMPATIBILITY_NOTICE);
      else if (outcome.resolvedQuality !== quality) {
        setNotice(`该歌曲当前可用的酷狗音源为 ${qualityShortLabel(outcome.resolvedQuality, "kugou")}。`);
      }
    } else {
      prepareSequenceRef.current += 1;
      prepareControllerRef.current?.abort();
      prepareControllerRef.current = null;
      source = `${musicApiUrl.replace(/\/+$/, "")}${cloudStreamPath(provider, sourceId, quality)}`;
    }
    cloudSourceCacheRef.current.set(track.id, source);
    return { ...track, sourceId, url: source };
  }, [
    beginPrepareRequest,
    isCurrentPrepareRequest,
    musicApiUrl,
    prepareKugouPlayback,
  ]);

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
      try {
        const stored = JSON.parse(window.localStorage.getItem(LIKED_TRACKS_STORAGE_KEY) || "[]");
        if (Array.isArray(stored)) {
          setLikedTrackIds(
            stored
              .filter((id): id is string => typeof id === "string" && id.length <= 240)
              .slice(0, 500),
          );
        }
      } catch {
        setLikedTrackIds([]);
      }
      const restored = deserializeQueueState(window.localStorage.getItem(PLAYER_QUEUE_STORAGE_KEY));
      dispatchQueue({
        type: "hydrate",
        state: createQueueState<LocalTrack>({
          ...restored,
          queue: restored.queue.map((track) => ({ ...track, url: "" })),
        }),
      });
      setQueuePersistenceReady(true);
      settingsHydratedRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const dialog = legacyPanel ? legacyDialogRef.current : (lyricsOpen ? lyricsDialogRef.current : null);
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      dialog.querySelector<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])")?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [legacyPanel, lyricsOpen]);

  useEffect(() => {
    const anyOpen = qualityOpen || audioEffectOpen || lyricsOpen || Boolean(legacyPanel) || queuePanelOpen || roomPanelOpen;
    if (!anyOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (audioEffectOpen) setAudioEffectOpen(false);
      else if (qualityOpen) setQualityOpen(false);
      else if (legacyPanel) setLegacyPanel(null);
      else if (lyricsOpen) setLyricsOpen(false);
      else if (queuePanelOpen) setQueuePanelOpen(false);
      else if (roomPanelOpen) setRoomPanelOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [audioEffectOpen, legacyPanel, lyricsOpen, qualityOpen, queuePanelOpen, roomPanelOpen]);

  useEffect(() => {
    if (!settingsHydratedRef.current) return;
    window.localStorage.setItem(
      "mineradio-lan-settings-v1",
      JSON.stringify({ relayUrl, musicApiUrl, version: 2 }),
    );
  }, [musicApiUrl, relayUrl]);

  useEffect(() => {
    if (!queuePersistenceReady) return;
    window.localStorage.setItem(PLAYER_QUEUE_STORAGE_KEY, serializeQueueState(queueState));
  }, [queuePersistenceReady, queueState]);

  useEffect(() => {
    queueStateRef.current = queueState;
  }, [queueState]);

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
          let status = await requestCloud<CloudUser>(musicApiUrl, "/api/kugou/login/status", controller.signal);
          if (
            status.hasLocalSession
            && (status.validationState === "unvalidated" || status.validationState === "unavailable")
          ) {
            status = await requestCloud<CloudUser>(
              musicApiUrl,
              "/api/kugou/login/refresh",
              controller.signal,
            ).catch(() => status);
          }
          setCloudUser(status);
          const accountStatus = kugouAccountStatus(status);
          if (!status.loggedIn) {
            setCloudStatus(accountStatus || "登录酷狗音乐后可同步你的云端歌单");
            return;
          }
          if (accountStatus) setCloudStatus(accountStatus);
          const result = await requestCloud<CloudUser & { playlists: CloudPlaylist[] }>(
            musicApiUrl,
            "/api/kugou/user/playlists",
            controller.signal,
          );
          setCloudUser(result);
          setCloudPlaylists(result.playlists || []);
          const resultAccountStatus = kugouAccountStatus(result);
          setCloudStatus(resultAccountStatus || (result.playlists?.length ? `已同步 ${result.playlists.length} 个酷狗歌单` : "账号内暂时没有可用歌单"));
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
          const accountStatus = isKugou ? kugouAccountStatus(status) : "";
          setCloudStatus(accountStatus || `已登录${status.nickname ? ` · ${status.nickname}` : ""}`);
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
    if (!queuePersistenceReady || mode !== "solo") return;
    const transition = queueTransitionRef.current;
    queueTransitionRef.current = null;
    const trackToResolve = getCurrentTrack(queueStateRef.current);
    if (!trackToResolve) {
      audioRef.current?.pause();
      setLocalTrack(null);
      setSoloPlaying(false);
      setProgress(0);
      setDuration(0);
      return;
    }

    let cancelled = false;
    audioRef.current?.pause();
    setSoloPlaying(false);
    if (!trackToResolve.url) setLocalTrack(trackToResolve);
    void resolveQueueTrack(trackToResolve).then((track) => {
      if (cancelled || !track) return;
      const autoplay = transition?.autoplay === true;
      resumeAfterSourceChangeRef.current = autoplay || (transition?.position || 0) > 0
        ? { position: transition?.position || 0, playing: autoplay, source: track.url }
        : null;
      audioErrorProbeSourceRef.current = "";
      setLocalTrack(track);
    });
    return () => {
      cancelled = true;
    };
  }, [mode, queueActivationVersion, queuePersistenceReady, queuedTrackKey, resolveQueueTrack]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    audioErrorControllerRef.current?.abort();
    audioErrorControllerRef.current = null;
    audioErrorProbeSourceRef.current = "";
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
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    let correctionTimer: ReturnType<typeof setInterval> | undefined;
    let playAttempted = false;

    audio.preservesPitch = true;
    audio.preload = "auto";

    const targetPosition = () => Math.min(
      getRoomTargetPosition(state),
      audio.duration || Infinity,
    );
    const reportReady = () => {
      if (!state.preparing || !state.prepareId || roomReadyPrepareRef.current === state.prepareId) return;
      const target = targetPosition();
      if (!Number.isFinite(target) || audio.readyState < 3 || !hasBufferedPlaybackWindow(audio, target)) return;
      if (Math.abs((audio.currentTime || 0) - target) > 0.08) {
        if (audio.readyState >= 1) audio.currentTime = target;
        return;
      }
      if (sendRoomCommand({
        action: "ready",
        prepareId: state.prepareId,
        ready: true,
        latencyMs: roomLatency,
        jitterMs: roomClockJitter,
      })) {
        roomReadyPrepareRef.current = state.prepareId;
      }
    };
    const beginPlayback = () => {
      if (playAttempted || !state.playing) return;
      playAttempted = true;
      void audio.play().then(() => setNeedsUnlock(false)).catch(() => {
        setNeedsUnlock(true);
        if (state.prepareId) sendRoomCommand({ action: "start-failed", prepareId: state.prepareId });
      });
    };
    const reconcile = () => {
      const target = targetPosition();
      const current = audio.currentTime || 0;
      const scheduledInFuture = state.playing && state.scheduledAt > getRoomServerNow();
      const leaderNeedsAlignment = roomIsLeader && (state.preparing || !state.playing || scheduledInFuture);
      const correction = roomIsLeader && !leaderNeedsAlignment
        ? { mode: "hold" as const, rate: 1 }
        : playbackCorrection(target, current, {
            playing: state.playing,
            latencyMs: roomLatency,
            jitterMs: roomClockJitter,
            forceSeek: leaderNeedsAlignment && Math.abs(target - current) > 0.05,
          });
      if (correction.mode === "seek" && audio.readyState >= 1 && Number.isFinite(target)) {
        audio.currentTime = target;
      }
      audio.playbackRate = correction.rate;

      if (state.preparing) {
        if (!audio.paused) audio.pause();
        if (correction.mode !== "seek") reportReady();
        return;
      }
      if (!state.playing) {
        if (!audio.paused) audio.pause();
        return;
      }

      const startDelay = state.scheduledAt > 0
        ? state.scheduledAt - getRoomServerNow()
        : 0;
      if (startDelay > 20) {
        if (!audio.paused) audio.pause();
        if (startTimer) clearTimeout(startTimer);
        startTimer = setTimeout(beginPlayback, startDelay);
      } else {
        beginPlayback();
      }
    };

    const onReady = () => {
      reconcile();
      reportReady();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const onUnavailable = () => {
      if (suppressRoomMediaEventsRef.current) return;
      if (!state.prepareId || roomReadyPrepareRef.current !== state.prepareId) return;
      if (!state.preparing && (!state.scheduledAt || state.scheduledAt <= getRoomServerNow())) return;
      sendRoomCommand({
        action: "ready",
        prepareId: state.prepareId,
        ready: false,
        latencyMs: roomLatency,
        jitterMs: roomClockJitter,
      });
      roomReadyPrepareRef.current = "";
    };

    reconcile();
    audio.addEventListener("loadedmetadata", onReady);
    audio.addEventListener("canplay", onReady);
    audio.addEventListener("canplaythrough", onReady);
    audio.addEventListener("progress", onReady);
    audio.addEventListener("seeked", onReady);
    audio.addEventListener("waiting", onUnavailable);
    audio.addEventListener("stalled", onUnavailable);
    audio.addEventListener("error", onUnavailable);
    document.addEventListener("visibilitychange", onVisible);
    if (!roomIsLeader && state.playing && (!state.scheduledAt || state.scheduledAt <= getRoomServerNow())) {
      correctionTimer = setInterval(reconcile, 250);
    }
    return () => {
      if (startTimer) clearTimeout(startTimer);
      if (correctionTimer) clearInterval(correctionTimer);
      audio.removeEventListener("loadedmetadata", onReady);
      audio.removeEventListener("canplay", onReady);
      audio.removeEventListener("canplaythrough", onReady);
      audio.removeEventListener("progress", onReady);
      audio.removeEventListener("seeked", onReady);
      audio.removeEventListener("waiting", onUnavailable);
      audio.removeEventListener("stalled", onUnavailable);
      audio.removeEventListener("error", onUnavailable);
      document.removeEventListener("visibilitychange", onVisible);
      audio.playbackRate = 1;
    };
  }, [
    audioSource,
    getRoomServerNow,
    getRoomTargetPosition,
    mode,
    roomClockJitter,
    roomIsLeader,
    roomLatency,
    roomState,
    sendRoomCommand,
  ]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let lastPaint = 0;
    let lastLeaderPositionSentAt = 0;
    let leaderBuffering = false;
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
          setNotice("歌曲已加载；浏览器需要你点击播放后继续。");
        });
      }
    };
    const onEnded = () => {
      if (mode === "solo") {
        const current = queueStateRef.current;
        if (current.repeat === "one" && current.currentIndex >= 0) {
          audio.currentTime = 0;
          void audio.play().then(() => setSoloPlaying(true)).catch(() => setSoloPlaying(false));
          return;
        }
        const next = queueReducer(current, { type: "ended" });
        if (next.currentIndex !== current.currentIndex) {
          queueTransitionRef.current = { autoplay: true, position: 0 };
          dispatchQueue({ type: "ended" });
          setQueueActivationVersion((value) => value + 1);
        } else {
          setSoloPlaying(false);
        }
      } else if (roomIsLeader) sendRoomCommand({ action: "pause" });
    };
    const sendLeaderProgress = () => {
      if (mode !== "room" || !roomIsLeader) return;
      sendRoomCommand({
        action: "progress",
        position: Math.max(0, audio.currentTime || 0),
        advancing: !audio.paused && !leaderBuffering,
      });
      lastLeaderPositionSentAt = Date.now();
    };
    const onTimeUpdate = () => {
      if (suppressRoomMediaEventsRef.current) return;
      if (Date.now() - lastLeaderPositionSentAt >= 1000) sendLeaderProgress();
    };
    const onWaiting = () => {
      if (suppressRoomMediaEventsRef.current || mode !== "room" || !roomIsLeader || leaderBuffering) return;
      leaderBuffering = true;
      sendLeaderProgress();
      audio.pause();
      sendRoomCommand({ action: "pause" });
    };
    const onCanPlay = () => {
      if (suppressRoomMediaEventsRef.current || mode !== "room" || !roomIsLeader || !leaderBuffering) return;
      leaderBuffering = false;
      sendLeaderProgress();
      sendRoomCommand({ action: "play" });
    };
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("durationchange", updateDuration);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("stalled", onWaiting);
    audio.addEventListener("canplay", onCanPlay);
    frame = requestAnimationFrame(update);
    return () => {
      cancelAnimationFrame(frame);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("durationchange", updateDuration);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("stalled", onWaiting);
      audio.removeEventListener("canplay", onCanPlay);
    };
  }, [mode, roomIsLeader, sendRoomCommand]);

  useEffect(
    () => () => {
      prepareSequenceRef.current += 1;
      prepareControllerRef.current?.abort();
      audioErrorControllerRef.current?.abort();
      for (const url of objectUrlsRef.current.values()) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
      cloudSourceCacheRef.current.clear();
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
      if (mode === "room") {
        // Room authority must not wait on a browser-specific AudioContext unlock.
        // The synchronized start barrier will still verify that every media element
        // has buffered the target position before scheduling playback.
        void ensureAudioGraph().catch(() => false);
        room.sendCommand({
          action: "progress",
          position: Math.max(0, audio.currentTime || 0),
          advancing: !audio.paused && !audio.ended,
        });
        room.sendCommand({
          action: room.state?.playing || room.state?.preparing ? "pause" : "play",
        });
        return;
      }
      await ensureAudioGraph();
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
      const scheduledInFuture = mode === "room"
        && Boolean(room.state?.playing)
        && Number(room.state?.scheduledAt) > room.serverNow();
      if (mode === "room" && room.state?.playing && !scheduledInFuture) {
        audio.currentTime = room.targetPosition(room.state);
        await audio.play();
      } else if (audioSource) {
        const wasMuted = audio.muted;
        suppressRoomMediaEventsRef.current = mode === "room";
        audio.muted = true;
        try {
          if (mode === "room" && room.state) audio.currentTime = room.targetPosition(room.state);
          await audio.play();
          audio.pause();
        } finally {
          audio.muted = wasMuted;
          window.setTimeout(() => { suppressRoomMediaEventsRef.current = false; }, 250);
        }
      }
      setNeedsUnlock(false);
      setNotice("声音已启用，这台设备会自动追赶房间进度。");
    } catch {
      setNotice("浏览器仍阻止播放，请检查静音开关或媒体权限。");
    }
  }, [audioSource, ensureAudioGraph, mode, room]);

  const onFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      prepareSequenceRef.current += 1;
      prepareControllerRef.current?.abort();
      prepareControllerRef.current = null;
      audioErrorControllerRef.current?.abort();
      audioErrorControllerRef.current = null;
      const files = Array.from(event.target.files || []);
      event.target.value = "";
      if (!files.length) return;
      const supported = files.filter((file) => isSupportedAudioFile(file) && file.size <= MAX_UPLOAD_BYTES);
      if (!supported.length) {
        setNotice("请选择浏览器支持的音频文件。");
        return;
      }
      resumeAfterSourceChangeRef.current = null;
      await ensureAudioGraph().catch(() => false);
      if (mode === "solo") {
        for (const url of objectUrlsRef.current.values()) URL.revokeObjectURL(url);
        objectUrlsRef.current.clear();
        const tracks = supported.map((file, index) => {
          const id = `local-${file.lastModified}-${file.size}-${index}-${file.name}`;
          const url = URL.createObjectURL(file);
          objectUrlsRef.current.set(id, url);
          return {
            id,
            name: file.name.replace(/\.[^.]+$/, ""),
            type: file.type || "audio/mpeg",
            size: file.size,
            path: "",
            url,
          } satisfies LocalTrack;
        });
        queueTransitionRef.current = { autoplay: false, position: 0 };
        dispatchQueue({ type: "replace", queue: tracks, currentIndex: 0 });
        setQueueActivationVersion((value) => value + 1);
        setSoloPlaying(false);
        const skipped = files.length - tracks.length;
        setNotice(`${tracks.length} 首本地音乐已按选择顺序加入队列${skipped ? `；跳过 ${skipped} 个不支持或超过 512 MB 的文件` : ""}。`);
        return;
      }
      if (!room.isLeader || !roomConnected || !room.httpBase) {
        setNotice("请等待房间连接；只有主控设备可以更换歌曲。");
        return;
      }
      setUploading(true);
      setNotice("正在把歌曲发送到局域网中继…");
      try {
        const file = supported[0];
        const endpoint = new URL("/api/tracks", room.httpBase);
        endpoint.searchParams.set("name", file.name.replace(/\.[^.]+$/, ""));
        endpoint.searchParams.set("type", file.type || "audio/mpeg");
        const response = await fetch(endpoint, { method: "POST", body: file });
        const result = (await response.json()) as TrackDescriptor & { error?: string };
        if (!response.ok) throw new Error(result.error || "upload_failed");
        room.sendCommand({ action: "track", track: result });
        setNotice(files.length > 1
          ? "房间模式目前一次同步一首歌曲，已上传所选文件中的第一首。"
          : "歌曲已送达房间，所有设备会加载同一份音频。");
      } catch (error) {
        setNotice(`上传失败：${error instanceof Error ? error.message : "未知错误"}`);
      } finally {
        setUploading(false);
      }
    },
    [ensureAudioGraph, mode, room, roomConnected],
  );

  const sendThrottledRoomControl = useCallback((
    action: "seek" | "volume",
    value: number,
    flush = false,
  ) => {
    const throttle = roomControlThrottleRef.current[action];
    throttle.pending = value;
    const sendPending = () => {
      if (throttle.timer) clearTimeout(throttle.timer);
      throttle.timer = null;
      const pending = throttle.pending;
      throttle.pending = null;
      if (pending == null) return;
      const sent = action === "seek"
        ? sendRoomCommand({ action: "seek", position: pending })
        : sendRoomCommand({ action: "volume", volume: pending });
      if (sent) throttle.lastSentAt = Date.now();
    };
    const elapsed = Date.now() - throttle.lastSentAt;
    if (flush || elapsed >= ROOM_CONTROL_THROTTLE_MS) {
      sendPending();
      return;
    }
    if (!throttle.timer) {
      throttle.timer = setTimeout(sendPending, ROOM_CONTROL_THROTTLE_MS - elapsed);
    }
  }, [sendRoomCommand]);

  useEffect(() => () => {
    for (const throttle of Object.values(roomControlThrottleRef.current)) {
      if (throttle.timer) clearTimeout(throttle.timer);
      throttle.timer = null;
      throttle.pending = null;
    }
  }, []);

  const seek = useCallback(
    (value: number, flush = false) => {
      const audio = audioRef.current;
      if (!audio || !canControl) return;
      audio.currentTime = value;
      setProgress(value);
      if (mode === "room") sendThrottledRoomControl("seek", value, flush);
    },
    [canControl, mode, sendThrottledRoomControl],
  );

  const setVolume = useCallback(
    (value: number, flush = false) => {
      if (!canControl) return;
      if (mode === "room") sendThrottledRoomControl("volume", value, flush);
      else setSoloVolume(value);
    },
    [canControl, mode, sendThrottledRoomControl],
  );

  const moveQueue = useCallback((action: "previous" | "next") => {
    if (mode !== "solo") {
      setNotice("房间模式暂不共享播放队列；上一首和下一首请先退出房间后使用。");
      return;
    }
    const current = queueStateRef.current;
    const next = queueReducer(current, { type: action });
    if (next.currentIndex === current.currentIndex) {
      if (action === "previous" && audioRef.current) {
        audioRef.current.currentTime = 0;
        setProgress(0);
      }
      return;
    }
    queueTransitionRef.current = {
      autoplay: Boolean(audioRef.current && !audioRef.current.paused),
      position: 0,
    };
    dispatchQueue({ type: action });
    setQueueActivationVersion((value) => value + 1);
  }, [mode]);

  const selectQueueTrack = useCallback((index: number) => {
    if (mode !== "solo") {
      setNotice("房间内的歌曲由主控时间线决定；退出房间后可播放本机队列。");
      return;
    }
    if (index === queueStateRef.current.currentIndex) {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = 0;
      setProgress(0);
      void ensureAudioGraph().then(() => audio.play()).then(() => setSoloPlaying(true)).catch(() => {
        setSoloPlaying(false);
        setNotice("浏览器阻止了自动播放，请点击播放按钮继续。");
      });
      return;
    }
    queueTransitionRef.current = { autoplay: true, position: 0 };
    dispatchQueue({ type: "select", index });
    setQueueActivationVersion((value) => value + 1);
  }, [ensureAudioGraph, mode]);

  const removeQueueTrack = useCallback((index: number) => {
    if (mode !== "solo") {
      setNotice("房间模式下本机队列已锁定，退出房间后可以编辑。");
      return;
    }
    const state = queueStateRef.current;
    const track = state.queue[index];
    if (!track) return;
    const wasCurrent = index === state.currentIndex;
    const blobStillQueued = state.queue.some((candidate, candidateIndex) => (
      candidateIndex !== index && candidate.url === track.url
    ));
    if (track.url.startsWith("blob:") && !blobStillQueued) {
      URL.revokeObjectURL(track.url);
      objectUrlsRef.current.delete(track.id);
    }
    if (wasCurrent) {
      queueTransitionRef.current = {
        autoplay: Boolean(audioRef.current && !audioRef.current.paused),
        position: 0,
      };
    }
    dispatchQueue({ type: "remove", index });
    if (wasCurrent) setQueueActivationVersion((value) => value + 1);
  }, [mode]);

  const playQueueTrackNext = useCallback((index: number) => {
    if (mode !== "solo") {
      setNotice("房间模式暂不共享下一首队列。");
      return;
    }
    const track = queueStateRef.current.queue[index];
    if (!track) return;
    dispatchQueue({ type: "play-next", track });
    setNotice(`“${track.name}”已添加为下一首。`);
  }, [mode]);

  const clearQueue = useCallback(() => {
    if (mode !== "solo") {
      setNotice("房间模式下本机队列已锁定，退出房间后可以清空。");
      return;
    }
    audioRef.current?.pause();
    for (const url of objectUrlsRef.current.values()) URL.revokeObjectURL(url);
    objectUrlsRef.current.clear();
    queueTransitionRef.current = null;
    dispatchQueue({ type: "clear" });
    setNotice("播放队列已清空。");
  }, [mode]);

  const cycleRepeat = useCallback(() => {
    if (mode !== "solo") {
      setNotice("房间模式暂不共享循环设置。");
      return;
    }
    dispatchQueue({ type: "set-repeat", repeat: nextRepeatMode(queueStateRef.current.repeat) });
  }, [mode]);

  const toggleShuffle = useCallback(() => {
    if (mode !== "solo") {
      setNotice("房间模式暂不共享随机播放顺序。");
      return;
    }
    dispatchQueue({ type: "set-shuffle", shuffle: !queueStateRef.current.shuffle });
  }, [mode]);

  const createRoom = useCallback(() => {
    prepareSequenceRef.current += 1;
    prepareControllerRef.current?.abort();
    prepareControllerRef.current = null;
    const code = createRoomCode();
    setMode("room");
    setRoomCode(code);
    setRoomInput(code);
    setRoomPanelOpen(true);
    updateRoomInUrl(code);
    setNotice("房间已创建；连接后你将成为主控设备。");
  }, []);

  const joinRoom = useCallback(() => {
    prepareSequenceRef.current += 1;
    prepareControllerRef.current?.abort();
    prepareControllerRef.current = null;
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
    prepareSequenceRef.current += 1;
    prepareControllerRef.current?.abort();
    prepareControllerRef.current = null;
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
    if (["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)) {
      url.hostname = preferredLanHost(room.addresses, url.hostname);
      if (!url.port) url.port = "3000";
      url.protocol = "http:";
    }
    return url.toString();
  }, [room.addresses, roomCode]);

  const copyShareLink = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await copyTextWithFallback(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setNotice("复制失败，请手动选择房间链接。");
    }
  }, [shareUrl]);

  const toggleLikedTrack = useCallback(() => {
    if (!effectiveTrack?.id) return;
    const trackId = effectiveTrack.id;
    setLikedTrackIds((current) => {
      const next = current.includes(trackId)
        ? current.filter((id) => id !== trackId)
        : [...current.filter((id) => id !== trackId), trackId].slice(-500);
      window.localStorage.setItem(LIKED_TRACKS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, [effectiveTrack]);

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

  const selectCloudSong = useCallback(async (song: CloudSong) => {
    const quality = playbackQuality;
    const selectedTrack = cloudSongToQueueTrack(song, quality);
    if (!selectedTrack) {
      setNotice(song.provider === "kugou"
        ? kugouRecoveryMessage("track_key_expired")
        : "这首歌曲缺少有效的播放标识，请刷新搜索或歌单后重试。");
      return;
    }
    const provider = selectedTrack.provider || "netease";
    const sourceId = selectedTrack.sourceId || "";
    if (mode === "solo") {
      await ensureAudioGraph().catch(() => false);
      const queue = cloudSongs.map((candidate) => cloudSongToQueueTrack(candidate, quality)).filter((track): track is LocalTrack => Boolean(track));
      const selectedIndex = queue.findIndex((track) => track.id === selectedTrack.id);
      for (const url of objectUrlsRef.current.values()) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
      queueTransitionRef.current = { autoplay: true, position: 0 };
      dispatchQueue({
        type: "replace",
        queue: queue.length ? queue : [selectedTrack],
        currentIndex: selectedIndex >= 0 ? selectedIndex : 0,
      });
      setQueueActivationVersion((value) => value + 1);
      setLegacyPanel(null);
      setNotice(`已将 ${queue.length || 1} 首歌曲加入播放队列，正在加载“${selectedTrack.name}”…`);
      return;
    }
    if (mode === "room" && (!roomConnected || !roomIsLeader)) {
      setNotice("请等待房间连接；只有主控设备可以更换在线歌曲。");
      return;
    }
    setLegacyPanel(null);

    let resolvedQuality = quality;
    let compatibilityMode = false;
    if (provider === "kugou") {
      const { controller, sequence } = beginPrepareRequest();
      setNotice("正在确认酷狗播放权限与音源…");
      let outcome: KugouPrepareOutcome;
      try {
        outcome = await prepareKugouPlayback(sourceId, quality, controller);
      } catch {
        return;
      }
      if (!isCurrentPrepareRequest(sequence, controller)) return;
      prepareControllerRef.current = null;
      if (outcome.kind === "failed") {
        setNotice(kugouRecoveryMessage(outcome.code));
        return;
      }
      if (outcome.kind === "legacy") {
        compatibilityMode = true;
      } else {
        resolvedQuality = outcome.resolvedQuality;
      }
    } else {
      prepareSequenceRef.current += 1;
      prepareControllerRef.current?.abort();
      prepareControllerRef.current = null;
    }

    resumeAfterSourceChangeRef.current = null;
    audioErrorProbeSourceRef.current = "";
    const track: TrackDescriptor = {
      id: `cloud-v2-${provider}-${sourceId}-${quality}`,
      name: song.artist ? `${song.name} · ${song.artist}` : song.name,
      type: "audio/mpeg",
      size: 0,
      path: cloudTrackPath(provider, sourceId, quality),
      provider,
      quality,
    };
    sendRoomCommand({ action: "track", track });
    setNotice(compatibilityMode
      ? KUGOU_COMPATIBILITY_NOTICE
      : resolvedQuality === quality
        ? "在线歌曲已送入同步房间，所有设备将从同一受限音频代理加载。"
        : `酷狗已解析为 ${qualityShortLabel(resolvedQuality, "kugou")}；房间仍保留请求的 ${qualityShortLabel(quality, "kugou")} 档位。`);
  }, [
    beginPrepareRequest,
    cloudSongs,
    ensureAudioGraph,
    isCurrentPrepareRequest,
    mode,
    playbackQuality,
    prepareKugouPlayback,
    roomConnected,
    roomIsLeader,
    sendRoomCommand,
  ]);

  const changePlaybackQuality = useCallback(async (quality: PlaybackQuality) => {
    setQualityOpen(false);
    const cloud = parseCloudTrackId(effectiveTrack?.id);
    const label = QUALITY_OPTIONS.find((option) => option.id === quality)?.label || quality;
    if (!cloud) {
      setPlaybackQualityState(quality);
      window.localStorage.setItem("mineradio-playback-quality-v1", quality);
      setNotice(`音质偏好已设为 ${label}，下次播放在线歌曲时生效。`);
      return;
    }
    if (mode === "room" && !roomIsLeader) {
      setNotice("音质由房间主控设备统一切换。");
      return;
    }

    let source = "";
    let resolvedQuality = quality;
    let compatibilityMode = false;
    if (cloud.provider === "kugou") {
      const { controller, sequence } = beginPrepareRequest();
      setNotice(`正在确认酷狗 ${label} 音源…`);
      let outcome: KugouPrepareOutcome;
      try {
        outcome = await prepareKugouPlayback(cloud.sourceId, quality, controller);
      } catch {
        return;
      }
      if (!isCurrentPrepareRequest(sequence, controller)) return;
      prepareControllerRef.current = null;
      if (outcome.kind === "failed") {
        setNotice(kugouRecoveryMessage(outcome.code));
        return;
      }
      if (outcome.kind === "legacy") {
        compatibilityMode = true;
        source = `${musicApiUrl.replace(/\/+$/, "")}${cloudStreamPath(cloud.provider, cloud.sourceId, quality)}`;
      } else {
        source = outcome.source;
        resolvedQuality = outcome.resolvedQuality;
      }
    } else {
      prepareSequenceRef.current += 1;
      prepareControllerRef.current?.abort();
      prepareControllerRef.current = null;
      source = `${musicApiUrl.replace(/\/+$/, "")}${cloudStreamPath(cloud.provider, cloud.sourceId, quality)}`;
    }

    setPlaybackQualityState(quality);
    window.localStorage.setItem("mineradio-playback-quality-v1", quality);
    audioErrorProbeSourceRef.current = "";
    if (mode === "room") {
      sendRoomCommand({ action: "quality", quality });
      setNotice(compatibilityMode
        ? KUGOU_COMPATIBILITY_NOTICE
        : resolvedQuality === quality
          ? `正在为房间切换到 ${label}，所有设备会从当前进度续播。`
          : `酷狗已解析为 ${qualityShortLabel(resolvedQuality, "kugou")}；房间继续使用请求的 ${qualityShortLabel(quality, "kugou")} 档位。`);
      return;
    }
    const audio = audioRef.current;
    const transition = {
      position: audio?.currentTime || 0,
      autoplay: Boolean(audio && !audio.paused),
    };
    const state = queueStateRef.current;
    const current = state.queue[state.currentIndex];
    if (current) {
      const updated: LocalTrack = {
        ...current,
        id: `cloud-v2-${cloud.provider}-${cloud.sourceId}-${quality}`,
        path: cloudTrackPath(cloud.provider, cloud.sourceId, quality),
        provider: cloud.provider,
        quality,
        sourceId: cloud.sourceId,
        url: source,
      };
      cloudSourceCacheRef.current.set(updated.id, source);
      queueTransitionRef.current = transition;
      dispatchQueue({ type: "update-track", index: state.currentIndex, track: updated });
      setQueueActivationVersion((value) => value + 1);
    } else {
      resumeAfterSourceChangeRef.current = {
        position: transition.position,
        playing: transition.autoplay,
        source,
      };
      setLocalTrack((track) => track ? {
        ...track,
        id: `cloud-v2-${cloud.provider}-${cloud.sourceId}-${quality}`,
        path: cloudTrackPath(cloud.provider, cloud.sourceId, quality),
        provider: cloud.provider,
        quality,
        sourceId: cloud.sourceId,
        url: source,
      } : track);
    }
    setNotice(compatibilityMode
      ? KUGOU_COMPATIBILITY_NOTICE
      : resolvedQuality === quality
        ? `正在切换到 ${label}。`
        : `该歌曲当前可用的酷狗音源为 ${qualityShortLabel(resolvedQuality, "kugou")}。`);
  }, [
    beginPrepareRequest,
    effectiveTrack?.id,
    isCurrentPrepareRequest,
    mode,
    musicApiUrl,
    prepareKugouPlayback,
    roomIsLeader,
    sendRoomCommand,
  ]);

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

  const diagnoseKugouAudioError = useCallback(async () => {
    const cloud = parseCloudTrackId(effectiveTrack?.id);
    if (!cloud || cloud.provider !== "kugou" || !audioSource) return false;
    if (audioErrorProbeSourceRef.current === audioSource) return true;
    audioErrorProbeSourceRef.current = audioSource;
    audioErrorControllerRef.current?.abort();
    const controller = new AbortController();
    audioErrorControllerRef.current = controller;
    const outcome = await prepareKugouPlayback(cloud.sourceId, cloud.quality, controller).catch(() => null);
    if (controller.signal.aborted || audioErrorControllerRef.current !== controller) return true;
    audioErrorControllerRef.current = null;
    if (!outcome) return true;
    if (outcome.kind === "legacy") setNotice(KUGOU_COMPATIBILITY_NOTICE);
    else if (outcome.kind === "failed") setNotice(kugouRecoveryMessage(outcome.code));
    else setNotice(kugouRecoveryMessage("provider_stream_failed"));
    return true;
  }, [audioSource, effectiveTrack?.id, prepareKugouPlayback]);

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
        ? room.state?.preparing
          ? `等待缓冲 · ${room.state.readyCount}/${room.state.requiredCount || 1}`
          : room.state?.prepareError
            ? "同步启动失败 · 请重试"
            : `${room.isLeader ? "主控" : "跟随"} · ${room.state?.deviceCount || 1} 台设备`
        : room.status === "reconnecting"
          ? "正在重连"
          : "等待中继";
  const overlayOpen = roomPanelOpen || queuePanelOpen || Boolean(legacyPanel) || lyricsOpen;

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
        preload="auto"
        onError={() => {
          resumeAfterSourceChangeRef.current = null;
          if (mode === "solo") setSoloPlaying(false);
          if (!audioSource) return;
          void diagnoseKugouAudioError().then((handled) => {
            if (!handled) setNotice("音源加载失败，歌曲可能受版权、会员或网络限制。请尝试另一首。");
          });
        }}
      />
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        multiple
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
              <span>{roomState?.preparing ? "正在等待设备缓冲" : effectivePlaying ? "正在播放" : "等待播放"}</span>
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
        <section ref={lyricsDialogRef} className="lyrics-stage" role="dialog" aria-modal="true" aria-labelledby="lyrics-stage-title">
          <button type="button" onClick={() => setLyricsOpen(false)} aria-label="关闭歌词舞台">
            <X size={20} aria-hidden="true" />
          </button>
          <span>{effectiveTrack ? "NOW PLAYING" : "MINERADIO"}</span>
          <h2 id="lyrics-stage-title">{effectiveTrack?.name || "导入一首歌，让视觉舞台醒来"}</h2>
          <p>{mode === "room" ? "歌词视觉与房间时间线保持同一拍" : "本地播放 · 私人视觉电台"}</p>
        </section>
      ) : null}

      {legacyPanel ? (
        <>
          <button className="legacy-scrim" type="button" onClick={() => setLegacyPanel(null)} aria-label="关闭云端音乐面板" />
          <section ref={legacyDialogRef} className="legacy-modal cloud-modal" role="dialog" aria-modal="true" aria-labelledby="legacy-title">
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
                    {loginProvider === "kugou" && kugouAccountStatus(cloudUser) ? <small>{kugouAccountStatus(cloudUser)}</small> : null}
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
                          <button type="button" onClick={() => void selectCloudSong(song)} key={`${song.provider || "netease"}:${song.id}`}>
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
              <div><dt>状态</dt><dd>{roomState?.preparing
                ? `缓冲就绪 ${roomState.readyCount}/${roomState.requiredCount || 1}`
                : roomState?.prepareError
                  ? roomState.prepareError === "start_failed" ? "设备启动失败，请重试" : "缓冲超时，请重试"
                  : roomConnected ? "已同步" : "等待连接"}</dd></div>
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

      <aside
        className={`room-drawer queue-drawer ${queuePanelOpen ? "is-open" : ""}`}
        aria-labelledby="queue-title"
        aria-hidden={!queuePanelOpen}
        inert={!queuePanelOpen}
      >
        <div className="drawer-heading">
          <button className="drawer-back" type="button" onClick={() => setQueuePanelOpen(false)} aria-label="关闭播放队列">
            <CaretLeft size={20} aria-hidden="true" />
          </button>
          <div>
            <span>UP NEXT · {queueState.queue.length}</span>
            <h2 id="queue-title">播放队列</h2>
          </div>
          <button className="drawer-leave" type="button" onClick={clearQueue} disabled={mode !== "solo" || !queueState.queue.length}>清空</button>
        </div>

        {mode === "room" ? (
          <p className="queue-room-note">房间模式只同步当前歌曲和时间线，暂不共享整条队列。退出房间后可继续使用这份本机队列。</p>
        ) : null}

        <div className="queue-toolbar" aria-label="队列播放模式">
          <button
            className={queueState.repeat !== "off" ? "is-active" : ""}
            type="button"
            onClick={cycleRepeat}
            disabled={mode !== "solo"}
            aria-label={REPEAT_LABELS[queueState.repeat]}
          >
            <ArrowsClockwise size={18} aria-hidden="true" />
            <span>{REPEAT_LABELS[queueState.repeat]}</span>
          </button>
          <button
            className={queueState.shuffle ? "is-active" : ""}
            type="button"
            onClick={toggleShuffle}
            disabled={mode !== "solo"}
            aria-pressed={queueState.shuffle}
          >
            <Shuffle size={18} aria-hidden="true" />
            <span>{queueState.shuffle ? "随机已开" : "顺序播放"}</span>
          </button>
        </div>

        {queueState.queue.length ? (
          <ol className="queue-list">
            {queueState.queue.map((track, index) => {
              const active = index === queueState.currentIndex;
              return (
                <li className={active ? "is-active" : ""} key={`${track.id}:${index}`}>
                  <button className="queue-track-select" type="button" onClick={() => selectQueueTrack(index)} disabled={mode !== "solo"}>
                    <span className="queue-index">{active && effectivePlaying ? <Waveform size={16} aria-hidden="true" /> : index + 1}</span>
                    <span className="queue-track-copy">
                      <strong>{track.name}</strong>
                      <small>{track.provider === "kugou" ? "酷狗音乐" : track.provider === "netease" ? "网易云音乐" : "本地音乐"}{track.quality ? ` · ${qualityShortLabel(track.quality, track.provider)}` : ""}</small>
                    </span>
                  </button>
                  <button className="queue-item-action" type="button" onClick={() => playQueueTrackNext(index)} disabled={mode !== "solo"} aria-label={`将“${track.name}”添加为下一首`}>
                    <SkipForward size={16} aria-hidden="true" />
                  </button>
                  <button className="queue-item-action" type="button" onClick={() => removeQueueTrack(index)} disabled={mode !== "solo"} aria-label={`从队列移除“${track.name}”`}>
                    <X size={16} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="queue-empty">
            <MusicNotes size={28} aria-hidden="true" />
            <strong>队列还是空的</strong>
            <span>导入多首本地音乐，或从搜索和歌单中选择一首。</span>
          </div>
        )}
      </aside>
      {queuePanelOpen ? <button className="drawer-scrim" type="button" onClick={() => setQueuePanelOpen(false)} aria-label="关闭播放队列" /> : null}

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
          onPointerUp={(event) => seek(Number(event.currentTarget.value), true)}
          onKeyUp={(event) => seek(Number(event.currentTarget.value), true)}
          onBlur={(event) => seek(Number(event.currentTarget.value), true)}
        />
        <div className="dock-controls">
          <div className="dock-cluster dock-track">
            <img src={mode === "solo" && localTrack?.cover ? localTrack.cover : "/mineradio-card-art.png"} width="52" height="52" alt="" />
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
              <div className="dock-setting-popover quality-popover" role="menu" aria-label="播放音质" aria-hidden={!qualityOpen} inert={!qualityOpen}>
                <span>播放音质</span>
                {QUALITY_OPTIONS.map((option) => (
                  <button
                    className={effectiveQuality === option.id ? "is-active" : ""}
                    type="button"
                    role="menuitemradio"
                    aria-checked={effectiveQuality === option.id}
                    disabled={mode === "room" && !canControl}
                    onClick={() => void changePlaybackQuality(option.id)}
                    key={option.id}
                  ><strong>{effectiveTrack?.provider === "kugou" && option.id === "hires" ? "Hi-Res" : option.label}</strong><small>{option.detail}</small></button>
                ))}
                <p>实际档位由平台、账号与版权权限决定。</p>
              </div>
            </div>
            <button
              className={liked ? "is-active" : ""}
              type="button"
              disabled={!effectiveTrack}
              onClick={toggleLikedTrack}
              aria-label={liked ? "从本机喜欢中移除" : "保存到本机喜欢"}
              title="仅保存在此浏览器"
            >
              <Heart size={21} weight={liked ? "fill" : "regular"} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => fileInputRef.current?.click()} aria-label="添加歌曲">
              <Plus size={20} aria-hidden="true" />
            </button>
          </div>

          <div className="dock-cluster dock-transport">
            <button
              className={queueState.repeat !== "off" ? "is-active" : ""}
              type="button"
              disabled={mode !== "solo" || !queueState.queue.length}
              onClick={cycleRepeat}
              aria-label={REPEAT_LABELS[queueState.repeat]}
              title={REPEAT_LABELS[queueState.repeat]}
            >
              <ArrowsClockwise size={20} aria-hidden="true" />
            </button>
            <button type="button" disabled={mode !== "solo" || !queueState.queue.length} onClick={() => moveQueue("previous")} aria-label="上一首">
              <SkipBack size={21} weight="fill" aria-hidden="true" />
            </button>
            <button className="dock-play" type="button" onClick={togglePlayback} disabled={!effectiveTrack || !canControl} aria-label={effectivePlaying ? "暂停" : "播放"}>
              {effectivePlaying ? <Pause size={24} weight="fill" aria-hidden="true" /> : <Play size={24} weight="fill" aria-hidden="true" />}
            </button>
            <button type="button" disabled={mode !== "solo" || !queueState.queue.length} onClick={() => moveQueue("next")} aria-label="下一首">
              <SkipForward size={21} weight="fill" aria-hidden="true" />
            </button>
            <button className={queuePanelOpen ? "is-active" : ""} type="button" onClick={() => setQueuePanelOpen(true)} aria-label="打开播放队列">
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
              <div className="dock-setting-popover quality-popover" role="menu" aria-label="播放音质" aria-hidden={!qualityOpen} inert={!qualityOpen}>
                <span>播放音质</span>
                {QUALITY_OPTIONS.map((option) => (
                  <button
                    className={effectiveQuality === option.id ? "is-active" : ""}
                    type="button"
                    role="menuitemradio"
                    aria-checked={effectiveQuality === option.id}
                    disabled={mode === "room" && !canControl}
                    onClick={() => void changePlaybackQuality(option.id)}
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
              <div className="dock-setting-popover effect-popover" role="menu" aria-label="本机音色预设" aria-hidden={!audioEffectOpen} inert={!audioEffectOpen}>
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
                onPointerUp={(event) => setVolume(Number(event.currentTarget.value), true)}
                onKeyUp={(event) => setVolume(Number(event.currentTarget.value), true)}
                onBlur={(event) => setVolume(Number(event.currentTarget.value), true)}
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
