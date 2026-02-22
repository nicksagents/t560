import { note as clackNote } from "@clack/prompts";
import { stylePromptTitle } from "./promptStyle.js";

const stripAnsi = (value) => value.replace(/\x1b\[[0-9;]*m/g, "");

const visibleWidth = (value) => stripAnsi(value).length;

function wrapLine(line, maxWidth) {
  if (line.trim().length === 0) return [line];
  const m = line.match(/^(\s*)([-*]\s+)?(.*)$/);
  const indent = m?.[1] ?? "";
  const bullet = m?.[2] ?? "";
  const content = m?.[3] ?? "";

  const firstPrefix = `${indent}${bullet}`;
  const nextPrefix = `${indent}${bullet ? " ".repeat(bullet.length) : ""}`;
  const firstWidth = Math.max(10, maxWidth - visibleWidth(firstPrefix));
  const nextWidth = Math.max(10, maxWidth - visibleWidth(nextPrefix));

  const words = content.split(/\s+/).filter(Boolean);
  const out = [];
  let current = "";
  let prefix = firstPrefix;
  let available = firstWidth;

  for (const w of words) {
    if (!current) {
      current = w;
      continue;
    }
    const candidate = `${current} ${w}`;
    if (visibleWidth(candidate) <= available) {
      current = candidate;
      continue;
    }
    out.push(prefix + current);
    prefix = nextPrefix;
    available = nextWidth;
    current = w;
  }

  out.push(prefix + current);
  return out;
}

export function note(message, title) {
  const columns = process.stdout.columns ?? 80;
  const maxWidth = Math.max(40, Math.min(88, columns - 10));
  const wrapped = String(message)
    .split("\n")
    .flatMap((line) => wrapLine(line, maxWidth))
    .join("\n");
  clackNote(wrapped, stylePromptTitle(title));
}

