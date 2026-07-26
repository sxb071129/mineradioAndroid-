type ClassicPlayerFrameProps = {
  room?: string | string[];
};

export function classicRoomQuery(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  const room = String(raw || "HOME")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  return /^[A-Z0-9]{4,8}$/.test(room) ? room : "HOME";
}

export function ClassicPlayerFrame({ room }: ClassicPlayerFrameProps) {
  const roomCode = classicRoomQuery(room);

  return (
    <iframe
      src={`/classic/index.html?room=${encodeURIComponent(roomCode)}`}
      title="Mineradio Classic 播放器"
      allow="autoplay; camera; clipboard-write; fullscreen"
      allowFullScreen
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100dvh",
        border: 0,
        background: "#000",
      }}
    />
  );
}
