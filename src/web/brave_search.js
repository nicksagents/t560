function safeText(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

export async function braveWebSearch({ apiKey, query, count = 5, timeoutMs = 15_000 }) {
  const key = String(apiKey ?? "").trim();
  if (!key) throw new Error("Missing BRAVE_API_KEY.");
  const q = String(query ?? "").trim();
  if (!q) throw new Error("Missing query.");

  const n = Math.max(1, Math.min(10, Number(count) || 5));
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", q);
  url.searchParams.set("count", String(n));

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "X-Subscription-Token": key },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = json?.message || json?.error?.message || text || `Brave search error (status ${res.status})`;
      throw new Error(String(msg));
    }

    const items = Array.isArray(json?.web?.results) ? json.web.results : [];
    return items.slice(0, n).map((r) => ({
      title: safeText(r?.title),
      url: safeText(r?.url),
      description: safeText(r?.description),
    }));
  } finally {
    clearTimeout(t);
  }
}
