type PriceQuote = {
  amount: number;
  currency: string;
  display: string;
};

type RawCandidate = {
  title: string;
  description: string;
  url: string;
  sourceTool: string;
};

export type EcommerceCandidate = {
  title: string;
  description: string;
  url: string;
  sourceTool: string;
  price: PriceQuote | null;
  relevanceScore: number;
};

const MAX_EXTRACTED_CANDIDATES = 120;
const PRICE_TOKEN = /(?:C\$|CA\$|CAD\$|US\$|USD\$|\$|€|£)\s*[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?/gi;
const PRICE_TRAILING = /([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)\s*(CAD|USD|EUR|GBP)\b/gi;
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "what",
  "find",
  "look",
  "into",
  "about",
  "your",
  "please",
  "cheapest",
  "cheap",
]);

function normalizeUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/i.test(parsed.protocol)) {
      return "";
    }
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      const lowered = key.toLowerCase();
      if (lowered.startsWith("utm_") || lowered === "fbclid" || lowered === "gclid") {
        parsed.searchParams.delete(key);
      }
    }
    const href = parsed.toString();
    return href.endsWith("/") ? href.slice(0, -1) : href;
  } catch {
    return "";
  }
}

function toDisplayPrice(currency: string, amount: number): string {
  if (!Number.isFinite(amount)) {
    return "";
  }
  const fixed = amount.toFixed(2);
  if (currency === "$") {
    return `$${fixed}`;
  }
  return `${currency}${fixed}`;
}

function parsePrice(text: string): PriceQuote | null {
  const source = String(text ?? "");

  const prefixed = PRICE_TOKEN.exec(source);
  PRICE_TOKEN.lastIndex = 0;
  if (prefixed) {
    const token = prefixed[0].trim();
    const amount = Number(token.replace(/[^0-9.]/g, "").replace(/,/g, ""));
    if (Number.isFinite(amount) && amount > 0 && amount < 1_000_000) {
      const currencyMatch = token.match(/C\$|CA\$|CAD\$|US\$|USD\$|\$|€|£/i);
      const currencyRaw = currencyMatch ? currencyMatch[0].toUpperCase() : "$";
      const currency =
        currencyRaw === "CAD$" || currencyRaw === "CA$"
          ? "C$"
          : currencyRaw === "US$" || currencyRaw === "USD$"
            ? "US$"
            : currencyRaw;
      return {
        amount,
        currency,
        display: toDisplayPrice(currency, amount),
      };
    }
  }

  const trailing = PRICE_TRAILING.exec(source);
  PRICE_TRAILING.lastIndex = 0;
  if (!trailing) {
    return null;
  }
  const amount = Number(String(trailing[1] ?? "").replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0 || amount >= 1_000_000) {
    return null;
  }
  const trailingCurrency = String(trailing[2] ?? "").toUpperCase();
  const currency =
    trailingCurrency === "CAD"
      ? "C$"
      : trailingCurrency === "USD"
        ? "US$"
        : trailingCurrency === "EUR"
          ? "EUR "
          : trailingCurrency === "GBP"
            ? "GBP "
            : trailingCurrency;
  return {
    amount,
    currency,
    display: toDisplayPrice(currency, amount),
  };
}

function tokenizeQuery(message: string): string[] {
  const parts = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 1 && !STOP_WORDS.has(entry));
  return Array.from(new Set(parts)).slice(0, 24);
}

function includesAny(text: string, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) {
      score += 2;
    }
  }
  return score;
}

function scoreCandidate(candidate: RawCandidate, queryTokens: string[]): number {
  const combined = `${candidate.title} ${candidate.description}`.toLowerCase();
  let score = includesAny(combined, queryTokens);
  score += includesAny(candidate.url.toLowerCase(), queryTokens);
  if (candidate.url.includes("/dp/") || candidate.url.includes("/gp/product/")) {
    score += 8;
  }
  if (/amazon\./i.test(candidate.url)) {
    score += 5;
  }
  if (/\b16\s*gb\b/i.test(combined)) {
    score += 4;
  }
  if (/\braspberry\s*pi\b/i.test(combined)) {
    score += 6;
  }
  return score;
}

function pushCandidate(
  out: RawCandidate[],
  seen: Set<string>,
  sourceTool: string,
  title: unknown,
  url: unknown,
  description: unknown,
): void {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl || seen.has(normalizedUrl)) {
    return;
  }
  seen.add(normalizedUrl);
  out.push({
    title: String(title ?? "").replace(/\s+/g, " ").trim(),
    description: String(description ?? "").replace(/\s+/g, " ").trim(),
    url: normalizedUrl,
    sourceTool,
  });
}

function collectCandidatesFromObject(
  value: unknown,
  sourceTool: string,
  out: RawCandidate[],
  seenUrls: Set<string>,
  budget: { remaining: number },
): void {
  if (budget.remaining <= 0 || out.length >= MAX_EXTRACTED_CANDIDATES) {
    return;
  }
  budget.remaining -= 1;

  if (value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 100)) {
      collectCandidatesFromObject(entry, sourceTool, out, seenUrls, budget);
      if (out.length >= MAX_EXTRACTED_CANDIDATES) {
        return;
      }
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const obj = value as Record<string, unknown>;
  if (obj.url !== undefined) {
    pushCandidate(out, seenUrls, sourceTool, obj.title ?? obj.name ?? obj.text, obj.url, obj.description ?? "");
  }

  if (Array.isArray(obj.results)) {
    for (const row of obj.results.slice(0, 60)) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const result = row as Record<string, unknown>;
      pushCandidate(out, seenUrls, sourceTool, result.title ?? result.name, result.url, result.description ?? "");
    }
  }

  if (obj.snapshot && typeof obj.snapshot === "object") {
    const snapshot = obj.snapshot as Record<string, unknown>;
    if (Array.isArray(snapshot.links)) {
      for (const row of snapshot.links.slice(0, 80)) {
        if (!row || typeof row !== "object") {
          continue;
        }
        const link = row as Record<string, unknown>;
        pushCandidate(out, seenUrls, sourceTool, link.text ?? link.name, link.url, snapshot.text ?? "");
      }
    }
  }

  for (const nested of Object.values(obj).slice(0, 80)) {
    collectCandidatesFromObject(nested, sourceTool, out, seenUrls, budget);
    if (out.length >= MAX_EXTRACTED_CANDIDATES) {
      return;
    }
  }
}

export function extractEcommerceCandidates(params: {
  query: string;
  outcomes: Array<{ toolName: string; content: string }>;
  limit?: number;
}): EcommerceCandidate[] {
  const rows: RawCandidate[] = [];
  const seen = new Set<string>();
  const budget = { remaining: 800 };

  for (const outcome of params.outcomes) {
    const raw = String(outcome.content ?? "");
    try {
      collectCandidatesFromObject(JSON.parse(raw), outcome.toolName, rows, seen, budget);
    } catch {
      collectCandidatesFromObject({ text: raw }, outcome.toolName, rows, seen, budget);
    }
    if (rows.length >= MAX_EXTRACTED_CANDIDATES) {
      break;
    }
  }

  const queryTokens = tokenizeQuery(params.query);
  const shaped = rows
    .map((row) => {
      const text = `${row.title} ${row.description}`.trim();
      const price = parsePrice(text);
      const relevanceScore = scoreCandidate(row, queryTokens) + (price ? 6 : 0);
      return {
        ...row,
        price,
        relevanceScore,
      } satisfies EcommerceCandidate;
    })
    .filter((row) => row.relevanceScore > 0 || row.price !== null);

  shaped.sort((a, b) => {
    const aHasPrice = a.price !== null;
    const bHasPrice = b.price !== null;
    if (aHasPrice && bHasPrice) {
      if (a.price!.amount !== b.price!.amount) {
        return a.price!.amount - b.price!.amount;
      }
      return b.relevanceScore - a.relevanceScore;
    }
    if (aHasPrice !== bHasPrice) {
      return aHasPrice ? -1 : 1;
    }
    return b.relevanceScore - a.relevanceScore;
  });

  const limit = Math.max(1, Math.min(20, Math.floor(Number(params.limit ?? 8))));
  return shaped.slice(0, limit);
}

export function pickCheapestCandidate(candidates: EcommerceCandidate[]): EcommerceCandidate | null {
  const priced = candidates.filter((row) => row.price !== null);
  if (priced.length === 0) {
    return null;
  }
  return priced.reduce((best, row) => {
    if (!best.price || !row.price) {
      return row;
    }
    if (row.price.amount < best.price.amount) {
      return row;
    }
    if (row.price.amount === best.price.amount && row.relevanceScore > best.relevanceScore) {
      return row;
    }
    return best;
  });
}
