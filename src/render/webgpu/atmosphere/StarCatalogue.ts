/**
 * `7-3` — the star catalogue (owner: lighting).
 *
 * INVARIANT THIS FILE OWNS: every star the renderer draws, the frame that
 * puts it in the sky, and the photometry that decides how bright it is.
 * Nothing else hashes a direction into a twinkle (the `1C-10` placeholder in
 * `AtmosphereSystem`'s sky fragment did exactly that and is deleted with
 * this item).
 *
 * **Deviation from the plan's letter, recorded.** `RENDERING_PLAN.md`
 * specifies "Yale Bright Star catalogue (~9,100 stars, ~120 KB)". The BSC is
 * a third-party data file that would have to be fetched and vendored, with
 * its own provenance and licence question, and this repository has a
 * standing rule that every asset is synthesised from the seed rather than
 * shipped. What the plan actually asks the catalogue FOR is stated in the
 * same row — "makes constellations correct, which is worth more than
 * procedural noise" — and that is a property of the bright end, not of the
 * 9,100. So: the ~190 stars that draw every constellation figure are
 * authored here with their J2000 positions, magnitudes and colour indices,
 * and the naked-eye background below magnitude ~3.6 is generated to the real
 * magnitude-count law with a galactic-latitude concentration. Constellations
 * are correct; the sky has the right number of stars at every magnitude; no
 * third-party data file enters the build. The geometric tests
 * (`tests/render.webgpu-night-sky.test.ts`) check the authored table
 * against known angular separations — Orion's belt collinear and 2.7° long,
 * the Dipper's pointers finding Polaris, the Summer Triangle's three sides —
 * so a transcription error fails a test rather than reaching the sky.
 *
 * Class P: pure data and arithmetic, no Babylon import, Node-tested.
 */

import type { EnvironmentClock } from "@/src/world/environmentClock";
import { solarApparentPosition } from "./Ephemeris";

export interface CatalogueStar {
  /** Unit vector in the equatorial frame (x → vernal equinox, z → NCP). */
  readonly equatorial: readonly [number, number, number];
  /** Apparent visual magnitude. */
  readonly magnitude: number;
  /** Johnson B−V colour index; drives the rendered chromaticity. */
  readonly colorIndex: number;
}

const DEGREES_TO_RADIANS = Math.PI / 180;
const HOURS_TO_RADIANS = Math.PI / 12;

/**
 * `[name, RA hours, RA minutes, dec sign, dec degrees, dec arcminutes,
 * V magnitude, B−V]`. Positions are J2000; the sign is separate so that a
 * star between 0° and −1° (δ Ori at −00°18′, for one) cannot lose it.
 */
type BrightStarRow = readonly [string, number, number, 1 | -1, number, number, number, number];

export const BRIGHT_STARS: readonly BrightStarRow[] = Object.freeze([
  ["Sirius", 6, 45.1, -1, 16, 43, -1.46, 0.00],
  ["Canopus", 6, 24.0, -1, 52, 42, -0.74, 0.15],
  ["Rigil Kentaurus", 14, 39.6, -1, 60, 50, -0.27, 0.71],
  ["Arcturus", 14, 15.7, 1, 19, 11, -0.05, 1.23],
  ["Vega", 18, 36.9, 1, 38, 47, 0.03, 0.00],
  ["Capella", 5, 16.7, 1, 46, 0, 0.08, 0.80],
  ["Rigel", 5, 14.5, -1, 8, 12, 0.13, -0.03],
  ["Procyon", 7, 39.3, 1, 5, 13, 0.34, 0.42],
  ["Achernar", 1, 37.7, -1, 57, 14, 0.46, -0.16],
  ["Betelgeuse", 5, 55.2, 1, 7, 24, 0.50, 1.85],
  ["Hadar", 14, 3.8, -1, 60, 22, 0.61, -0.23],
  ["Altair", 19, 50.8, 1, 8, 52, 0.77, 0.22],
  ["Acrux", 12, 26.6, -1, 63, 6, 0.77, -0.24],
  ["Aldebaran", 4, 35.9, 1, 16, 31, 0.85, 1.54],
  ["Antares", 16, 29.4, -1, 26, 26, 0.96, 1.83],
  ["Spica", 13, 25.2, -1, 11, 10, 0.97, -0.23],
  ["Pollux", 7, 45.3, 1, 28, 2, 1.14, 1.00],
  ["Fomalhaut", 22, 57.6, -1, 29, 37, 1.16, 0.09],
  ["Deneb", 20, 41.4, 1, 45, 17, 1.25, 0.09],
  ["Mimosa", 12, 47.7, -1, 59, 41, 1.25, -0.24],
  ["Regulus", 10, 8.4, 1, 11, 58, 1.35, -0.11],
  ["Adhara", 6, 58.6, -1, 28, 58, 1.50, -0.21],
  ["Castor", 7, 34.6, 1, 31, 53, 1.58, 0.03],
  ["Shaula", 17, 33.6, -1, 37, 6, 1.62, -0.23],
  ["Gacrux", 12, 31.2, -1, 57, 7, 1.63, 1.59],
  ["Bellatrix", 5, 25.1, 1, 6, 21, 1.64, -0.22],
  ["Elnath", 5, 26.3, 1, 28, 36, 1.65, -0.13],
  ["Miaplacidus", 9, 13.2, -1, 69, 43, 1.67, 0.07],
  ["Alnilam", 5, 36.2, -1, 1, 12, 1.69, -0.18],
  ["Alnair", 22, 8.2, -1, 46, 58, 1.74, -0.13],
  ["Gamma Velorum", 8, 9.5, -1, 47, 20, 1.75, -0.15],
  ["Alnitak", 5, 40.8, -1, 1, 57, 1.77, -0.20],
  ["Alioth", 12, 54.0, 1, 55, 58, 1.77, -0.02],
  ["Dubhe", 11, 3.7, 1, 61, 45, 1.79, 1.07],
  ["Mirfak", 3, 24.3, 1, 49, 52, 1.79, 0.48],
  ["Wezen", 7, 8.4, -1, 26, 24, 1.83, 0.67],
  ["Kaus Australis", 18, 24.2, -1, 34, 23, 1.85, -0.03],
  ["Alkaid", 13, 47.5, 1, 49, 19, 1.86, -0.19],
  ["Sargas", 17, 37.3, -1, 43, 0, 1.86, 0.40],
  ["Avior", 8, 22.5, -1, 59, 31, 1.86, 1.28],
  ["Menkalinan", 5, 59.5, 1, 44, 57, 1.90, 0.08],
  ["Atria", 16, 48.7, -1, 69, 2, 1.91, 1.44],
  ["Alhena", 6, 37.7, 1, 16, 24, 1.93, 0.00],
  ["Peacock", 20, 25.6, -1, 56, 44, 1.94, -0.12],
  ["Alsephina", 8, 44.7, -1, 54, 43, 1.96, 0.04],
  ["Polaris", 2, 31.8, 1, 89, 16, 1.98, 0.60],
  ["Mirzam", 6, 22.7, -1, 17, 57, 1.98, -0.24],
  ["Alphard", 9, 27.6, -1, 8, 40, 1.98, 1.44],
  ["Hamal", 2, 7.2, 1, 23, 28, 2.00, 1.15],
  ["Algieba", 10, 20.0, 1, 19, 50, 2.01, 1.13],
  ["Diphda", 0, 43.6, -1, 17, 59, 2.04, 1.02],
  ["Nunki", 18, 55.3, -1, 26, 18, 2.05, -0.22],
  ["Menkent", 14, 6.7, -1, 36, 22, 2.06, 1.01],
  ["Mirach", 1, 9.7, 1, 35, 37, 2.06, 1.58],
  ["Alpheratz", 0, 8.4, 1, 29, 5, 2.06, -0.11],
  ["Saiph", 5, 47.8, -1, 9, 40, 2.06, -0.17],
  ["Rasalhague", 17, 34.9, 1, 12, 34, 2.08, 0.15],
  ["Kochab", 14, 50.7, 1, 74, 9, 2.08, 1.47],
  ["Almach", 2, 3.9, 1, 42, 20, 2.10, 1.37],
  ["Tiaki", 22, 42.7, -1, 46, 53, 2.11, 1.60],
  ["Algol", 3, 8.2, 1, 40, 57, 2.12, -0.05],
  ["Denebola", 11, 49.1, 1, 14, 34, 2.14, 0.09],
  ["Muhlifain", 12, 41.5, -1, 48, 58, 2.17, -0.01],
  ["Suhail", 9, 8.0, -1, 43, 26, 2.21, 1.66],
  ["Mintaka", 5, 32.0, -1, 0, 18, 2.23, -0.18],
  ["Sadr", 20, 22.2, 1, 40, 15, 2.23, 0.68],
  ["Mizar", 13, 23.9, 1, 54, 55, 2.23, 0.06],
  ["Alphecca", 15, 34.7, 1, 26, 43, 2.23, -0.02],
  ["Schedar", 0, 40.5, 1, 56, 32, 2.24, 1.17],
  ["Eltanin", 17, 56.6, 1, 51, 29, 2.24, 1.52],
  ["Naos", 8, 3.6, -1, 40, 0, 2.25, -0.27],
  ["Aspidiske", 9, 17.1, -1, 59, 16, 2.25, 0.18],
  ["Caph", 0, 9.2, 1, 59, 9, 2.27, 0.34],
  ["Larawag", 16, 50.2, -1, 34, 18, 2.29, 1.15],
  ["Alpha Lupi", 14, 41.9, -1, 47, 23, 2.30, -0.20],
  ["Epsilon Centauri", 13, 39.9, -1, 53, 28, 2.30, -0.22],
  ["Eta Centauri", 14, 35.5, -1, 42, 9, 2.31, -0.19],
  ["Dschubba", 16, 0.3, -1, 22, 37, 2.32, -0.12],
  ["Merak", 11, 1.8, 1, 56, 23, 2.37, 0.03],
  ["Izar", 14, 45.0, 1, 27, 4, 2.37, 0.97],
  ["Ankaa", 0, 26.3, -1, 42, 18, 2.39, 1.09],
  ["Enif", 21, 44.2, 1, 9, 53, 2.39, 1.53],
  ["Girtab", 17, 42.5, -1, 39, 2, 2.41, -0.20],
  ["Scheat", 23, 3.8, 1, 28, 5, 2.42, 1.67],
  ["Sabik", 17, 10.4, -1, 15, 44, 2.43, 0.06],
  ["Phecda", 11, 53.8, 1, 53, 42, 2.44, 0.04],
  ["Aludra", 7, 24.1, -1, 29, 18, 2.45, -0.08],
  ["Alderamin", 21, 18.6, 1, 62, 35, 2.45, 0.22],
  ["Kappa Velorum", 9, 22.1, -1, 55, 1, 2.47, -0.14],
  ["Navi", 0, 56.7, 1, 60, 43, 2.47, -0.15],
  ["Aljanah", 20, 46.2, 1, 33, 58, 2.48, 1.02],
  ["Markab", 23, 4.8, 1, 15, 12, 2.49, -0.04],
  ["Menkar", 3, 2.3, 1, 4, 6, 2.53, 1.63],
  ["Zeta Centauri", 13, 55.5, -1, 47, 17, 2.55, -0.22],
  ["Zosma", 11, 14.1, 1, 20, 31, 2.56, 0.13],
  ["Zeta Ophiuchi", 16, 37.2, -1, 10, 34, 2.56, 0.02],
  ["Arneb", 5, 32.7, -1, 17, 49, 2.58, 0.21],
  ["Gienah", 12, 15.8, -1, 17, 33, 2.59, -0.11],
  ["Ascella", 19, 2.6, -1, 29, 53, 2.60, 0.08],
  ["Delta Centauri", 12, 8.4, -1, 50, 43, 2.60, -0.12],
  ["Zubeneschamali", 15, 17.0, -1, 9, 23, 2.61, -0.11],
  ["Acrab", 16, 5.4, -1, 19, 48, 2.62, -0.07],
  ["Theta Aurigae", 5, 59.7, 1, 37, 13, 2.62, -0.08],
  ["Unukalhai", 15, 44.3, 1, 6, 26, 2.63, 1.17],
  ["Sheratan", 1, 54.6, 1, 20, 48, 2.64, 0.13],
  ["Alpha Columbae", 5, 39.6, -1, 34, 5, 2.65, -0.12],
  ["Kraz", 12, 34.4, -1, 23, 24, 2.65, 0.89],
  ["Muphrid", 13, 54.7, 1, 18, 24, 2.68, 0.58],
  ["Ruchbah", 1, 25.8, 1, 60, 14, 2.68, 0.13],
  ["Beta Lupi", 14, 58.5, -1, 43, 8, 2.68, -0.22],
  ["Alpha Muscae", 12, 37.2, -1, 69, 8, 2.69, -0.20],
  ["Iota Aurigae", 4, 57.0, 1, 33, 10, 2.69, 1.53],
  ["Mu Velorum", 10, 46.8, -1, 49, 25, 2.69, 0.90],
  ["Kaus Media", 18, 21.0, -1, 29, 50, 2.70, 1.38],
  ["Pi Puppis", 7, 17.1, -1, 37, 6, 2.70, 1.62],
  ["Tarazed", 19, 46.3, 1, 10, 37, 2.72, 1.52],
  ["Eta Draconis", 16, 24.0, 1, 61, 31, 2.73, 0.91],
  ["Yed Prior", 16, 14.3, -1, 3, 42, 2.73, 1.58],
  ["Porrima", 12, 41.7, -1, 1, 27, 2.74, 0.36],
  ["Zubenelgenubi", 14, 50.9, -1, 16, 2, 2.75, 0.15],
  ["Iota Centauri", 13, 20.6, -1, 36, 43, 2.75, 0.06],
  ["Cebalrai", 17, 43.5, 1, 4, 34, 2.76, 1.16],
  ["Theta Carinae", 10, 42.6, -1, 64, 24, 2.76, -0.22],
  ["Iota Orionis", 5, 35.4, -1, 5, 55, 2.77, -0.24],
  ["Kornephoros", 16, 30.2, 1, 21, 29, 2.77, 0.94],
  ["Gamma Lupi", 15, 35.1, -1, 41, 10, 2.78, -0.20],
  ["Delta Crucis", 12, 15.1, -1, 58, 45, 2.79, -0.19],
  ["Rastaban", 17, 30.4, 1, 52, 18, 2.79, 0.95],
  ["Cursa", 5, 7.8, -1, 5, 5, 2.79, 0.13],
  ["Beta Hydri", 0, 25.8, -1, 77, 15, 2.80, 0.62],
  ["Kaus Borealis", 18, 28.0, -1, 25, 25, 2.81, 1.04],
  ["Rho Puppis", 8, 7.5, -1, 24, 18, 2.81, 0.43],
  ["Zeta Herculis", 16, 41.3, 1, 31, 36, 2.81, 0.65],
  ["Tau Scorpii", 16, 35.9, -1, 28, 13, 2.82, -0.25],
  ["Vindemiatrix", 13, 2.2, 1, 10, 58, 2.83, 0.94],
  ["Nihal", 5, 28.2, -1, 20, 46, 2.84, 0.82],
  ["Deneb Algedi", 21, 47.0, -1, 16, 8, 2.85, 0.18],
  ["Zeta Persei", 3, 54.1, 1, 31, 53, 2.85, 0.26],
  ["Alpha Arae", 17, 31.8, -1, 49, 53, 2.85, -0.17],
  ["Beta Arae", 17, 25.3, -1, 55, 32, 2.85, 1.46],
  ["Beta Trianguli Australis", 15, 55.1, -1, 63, 26, 2.85, 0.29],
  ["Alpha Hydri", 1, 58.8, -1, 61, 34, 2.86, 0.28],
  ["Alpha Tucanae", 22, 18.5, -1, 60, 16, 2.86, 1.39],
  ["Alcyone", 3, 47.5, 1, 24, 6, 2.87, -0.09],
  ["Tejat", 6, 23.0, 1, 22, 31, 2.87, 1.64],
  ["Delta Cygni", 19, 45.0, 1, 45, 8, 2.87, -0.03],
  ["Gamma Trianguli Australis", 15, 18.9, -1, 68, 41, 2.89, 0.01],
  ["Pi Scorpii", 15, 58.9, -1, 26, 7, 2.89, -0.19],
  ["Sigma Scorpii", 16, 21.2, -1, 25, 36, 2.89, 0.13],
  ["Albaldah", 19, 9.8, -1, 21, 1, 2.89, 0.35],
  ["Epsilon Persei", 3, 57.9, 1, 40, 1, 2.90, -0.20],
  ["Sadalsuud", 21, 31.6, -1, 5, 34, 2.91, 0.83],
  ["Theta Eridani", 2, 58.3, -1, 40, 18, 2.91, 0.12],
  ["Gamma Persei", 3, 4.8, 1, 53, 30, 2.93, 0.71],
  ["Tau Puppis", 6, 49.9, -1, 50, 37, 2.94, 1.20],
  ["Sadalmelik", 22, 5.8, -1, 0, 19, 2.95, 0.98],
  ["Algorab", 12, 29.9, -1, 16, 31, 2.95, -0.05],
  ["Gamma Eridani", 3, 58.0, -1, 13, 30, 2.95, 1.59],
  ["Upsilon Carinae", 9, 47.1, -1, 65, 4, 2.97, 0.27],
  ["Mebsuta", 6, 43.9, 1, 25, 8, 2.98, 1.40],
  ["Alnasl", 18, 5.8, -1, 30, 25, 2.98, 1.00],
  ["Epsilon Leonis", 9, 45.9, 1, 23, 46, 2.98, 0.80],
  ["Zeta Aquilae", 19, 5.4, 1, 13, 52, 2.99, 0.01],
  ["Beta Trianguli", 2, 9.5, 1, 34, 59, 3.00, 0.14],
  ["Gamma Gruis", 21, 53.9, -1, 37, 22, 3.00, -0.12],
  ["Gamma Hydrae", 13, 18.9, -1, 23, 10, 3.00, 0.92],
  ["Zeta Tauri", 5, 37.6, 1, 21, 9, 3.00, -0.15],
  ["Mu Scorpii", 16, 51.9, -1, 38, 3, 3.00, -0.20],
  ["Delta Persei", 3, 42.9, 1, 47, 47, 3.01, -0.13],
  ["Psi Ursae Majoris", 11, 9.7, 1, 44, 30, 3.01, 1.14],
  ["Omicron2 Canis Majoris", 7, 3.0, -1, 23, 50, 3.02, -0.08],
  ["Iota Scorpii", 17, 47.6, -1, 40, 8, 3.03, 0.51],
  ["Seginus", 14, 32.1, 1, 38, 19, 3.03, 0.19],
  ["Epsilon Aurigae", 5, 2.0, 1, 43, 49, 3.03, 0.54],
  ["Beta Muscae", 12, 46.3, -1, 68, 6, 3.05, -0.18],
  ["Mu Ursae Majoris", 10, 22.3, 1, 41, 30, 3.05, 1.59],
  ["Gamma Ursae Minoris", 15, 20.7, 1, 71, 50, 3.05, 0.05],
  ["Delta Draconis", 19, 12.6, 1, 67, 40, 3.07, 1.00],
  ["Albireo", 19, 30.7, 1, 27, 58, 3.08, 1.09],
  ["Alpha Indi", 20, 37.6, -1, 47, 17, 3.11, 1.00],
  ["Zeta Hydrae", 8, 55.4, 1, 5, 57, 3.11, 1.00],
  ["Nu Hydrae", 10, 49.6, -1, 16, 11, 3.11, 1.25],
  ["Delta Herculis", 17, 15.0, 1, 24, 50, 3.12, 0.08],
  ["Beta Columbae", 5, 51.0, -1, 35, 46, 3.12, 1.16],
  ["Alpha Lyncis", 9, 21.1, 1, 34, 23, 3.13, 1.55],
  ["Iota Ursae Majoris", 8, 59.2, 1, 48, 2, 3.14, 0.19],
  ["Pi Herculis", 17, 15.0, 1, 36, 49, 3.16, 1.44],
  ["Theta Ursae Majoris", 9, 32.9, 1, 51, 41, 3.17, 0.46],
  ["Nu Puppis", 6, 37.7, -1, 43, 12, 3.17, -0.11],
  ["Eta Cephei", 20, 45.3, 1, 61, 50, 3.43, 0.91],
  ["Zeta Draconis", 17, 8.8, 1, 65, 43, 3.17, -0.12],
  ["Epsilon Lepis", 5, 5.5, -1, 22, 22, 3.19, 1.46],
  ["Alpha Circini", 14, 42.5, -1, 64, 59, 3.19, 0.24],
  ["Pi3 Orionis", 4, 49.8, 1, 6, 58, 3.19, 0.45],
  ["Zeta Cygni", 21, 12.9, 1, 30, 14, 3.20, 0.99],
  ["Gamma Cephei", 23, 39.4, 1, 77, 38, 3.21, 1.03],
  ["Beta Cephei", 21, 28.7, 1, 70, 34, 3.23, -0.22],
  ["Gamma Lyrae", 18, 58.9, 1, 32, 41, 3.24, -0.05],
  ["Sigma Puppis", 7, 29.2, -1, 43, 18, 3.25, 1.51],
  ["Eta Serpentis", 18, 21.3, -1, 2, 54, 3.26, 0.94],
  ["Skat", 22, 54.7, -1, 15, 49, 3.27, 0.05],
  ["Alpha Doradus", 4, 34.0, -1, 55, 3, 3.27, -0.10],
  ["Propus", 6, 14.9, 1, 22, 30, 3.28, 1.60],
  ["Omega Carinae", 10, 13.7, -1, 70, 2, 3.29, -0.08],
  ["Iota Draconis", 15, 25.0, 1, 58, 58, 3.29, 1.16],
  ["Delta Ursae Majoris", 12, 15.4, 1, 57, 2, 3.31, 0.08],
  ["Beta Phoenicis", 1, 6.1, -1, 46, 43, 3.31, 0.89],
  ["Theta Leonis", 11, 14.1, 1, 15, 26, 3.33, 0.00],
  ["Zeta Cephei", 22, 10.9, 1, 58, 12, 3.35, 1.56],
  ["Rasalgethi", 17, 14.6, 1, 14, 23, 3.35, 1.44],
  ["Eta Orionis", 5, 24.5, -1, 2, 24, 3.36, -0.17],
  ["Epsilon Cassiopeiae", 1, 54.4, 1, 63, 40, 3.37, -0.15],
  ["Epsilon Lupi", 15, 22.7, -1, 44, 41, 3.37, -0.19],
  ["Auva", 12, 55.6, 1, 3, 24, 3.38, 1.57],
  ["Heze", 13, 34.7, -1, 0, 36, 3.38, 0.11],
  ["Epsilon Hydrae", 8, 46.8, 1, 6, 25, 3.38, 0.68],
  ["Lambda Orionis", 5, 35.1, 1, 9, 56, 3.39, -0.16],
  ["Gamma Phoenicis", 1, 28.4, -1, 43, 19, 3.41, 1.57],
  ["Alpha Trianguli", 1, 53.1, 1, 29, 35, 3.41, 0.49],
  ["Eta Cassiopeiae", 0, 49.1, 1, 57, 49, 3.44, 0.57],
  ["Beta Lyrae", 18, 50.1, 1, 33, 22, 3.45, 0.00],
  ["Lambda Ursae Majoris", 10, 17.1, 1, 42, 55, 3.45, 0.03],
  ["Sigma Canis Majoris", 7, 1.7, -1, 27, 56, 3.47, 1.73],
  ["Nekkar", 15, 1.9, 1, 40, 23, 3.49, 0.97],
  ["Epsilon Gruis", 22, 48.6, -1, 51, 19, 3.49, 0.08],
  ["Altarf", 8, 16.5, 1, 9, 11, 3.53, 1.48],
  ["Wasat", 7, 20.1, 1, 21, 59, 3.53, 0.37],
  ["Eta Herculis", 16, 42.9, 1, 38, 55, 3.53, 0.92],
  ["Delta Eridani", 3, 43.2, -1, 9, 46, 3.54, 0.92],
  ["Zeta Cassiopeiae", 0, 36.9, 1, 53, 54, 3.66, -0.20],
  ["Thuban", 14, 4.4, 1, 64, 22, 3.65, -0.05],
  ["Alshain", 19, 55.3, 1, 6, 24, 3.71, 0.86],
  ["Epsilon Eridani", 3, 32.9, -1, 9, 27, 3.73, 0.88],
  ["Zeta Aurigae", 5, 2.5, 1, 41, 5, 3.75, 1.22],
  ["Eta Persei", 2, 50.7, 1, 55, 54, 3.76, 1.69],
  ["Alrescha", 2, 2.0, 1, 2, 46, 3.82, 0.32],
  ["Mesarthim", 1, 53.5, 1, 19, 18, 3.86, 0.04],
  ["Mu Leonis", 9, 52.8, 1, 26, 0, 3.88, 1.22],
  ["Epsilon Herculis", 17, 0.3, 1, 30, 55, 3.92, 0.00],
  ["Asellus Australis", 8, 44.7, 1, 18, 9, 3.94, 1.08],
  ["Alpha Crateris", 10, 59.8, -1, 18, 18, 4.08, 1.09],
]);

/** Equatorial unit vector: +x to the vernal equinox, +z to the pole. */
export function equatorialUnitVector(
  rightAscensionHours: number,
  declinationDegrees: number,
): [number, number, number] {
  const ra = rightAscensionHours * HOURS_TO_RADIANS;
  const dec = declinationDegrees * DEGREES_TO_RADIANS;
  const cosDec = Math.cos(dec);
  return [cosDec * Math.cos(ra), cosDec * Math.sin(ra), Math.sin(dec)];
}

function rowToStar(row: BrightStarRow): CatalogueStar {
  const [, raHours, raMinutes, sign, decDegrees, decMinutes, magnitude, colorIndex] = row;
  return Object.freeze({
    equatorial: Object.freeze(
      equatorialUnitVector(raHours + raMinutes / 60, sign * (decDegrees + decMinutes / 60)),
    ) as readonly [number, number, number],
    magnitude,
    colorIndex,
  });
}

/** The authored table, resolved to unit vectors. */
export function brightStars(): readonly CatalogueStar[] {
  return BRIGHT_STARS.map(rowToStar);
}

/** Right ascension and declination of one authored row, in degrees/hours. */
export function brightStarPosition(name: string): {
  readonly rightAscensionHours: number;
  readonly declinationDegrees: number;
  readonly magnitude: number;
} {
  const row = BRIGHT_STARS.find((candidate) => candidate[0] === name);
  if (!row) throw new RangeError(`No bright star named ${name}`);
  return {
    rightAscensionHours: row[1] + row[2] / 60,
    declinationDegrees: row[3] * (row[4] + row[5] / 60),
    magnitude: row[6],
  };
}

// ---------------------------------------------------------------------------
// The generated background.
// ---------------------------------------------------------------------------

/**
 * Faintest magnitude generated. 6.0 is the classic naked-eye limit and also
 * where the count law stops being worth drawing: past it a star contributes
 * less than a hundredth of the sky's integrated brightness while doubling
 * the vertex count.
 */
export const STAR_FIELD_FAINTEST_MAGNITUDE = 6.0;
/** Authored coverage ends here; the generator fills below it. */
export const STAR_FIELD_AUTHORED_MAGNITUDE_LIMIT = 3.6;

/**
 * Cumulative star count over the whole sky brighter than V. The observed
 * naked-eye counts are 15 / 48 / 171 / 513 / 1,602 / 4,800 at V ≤ 1…6, and
 * this is the two-point fit through V = 3 and V = 6 — the range the
 * GENERATOR actually uses, where it holds to under 2%. It drifts high at
 * the bright end (19 against 15 at V ≤ 1), which does not matter and could
 * not: the authored table owns everything above magnitude 3.6, and a
 * power law was never going to describe fifteen individual stars.
 */
const COUNT_LAW_SLOPE = 0.4828;
const COUNT_LAW_INTERCEPT = 0.7847;

export function starsBrighterThan(magnitude: number): number {
  return 10 ** (COUNT_LAW_SLOPE * magnitude + COUNT_LAW_INTERCEPT);
}

/** Exact inverse of {@link starsBrighterThan}, for inverse-transform sampling. */
export function magnitudeForCumulativeCount(count: number): number {
  return (Math.log10(Math.max(count, 1e-6)) - COUNT_LAW_INTERCEPT) / COUNT_LAW_SLOPE;
}

/** North galactic pole, J2000 (α 192.859°, δ +27.128°). */
export const GALACTIC_POLE_EQUATORIAL: readonly [number, number, number] = Object.freeze(
  equatorialUnitVector(192.85948 / 15, 27.12825),
) as readonly [number, number, number];

/** Galactic centre, J2000 (α 266.405°, δ −28.936°) — Sagittarius. */
export const GALACTIC_CENTER_EQUATORIAL: readonly [number, number, number] = Object.freeze(
  equatorialUnitVector(266.40499 / 15, -28.93617),
) as readonly [number, number, number];

function hash01(seed: number): number {
  const value = Math.sin(seed * 127.1 + 311.7) * 43_758.5453;
  return value - Math.floor(value);
}

/**
 * The faint background, generated deterministically from a seed. Directions
 * are uniform on the sphere and then REJECTED against galactic latitude with
 * an `exp(−|sin b| / 0.28)` acceptance floor of 0.45, which concentrates the
 * fill toward the Milky Way at roughly the observed ratio (the plane carries
 * ~3× the pole's counts at these magnitudes). Colours run redder at the
 * faint end because the faint naked-eye population is dominated by K and M
 * dwarfs and distant reddened giants.
 */
export function generateBackgroundStars(seed = 1): readonly CatalogueStar[] {
  const target = Math.round(
    starsBrighterThan(STAR_FIELD_FAINTEST_MAGNITUDE)
    - starsBrighterThan(STAR_FIELD_AUTHORED_MAGNITUDE_LIMIT),
  );
  const stars: CatalogueStar[] = [];
  const faintest = STAR_FIELD_FAINTEST_MAGNITUDE;
  const brightest = STAR_FIELD_AUTHORED_MAGNITUDE_LIMIT;
  let attempt = 0;
  while (stars.length < target && attempt < target * 12) {
    const lane = seed * 7919 + attempt * 3;
    attempt += 1;
    const z = hash01(lane) * 2 - 1;
    const phi = hash01(lane + 1) * 2 * Math.PI;
    const radial = Math.sqrt(Math.max(0, 1 - z * z));
    const direction: [number, number, number] = [
      radial * Math.cos(phi),
      radial * Math.sin(phi),
      z,
    ];
    const sinGalacticLatitude =
      direction[0] * GALACTIC_POLE_EQUATORIAL[0]
      + direction[1] * GALACTIC_POLE_EQUATORIAL[1]
      + direction[2] * GALACTIC_POLE_EQUATORIAL[2];
    const acceptance = 0.45 + 0.55 * Math.exp(-Math.abs(sinGalacticLatitude) / 0.28);
    if (hash01(lane + 2) > acceptance) continue;
    // Inverse-transform the count law over [brightest, faintest] so the
    // generated population has the observed magnitude distribution.
    const u = hash01(lane + 3);
    const countBright = starsBrighterThan(brightest);
    const countFaint = starsBrighterThan(faintest);
    const magnitude = magnitudeForCumulativeCount(
      countBright + u * (countFaint - countBright),
    );
    stars.push(Object.freeze({
      equatorial: Object.freeze(direction) as readonly [number, number, number],
      magnitude,
      colorIndex: 0.25 + hash01(lane + 4) * 1.35,
    }));
  }
  return stars;
}

// ---------------------------------------------------------------------------
// The sky's frame.
// ---------------------------------------------------------------------------

/**
 * Local sidereal time, in hours, from the environment clock.
 *
 * The clock carries SOLAR time, so by definition the sun's hour angle is
 * `(solarTimeHours − 12) × 15°`, and `LST = α_sun + H`. That is one line and
 * it needs no longitude, no equation of time and no second solar model —
 * `Ephemeris.solarApparentPosition` supplies α_sun, and the sun's rendered
 * DIRECTION stays `EnvironmentDirector.sunDirectionForClock`'s (the two
 * agree to the ephemeris's own precision, asserted by test).
 */
export function localSiderealTimeHours(clock: EnvironmentClock): number {
  const sun = solarApparentPosition(clock);
  const lst = sun.rightAscensionHours + (clock.solarTimeHours - 12);
  return ((lst % 24) + 24) % 24;
}

/**
 * Rows of the 3×3 matrix taking an equatorial unit vector to world axes
 * (+x east, +y up, +z north) — the same convention `sunDirectionForClock`
 * uses.
 *
 * Derivation, so nobody re-derives it wrongly: with `H = LST − α` the star's
 * hour-angle-frame vector is `u = (cos δ cos H, cos δ sin H, sin δ)`, which
 * is linear in the equatorial vector `v`:
 *   `u = (cos L·v.x + sin L·v.y, sin L·v.x − cos L·v.y, v.z)`, `L = LST`.
 * The horizon frame then reads straight off the standard triangle:
 *   `east = −u.y`, `up = cos φ·u.x + sin φ·u.z`, `north = cos φ·u.z − sin φ·u.x`,
 * which is exactly the same set of terms `solarPosition` computes for the
 * sun — the sun rides this matrix too, and the test proves it.
 */
export function equatorialToWorldRows(
  localSiderealHours: number,
  latitudeDegrees: number,
): readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
] {
  const l = localSiderealHours * HOURS_TO_RADIANS;
  const cosL = Math.cos(l);
  const sinL = Math.sin(l);
  const phi = latitudeDegrees * DEGREES_TO_RADIANS;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  // east = −u.y = −(sinL·v.x − cosL·v.y)
  const east: readonly [number, number, number] = [-sinL, cosL, 0];
  // up = cosφ·u.x + sinφ·u.z
  const up: readonly [number, number, number] = [cosPhi * cosL, cosPhi * sinL, sinPhi];
  // north = cosφ·u.z − sinφ·u.x
  const north: readonly [number, number, number] = [-sinPhi * cosL, -sinPhi * sinL, cosPhi];
  return [east, up, north];
}

/** Applies {@link equatorialToWorldRows} to one vector. */
export function equatorialToWorld(
  equatorial: readonly [number, number, number],
  rows: ReturnType<typeof equatorialToWorldRows>,
): [number, number, number] {
  return [
    rows[0][0] * equatorial[0] + rows[0][1] * equatorial[1] + rows[0][2] * equatorial[2],
    rows[1][0] * equatorial[0] + rows[1][1] * equatorial[1] + rows[1][2] * equatorial[2],
    rows[2][0] * equatorial[0] + rows[2][1] * equatorial[1] + rows[2][2] * equatorial[2],
  ];
}

// ---------------------------------------------------------------------------
// Photometry.
// ---------------------------------------------------------------------------

/**
 * Illuminance of a magnitude-0 star outside the atmosphere, in lux
 * (2.54 × 10⁻⁶ lx is the standard V-band value). Every star's contribution
 * is this times `10^(−0.4·m)`, so the star field enters the SAME physical
 * illuminance budget the sun and moon use rather than an invented scale.
 */
export const ZERO_MAGNITUDE_ILLUMINANCE_LUX = 2.54e-6;

export function starIlluminanceLux(magnitude: number): number {
  return ZERO_MAGNITUDE_ILLUMINANCE_LUX * 10 ** (-0.4 * magnitude);
}

/**
 * V-band extinction coefficient at sea level, magnitudes per air mass. 0.20
 * is a clear-site value; it is what makes stars FADE OUT toward the horizon
 * instead of running into the ground, which the plan calls out by name.
 */
export const STAR_EXTINCTION_MAGNITUDES_PER_AIRMASS = 0.20;

/**
 * Kasten–Young (1989) relative air mass. Unlike `1/sin(alt)` it stays finite
 * at and below the horizon, which matters because a star field is drawn on a
 * dome that reaches below it.
 */
export function relativeAirMass(altitudeDegrees: number): number {
  const altitude = Math.max(altitudeDegrees, -2);
  const sinAltitude = Math.sin(altitude * DEGREES_TO_RADIANS);
  return 1 / (sinAltitude + 0.50572 * (altitude + 6.07995) ** -1.6364);
}

/** Extinguished magnitude at an altitude, for the sea-level coefficient. */
export function extinguishedMagnitude(
  magnitude: number,
  altitudeDegrees: number,
): number {
  if (altitudeDegrees <= -1) return Number.POSITIVE_INFINITY;
  return magnitude
    + STAR_EXTINCTION_MAGNITUDES_PER_AIRMASS * relativeAirMass(altitudeDegrees);
}

/**
 * Linear sRGB chromaticity for a Johnson B−V colour index, normalised to
 * luminance 1 so magnitude alone carries brightness. Ballesteros' relation
 * gives the temperature; the primaries come from a Planckian fit over the
 * 2,000–20,000 K range that stars actually occupy.
 */
export function colorForColorIndex(colorIndex: number): [number, number, number] {
  const bv = Math.min(2.0, Math.max(-0.4, colorIndex));
  // Ballesteros 2012: T = 4600 · (1/(0.92·BV + 1.7) + 1/(0.92·BV + 0.62)).
  const temperature = 4_600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const t = Math.min(20_000, Math.max(1_800, temperature)) / 1_000;
  // Smooth Planckian-locus fit in linear sRGB; monotone in temperature.
  const red = t < 6.6 ? 1 : Math.min(1, 1.29 * t ** -0.55);
  const green = t < 6.6
    ? Math.min(1, 0.39 * Math.log(t) + 0.34)
    : Math.min(1, 1.13 * t ** -0.28);
  const blue = t < 2.0 ? 0 : t >= 6.6 ? 1 : Math.min(1, 0.55 * Math.log(t - 1.5) + 0.12);
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  if (!(luminance > 0)) return [1, 1, 1];
  return [red / luminance, green / luminance, blue / luminance];
}
