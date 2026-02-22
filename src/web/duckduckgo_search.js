function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/")
    .replace(/&#47;/g, "/")
    .replace(/&nbsp;/g, " ");
}

function stripTags(value) {
  return decodeHtmlEntities(
    String(value ?? "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function toAbsoluteDuckUrl(href) {
  const raw = String(href ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.startsWith("/")) return `https://duckduckgo.com${raw}`;
  return raw;
}

function resolveResultUrl(href) {
  const raw = String(href ?? "").trim();
  if (!raw) return "";
  const absolute = toAbsoluteDuckUrl(raw);
  try {
    const url = new URL(absolute);
    const host = url.hostname.toLowerCase();
    if (host.includes("duckduckgo.com")) {
      const redirected = url.searchParams.get("uddg");
      if (redirected) {
        const decoded = decodeURIComponent(redirected);
        if (/^https?:\/\//i.test(decoded)) {
          return decoded;
        }
      }
      if (url.pathname === "/l/" || url.pathname === "/l") {
        return "";
      }
    }
    if (!/^https?:$/i.test(url.protocol)) {
      return "";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function extractSnippetNear(html, startIdx, endIdx) {
  const windowStart = Math.max(0, startIdx - 220);
  const windowEnd = Math.min(html.length, endIdx + 900);
  const nearby = html.slice(windowStart, windowEnd);

  const snippetPatterns = [
    /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    /class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    /class="[^"]*snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i,
  ];
  for (const pattern of snippetPatterns) {
    const match = pattern.exec(nearby);
    if (match && match[1]) {
      const text = stripTags(match[1]);
      if (text) return text;
    }
  }

  const generic = stripTags(nearby);
  if (!generic) return "";
  return generic.length > 280 ? `${generic.slice(0, 280)}...` : generic;
}

export function parseDuckDuckGoHtml(html, count = 8) {
  const source = String(html ?? "");
  const max = Math.max(1, Math.min(20, Number(count) || 8));
  const out = [];
  const seen = new Set();

  const anchorPattern = /<a\b([^>]*?)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(source)) && out.length < max) {
    const href = match[2];
    const title = stripTags(match[4]);
    if (!title || title.length < 2) continue;

    const url = resolveResultUrl(href);
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const description = extractSnippetNear(source, match.index, anchorPattern.lastIndex);
    out.push({ title, url, description });
  }

  return out;
}

async function fetchSearchHtml({ url, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) t560/1.0 Safari/537.36",
      },
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(text || `DuckDuckGo search error (status ${res.status})`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function duckDuckGoSearch({ query, count = 8, timeoutMs = 15_000, region = "wt-wt" }) {
  const q = String(query ?? "").trim();
  if (!q) throw new Error("Missing query.");

  const n = Math.max(1, Math.min(20, Number(count) || 8));
  const t = Math.max(1000, Math.min(120_000, Number(timeoutMs) || 15_000));
  const kl = String(region ?? "wt-wt").trim() || "wt-wt";

  const endpoints = [
    (() => {
      const u = new URL("https://duckduckgo.com/html/");
      u.searchParams.set("q", q);
      u.searchParams.set("kl", kl);
      u.searchParams.set("kp", "-1");
      return u.toString();
    })(),
    (() => {
      const u = new URL("https://lite.duckduckgo.com/lite/");
      u.searchParams.set("q", q);
      u.searchParams.set("kl", kl);
      u.searchParams.set("kp", "-1");
      return u.toString();
    })(),
  ];

  let lastError;
  for (const endpoint of endpoints) {
    try {
      const html = await fetchSearchHtml({ url: endpoint, timeoutMs: t });
      const parsed = parseDuckDuckGoHtml(html, n);
      if (parsed.length > 0) {
        return parsed.slice(0, n);
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }
  return [];
}

export const __testing = {
  decodeHtmlEntities,
  stripTags,
  resolveResultUrl,
  parseDuckDuckGoHtml,
};
