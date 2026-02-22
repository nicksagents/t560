import pc from "picocolors";


const hasForceColor =
  typeof process.env.FORCE_COLOR === "string" &&
  process.env.FORCE_COLOR.trim().length > 0 &&
  process.env.FORCE_COLOR.trim() !== "0";

const rich = () => Boolean(process.stdout.isTTY && (hasForceColor || !process.env.NO_COLOR));

function hexFg(value: string): (input: string) => string {
  const normalized = value.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return (input) => input;
  }
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return (input) => `\u001b[38;2;${r};${g};${b}m${input}\u001b[0m`;
}

function hexBg(value: string): (input: string) => string {
  const normalized = value.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return (input) => input;
  }
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return (input) => `\u001b[48;2;${r};${g};${b}m${input}\u001b[0m`;
}

// OpenClaw-matched palette
const palette = {
  // Core text
  text: "#E8E3D5",
  dim: "#7B7F87",
  systemText: "#9BA3B2",

  // Accents (t560 branding: keep the warm orange)
  accent: "#F6C453",
  accentSoft: "#F2A65A",
  accentBright: "#FF7A3D",
  accentDim: "#D14A22",

  // Semantic
  info: "#FF8A5B",
  success: "#7DD3A5",
  warn: "#FFB020",
  error: "#F97066",

  // User messages
  userBg: "#2B2F36",
  userText: "#F3EEE0",

  // Tool execution
  toolTitle: "#F6C453",
  toolOutput: "#E1DACB",
  toolPendingBg: "#1F2A2F",
  toolSuccessBg: "#1E2D23",
  toolErrorBg: "#2F1F1F",

  // Code
  code: "#F0C987",
  codeBlock: "#1E232A",
  codeBorder: "#343A45",

  // Markdown
  link: "#7DD3A5",
  quote: "#8CC8FF",
  quoteBorder: "#3B4D6B",
  border: "#3C414B",
} as const;

export const theme = {
  // Foreground
  fg: (v: string) => (rich() ? hexFg(palette.text)(v) : v),
  dim: (v: string) => (rich() ? hexFg(palette.dim)(v) : v),
  system: (v: string) => (rich() ? hexFg(palette.systemText)(v) : v),
  accent: (v: string) => (rich() ? hexFg(palette.accent)(v) : v),
  accentSoft: (v: string) => (rich() ? hexFg(palette.accentSoft)(v) : v),
  accentBright: (v: string) => (rich() ? hexFg(palette.accentBright)(v) : v),
  accentDim: (v: string) => (rich() ? hexFg(palette.accentDim)(v) : v),
  info: (v: string) => (rich() ? hexFg(palette.info)(v) : v),
  success: (v: string) => (rich() ? hexFg(palette.success)(v) : v),
  warn: (v: string) => (rich() ? hexFg(palette.warn)(v) : v),
  error: (v: string) => (rich() ? hexFg(palette.error)(v) : v),
  muted: (v: string) => (rich() ? hexFg(palette.dim)(v) : v),

  // User message
  userText: (v: string) => (rich() ? hexFg(palette.userText)(v) : v),
  userBg: (v: string) => (rich() ? hexBg(palette.userBg)(v) : v),

  // Tool
  toolTitle: (v: string) => (rich() ? hexFg(palette.toolTitle)(v) : v),
  toolOutput: (v: string) => (rich() ? hexFg(palette.toolOutput)(v) : v),
  toolPendingBg: (v: string) => (rich() ? hexBg(palette.toolPendingBg)(v) : v),
  toolSuccessBg: (v: string) => (rich() ? hexBg(palette.toolSuccessBg)(v) : v),
  toolErrorBg: (v: string) => (rich() ? hexBg(palette.toolErrorBg)(v) : v),

  // Code & markdown
  code: (v: string) => (rich() ? hexFg(palette.code)(v) : v),
  codeBorder: (v: string) => (rich() ? hexFg(palette.codeBorder)(v) : v),
  link: (v: string) => (rich() ? hexFg(palette.link)(v) : v),
  quote: (v: string) => (rich() ? hexFg(palette.quote)(v) : v),
  quoteBorder: (v: string) => (rich() ? hexFg(palette.quoteBorder)(v) : v),
  border: (v: string) => (rich() ? hexFg(palette.border)(v) : v),

  // Composite styles
  heading: (v: string) => (rich() ? pc.bold(hexFg(palette.accent)(v)) : v),
  header: (v: string) => (rich() ? pc.bold(hexFg(palette.accent)(v)) : v),
  bold: (v: string) => (rich() ? pc.bold(v) : v),
  italic: (v: string) => (rich() ? pc.italic(v) : v),
  strikethrough: (v: string) => (rich() ? pc.strikethrough(v) : v),

  // Aliases for backward compat
  thinking: (v: string) => (rich() ? hexFg(palette.accent)(v) : v),
  toolCall: (v: string) => (rich() ? hexFg(palette.accentSoft)(v) : v),
  command: (v: string) => (rich() ? hexFg(palette.accentBright)(v) : v),
  option: (v: string) => (rich() ? hexFg(palette.warn)(v) : v),
} as const;

export const isRich = (): boolean => rich();

export const colorize = (enabled: boolean, color: (value: string) => string, value: string): string =>
  enabled ? color(value) : value;
