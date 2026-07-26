import type { Metadata } from "next";
import { ClassicPlayerFrame } from "../components/ClassicPlayerFrame";

export const metadata: Metadata = {
  title: "Mineradio Classic",
  description: "Mineradio 原版沉浸式播放器界面",
};

type ClassicPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ClassicPage({ searchParams }: ClassicPageProps) {
  const query = await searchParams;
  return <ClassicPlayerFrame room={query.room} />;
}
