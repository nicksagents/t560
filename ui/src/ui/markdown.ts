import { marked } from "marked";
import DOMPurify from "dompurify";

const MARKDOWN_PARSE_LIMIT = 40_000;
const MARKDOWN_CHAR_LIMIT = 140_000;

/** Allowed HTML tags matching OpenClaw's sanitization policy */
const ALLOWED_TAGS = [
  "a", "b", "blockquote", "br", "code", "del", "em",
  "h1", "h2", "h3", "h4", "hr", "i", "li", "ol", "p", "pre",
  "strong", "table", "tbody", "td", "th", "thead", "tr", "ul", "img",
];

const ALLOWED_ATTR = ["href", "title", "alt", "src", "class", "dir"];

/** Simple LRU cache for rendered markdown */
const cache = new Map<string, string>();
const CACHE_MAX = 200;

function evictCache(): void {
  if (cache.size > CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
}

/** Detect RTL scripts in text */
const RTL_RE = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0780-\u07BF\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

export function detectDirection(text: string): "rtl" | "ltr" {
  return RTL_RE.test(text) ? "rtl" : "ltr";
}

/** Render markdown to sanitized HTML */
export function renderMarkdown(raw: string): string {
  // Check cache
  const cached = cache.get(raw);
  if (cached) return cached;

  // Length limits
  let text = raw;
  let truncated = false;
  if (text.length > MARKDOWN_PARSE_LIMIT) {
    text = text.slice(0, MARKDOWN_PARSE_LIMIT);
    truncated = true;
  }

  // Parse markdown
  const html = marked.parse(text, { async: false }) as string;

  // Sanitize
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
  });

  // Display truncation
  let result = clean;
  if (truncated || raw.length > MARKDOWN_CHAR_LIMIT) {
    result += `<p class="muted" style="font-style:italic;margin-top:8px">[Content truncated — ${raw.length.toLocaleString()} characters]</p>`;
  }

  // Cache it
  evictCache();
  cache.set(raw, result);

  return result;
}

/** Render plain text (escape HTML) */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
