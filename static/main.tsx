/**
 * Static (GitHub Pages) entry point.
 *
 * The app's canonical deployment is the Cloudflare Worker built by
 * `vinext build`, where `app/layout.tsx` + `app/page.tsx` render the same
 * component tree. GitHub Pages can only serve static files, so this entry
 * mounts the identical client root — `FlightGame` — from a plain Vite build.
 * Keep it in lockstep with `app/page.tsx`: everything below the game root is
 * shared, so the only duplication is the document shell.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/app/globals.css";
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
