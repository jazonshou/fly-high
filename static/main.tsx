/**
 * The app's entry point: mounts the game into `#root` from `index.html`.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./globals.css";
import { FlightGame } from "@/src/game/FlightGame";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Static entry: #root container is missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <FlightGame />
  </StrictMode>,
);
