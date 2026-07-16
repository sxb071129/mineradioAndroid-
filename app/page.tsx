import type { Metadata } from "next";
import { ClassicPlayerFrame } from "./components/ClassicPlayerFrame";

export const metadata: Metadata = {
  title: "Mineradio",
  description: "Mineradio 原版沉浸式动态音乐播放器",
};

type HomePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Home({ searchParams }: HomePageProps) {
  const query = await searchParams;
  return <ClassicPlayerFrame room={query.room} />;
}
