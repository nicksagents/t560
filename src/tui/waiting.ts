type MinimalTheme = {
  dim: (s: string) => string;
  bold: (s: string) => string;
  accentSoft: (s: string) => string;
};

export const defaultWaitingPhrases = [
  "flibbertigibbeting",
  "kerfuffling",
  "dillydallying",
  "twiddling thumbs",
  "noodling",
  "bamboozling",
  "moseying",
  "hobnobbing",
  "pondering",
  "conjuring",
];

export function pickWaitingPhrase(tick: number, phrases = defaultWaitingPhrases): string {
  const idx = Math.floor(tick / 10) % phrases.length;
  return phrases[idx] ?? "waiting";
}

export function shimmerText(theme: MinimalTheme, text: string, tick: number): string {
  const width = 6;
  const hi = (ch: string) => theme.bold(theme.accentSoft(ch));
  const pos = tick % (text.length + width);
  const start = Math.max(0, pos - width);
  const end = Math.min(text.length - 1, pos);

  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    out += i >= start && i <= end ? hi(ch) : theme.dim(ch);
  }
  return out;
}

export function buildWaitingStatusMessage(params: {
  theme: MinimalTheme;
  tick: number;
  elapsed: string;
  connectionStatus: string;
  phrase?: string;
}): string {
  const phrase = params.phrase ?? pickWaitingPhrase(params.tick, defaultWaitingPhrases);
  const cute = shimmerText(params.theme, `${phrase}…`, params.tick);
  return `${cute} • ${params.elapsed} | ${params.connectionStatus}`;
}
