import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { PwaRegistrar } from "./components/PwaRegistrar";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ||
    requestHeaders.get("host") ||
    "localhost:3000";
  const configuredOrigin = process.env.MINERADIO_PUBLIC_ORIGIN?.trim();
  const forwardedProto = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto === "https" ? "https" : "http";
  let metadataBase = new URL(`${protocol}://${host}`);
  if (configuredOrigin) {
    try {
      metadataBase = new URL(configuredOrigin);
    } catch {
      // Keep the request-derived origin when an optional deployment setting is malformed.
    }
  }

  return {
    metadataBase,
    title: "MR//ROOM — 局域网同步音乐播放器",
    description: "受 Mineradio 启发的响应式网页播放器，在局域网内同步曲目、进度和应用内音量。",
    manifest: "/manifest.webmanifest",
    applicationName: "MR//ROOM",
    icons: {
      icon: [
        { url: "/pwa-icon-192.png", sizes: "192x192", type: "image/png" },
        { url: "/pwa-icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: "MR//ROOM",
    },
    formatDetection: {
      telephone: false,
    },
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
      <body>
        {children}
        <PwaRegistrar />
      </body>
    </html>
  );
}
