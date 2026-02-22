import chalk, { Chalk } from "chalk";

const hasForceColor =
  typeof process.env.FORCE_COLOR === "string" &&
  process.env.FORCE_COLOR.trim().length > 0 &&
  process.env.FORCE_COLOR.trim() !== "0";

const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;

const hex = (value) => baseChalk.hex(value);

// Intentionally similar "vibe" to modern CLI wizards, but not a copy of any palette.
export const PALETTE = {
  accent: "#00B3A4",
  accentBright: "#00E6D3",
  warn: "#FFB020",
  error: "#FF4D4D",
  success: "#2ECC71",
  muted: "#9AA0A6",
};

export const theme = {
  accent: hex(PALETTE.accent),
  accentBright: hex(PALETTE.accentBright),
  muted: hex(PALETTE.muted),
  warn: hex(PALETTE.warn),
  error: hex(PALETTE.error),
  success: hex(PALETTE.success),
  heading: baseChalk.bold.hex(PALETTE.accent),
  command: hex(PALETTE.accentBright),
};

export const isRich = () => Boolean(baseChalk.level > 0);
