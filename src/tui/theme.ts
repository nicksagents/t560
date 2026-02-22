import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@mariozechner/pi-tui";
import pc from "picocolors";
import { theme as baseTheme } from "../cli/theme.js";

export const theme = {
  ...baseTheme,
  assistantText: (text: string) => text,
  header: (text: string) => baseTheme.header(text),
} as const;

export const markdownTheme: MarkdownTheme = {
  heading: (text) => pc.bold(baseTheme.accent(text)),
  link: (text) => baseTheme.link(text),
  linkUrl: (text) => baseTheme.dim(text),
  code: (text) => baseTheme.code(text),
  codeBlock: (text) => baseTheme.code(text),
  codeBlockBorder: (text) => baseTheme.codeBorder(text),
  quote: (text) => baseTheme.quote(text),
  quoteBorder: (text) => baseTheme.quoteBorder(text),
  hr: (text) => baseTheme.border(text),
  listBullet: (text) => baseTheme.accentSoft(text),
  bold: (text) => pc.bold(text),
  italic: (text) => pc.italic(text),
  strikethrough: (text) => pc.strikethrough(text),
  underline: (text) => pc.underline(text),
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => baseTheme.accent(text),
  selectedText: (text) => pc.bold(baseTheme.accent(text)),
  description: (text) => baseTheme.dim(text),
  scrollInfo: (text) => baseTheme.dim(text),
  noMatch: (text) => baseTheme.dim(text),
};

export const editorTheme: EditorTheme = {
  borderColor: (text) => baseTheme.border(text),
  selectList: selectListTheme,
};
