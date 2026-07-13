import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ||
    requestHeaders.get("host") ||
    "localhost:3000";
  const forwardedProto = requestHeaders.get("x-forwarded-proto");
  const protocol =
    forwardedProto || (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);

  return {
    metadataBase,
    title: "MR//ROOM — 局域网同步音乐播放器",
    description: "受 Mineradio 启发的响应式网页播放器，在局域网内同步曲目、进度和应用内音量。",
    manifest: "/manifest.webmanifest",
    applicationName: "MR//ROOM",
    openGraph: {
      title: "MR//ROOM — Listen together",
      description: "同一首歌，同一时间线，同一个房间。",
      type: "website",
      images: [{ url: "/og.png", width: 1792, height: 1024, alt: "MR//ROOM 多设备同步声场" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "MR//ROOM — Listen together",
      description: "同一首歌，同一时间线，同一个房间。",
      images: ["/og.png"],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0f0e",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
