import type { Metadata } from "next";
import { FlightGame } from "@/src/game/FlightGame";

export const metadata: Metadata = {
  description:
    "An infinite browser-based flight simulator.",
};

export default function Home() {
  return <FlightGame />;
}
