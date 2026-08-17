import type { Metadata } from "next";
import { FlightGame } from "@/src/game/FlightGame";

export const metadata: Metadata = {
  title: "fly high — Endless Flight",
  description:
    "A calm, procedural browser flight simulator with a believable light-aircraft model.",
};

export default function Home() {
  return <FlightGame />;
}
