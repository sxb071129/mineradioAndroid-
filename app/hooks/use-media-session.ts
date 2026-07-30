"use client";

import { useEffect, useRef } from "react";

type MediaTrack = {
  title: string;
  artist?: string;
  album?: string;
  artwork?: string;
} | null;

type Options = {
  duration: number;
  onNext: () => void;
  onPause: () => void;
  onPlay: () => void;
  onPrevious: () => void;
  onSeek: (position: number) => void;
  playbackRate: number;
  playing: boolean;
  position: number;
  track: MediaTrack;
};

function installAction(
  session: MediaSession,
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
) {
  try {
    session.setActionHandler(action, handler);
  } catch {
    // Some browsers expose Media Session but omit individual actions.
  }
}

export function useMediaSession({
  duration,
  onNext,
  onPause,
  onPlay,
  onPrevious,
  onSeek,
  playbackRate,
  playing,
  position,
  track,
}: Options) {
  const actionsRef = useRef({
    duration,
    onNext,
    onPause,
    onPlay,
    onPrevious,
    onSeek,
    position,
  });
  const positionUpdateRef = useRef({
    duration: 0,
    playing: false,
    updatedAt: 0,
  });

  useEffect(() => {
    actionsRef.current = {
      duration,
      onNext,
      onPause,
      onPlay,
      onPrevious,
      onSeek,
      position,
    };
  }, [duration, onNext, onPause, onPlay, onPrevious, onSeek, position]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    positionUpdateRef.current = { duration: 0, playing: false, updatedAt: 0 };
    if (!track) {
      session.metadata = null;
      session.playbackState = "none";
      try {
        session.setPositionState();
      } catch {}
      return;
    }
    if (typeof MediaMetadata !== "undefined") {
      try {
        session.metadata = new MediaMetadata({
          title: track.title || "Mineradio",
          artist: track.artist || "Mineradio",
          album: track.album || "MR//ROOM",
          artwork: track.artwork ? [{ src: track.artwork }] : undefined,
        });
      } catch {
        session.metadata = null;
      }
    }
  }, [track]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    if (!track) {
      session.playbackState = "none";
      return;
    }
    session.playbackState = playing ? "playing" : "paused";
    if (!Number.isFinite(duration) || duration <= 0) {
      try {
        session.setPositionState();
      } catch {}
      return;
    }
    const now = Date.now();
    const previous = positionUpdateRef.current;
    const playbackChanged = previous.playing !== playing;
    const durationChanged = Math.abs(previous.duration - duration) > 0.05;
    if (!playbackChanged && !durationChanged && now - previous.updatedAt < 1000) return;
    try {
      session.setPositionState({
        duration,
        playbackRate: Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1,
        position: Math.max(0, Math.min(position, Math.max(0, duration - 0.001))),
      });
      positionUpdateRef.current = { duration, playing, updatedAt: now };
    } catch {
      // Metadata may change while duration is being recalculated.
    }
  }, [duration, playbackRate, playing, position, track]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    installAction(session, "play", () => actionsRef.current.onPlay());
    installAction(session, "pause", () => actionsRef.current.onPause());
    installAction(session, "previoustrack", () => actionsRef.current.onPrevious());
    installAction(session, "nexttrack", () => actionsRef.current.onNext());
    installAction(session, "seekto", (details) => {
      if (typeof details.seekTime === "number") actionsRef.current.onSeek(details.seekTime);
    });
    installAction(session, "seekbackward", (details) => {
      const current = actionsRef.current;
      current.onSeek(Math.max(0, current.position - (details.seekOffset || 10)));
    });
    installAction(session, "seekforward", (details) => {
      const current = actionsRef.current;
      current.onSeek(Math.min(
        current.duration || Number.POSITIVE_INFINITY,
        current.position + (details.seekOffset || 10),
      ));
    });
    return () => {
      installAction(session, "play", null);
      installAction(session, "pause", null);
      installAction(session, "previoustrack", null);
      installAction(session, "nexttrack", null);
      installAction(session, "seekto", null);
      installAction(session, "seekbackward", null);
      installAction(session, "seekforward", null);
    };
  }, []);
}
