export function decodeHtmlEntities(value) {
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

export function htmlToReadableText(html) {
  const withoutScripts = String(html ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  const blockAware = withoutScripts
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|li|ul|ol|h[1-6]|table|tr)>/gi, "\n");

  return decodeHtmlEntities(blockAware.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function chooseReadableText(contentType, decodedText) {
  const ct = String(contentType ?? "").toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml+xml")) {
    return htmlToReadableText(decodedText);
  }
  return decodedText;
}

export async function webFetch({ url, maxBytes = 200_000, timeoutMs = 20_000 }) {
  const u = String(url ?? "").trim();
  if (!u) throw new Error("Missing url.");
  if (!/^https?:\/\//i.test(u)) throw new Error("Only http(s) URLs are allowed.");

  const limit = Math.max(10_000, Math.min(500_000, Number(maxBytes) || 200_000));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(u, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "t560-web-fetch" },
      signal: ctrl.signal,
    });
    const contentType = String(res.headers.get("content-type") ?? "");
    const buf = new Uint8Array(await res.arrayBuffer());
    const truncated = buf.byteLength > limit;
    const slice = truncated ? buf.slice(0, limit) : buf;
    const decoded = new TextDecoder().decode(slice);
    const text = chooseReadableText(contentType, decoded);
    return {
      ok: res.ok,
      status: res.status,
      url: res.url || u,
      contentType,
      truncated,
      bytes: slice.byteLength,
      text,
    };
  } finally {
    clearTimeout(t);
  }
}
