import { note as clackNote } from "@clack/prompts";
import { stylePromptTitle } from "./prompt-style.js";

function visibleWidth(value: string): number {
  return value.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function wrapLine(line: string, maxWidth: number): string[] {
  if (!line.trim()) {
    return [line];
  }

  const words = line.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    const candidate = `${current} ${word}`;
    if (visibleWidth(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
  }

  if (current) {
    lines.push(current);
  }
  return lines;
}

function wrapNoteMessage(message: string): string {
  const columns = process.stdout.columns ?? 80;
  const maxWidth = Math.max(40, Math.min(88, columns - 10));
  return message
    .split("\n")
    .flatMap((line) => wrapLine(line, maxWidth))
    .join("\n");
}

export function note(message: string, title?: string): void {
  clackNote(wrapNoteMessage(message), stylePromptTitle(title));
}
