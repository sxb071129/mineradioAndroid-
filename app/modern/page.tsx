import type { Metadata } from "next";
import { MineradioPlayer } from "../components/MineradioPlayer";

export const metadata: Metadata = {
  title: "MR//ROOM Modern",
  description: "MR//ROOM 响应式局域网同步播放器界面",
};

export default function ModernPlayerPage() {
  return <MineradioPlayer />;
}
