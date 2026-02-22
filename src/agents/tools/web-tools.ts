import { Type } from "@mariozechner/pi-ai";
import type { T560Config } from "../../config/state.js";
import type { AnyAgentTool } from "../pi-tools.types.js";
import { braveWebSearch } from "../../web/brave_search.js";
import { duckDuckGoSearch } from "../../web/duckduckgo_search.js";
import { webFetch } from "../../web/fetch.js";
import { extractEcommerceCandidates, pickCheapestCandidate } from "../ecommerce.js";

const DEFAULT_FETCH_MAX_BYTES = 200_000;
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_SEARCH_COUNT = 8;
const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_SEARCH_FETCH_TOP = 0;
const DEFAULT_SEARCH_FETCH_MAX_BYTES = 120_000;
const MAX_FETCH_TEXT_CHARS = 40_000;
const DEFAULT_SEARCH_PROVIDER = "brave";
const MAX_DOMAIN_FILTERS = 10;
const YEAR_PATTERN = /\b(20\d{2})\b/g;
const TEMPORAL_QUERY_PATTERN =
  /\b(current|latest|today|right now|now|live|standings|score|scores|medal|table|ranking|rankings|this year|happening)\b/i;

type WebSearchProvider = "brave" | "duckduckgo";

type WebToolOptions = {
  config?: T560Config;
  env?: NodeJS.ProcessEnv;
  sandboxed?: boolean;
};

type ResolvedWebSearchConfig = {
  enabled: boolean;
  provider: WebSearchProvider;
  configuredProvider: WebSearchProvider;
  apiKey?: string;
  defaultCount: number;
  timeoutMs: number;
  region: string;
  fetchTop: number;
  fetchMaxBytes: number;
};

type ResolvedWebFetchConfig = {
  enabled: boolean;
  maxBytes: number;
  timeoutMs: number;
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function clampFetchText(text: string): { text: string; truncatedForModel: boolean } {
  if (text.length <= MAX_FETCH_TEXT_CHARS) {
    return { text, truncatedForModel: false };
  }
  return {
    text: `${text.slice(0, MAX_FETCH_TEXT_CHARS)}\n\n[truncated for model context]`,
    truncatedForModel: true,
  };
}

function toTextPreview(value: string, maxChars = 2500): string {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...`;
}

function normalizeSearchProvider(value: unknown): WebSearchProvider | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "duckduckgo") {
    return "duckduckgo";
  }
  if (normalized === "brave") {
    return "brave";
  }
  return null;
}

function normalizeDomain(value: unknown): string | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) {
    return null;
  }
  const host = raw.replace(/^https?:\/\//i, "").replace(/^www\./, "").split("/")[0] ?? "";
  if (!host || !/^[a-z0-9.-]+$/.test(host)) {
    return null;
  }
  return host;
}

function normalizeDomainList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const unique = new Set<string>();
  for (const entry of value) {
    const domain = normalizeDomain(entry);
    if (!domain) {
      continue;
    }
    unique.add(domain);
    if (unique.size >= MAX_DOMAIN_FILTERS) {
      break;
    }
  }
  return Array.from(unique);
}

function applyRecencyHint(query: string, recencyDays: number): string {
  if (recencyDays <= 0) {
    return query;
  }
  if (recencyDays <= 1) {
    return `${query} past 24 hours`;
  }
  if (recencyDays <= 7) {
    return `${query} past week`;
  }
  if (recencyDays <= 31) {
    return `${query} past month`;
  }
  return `${query} past year`;
}

function extractYears(text: string): number[] {
  const years = new Set<number>();
  const source = String(text ?? "");
  let match: RegExpExecArray | null = null;
  while ((match = YEAR_PATTERN.exec(source)) !== null) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) {
      years.add(value);
    }
  }
  YEAR_PATTERN.lastIndex = 0;
  return Array.from(years);
}

function hasTemporalIntent(query: string): boolean {
  return TEMPORAL_QUERY_PATTERN.test(String(query ?? ""));
}

function hasExplicitYear(query: string): boolean {
  return /\b20\d{2}\b/.test(String(query ?? ""));
}

function buildTemporalAnchoredQuery(query: string): {
  queryUsed: string;
  temporalIntent: boolean;
  anchorYear: number | null;
  anchored: boolean;
} {
  const temporalIntent = hasTemporalIntent(query);
  const anchorYear = temporalIntent ? new Date().getUTCFullYear() : null;
  if (!temporalIntent || anchorYear === null || hasExplicitYear(query)) {
    return {
      queryUsed: query,
      temporalIntent,
      anchorYear,
      anchored: false,
    };
  }
  return {
    queryUsed: `${query} ${anchorYear}`,
    temporalIntent,
    anchorYear,
    anchored: true,
  };
}

function canonicalizeResultUrl(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "";
  }
  try {
    const parsed = new URL(value);
    if (!/^https?:$/i.test(parsed.protocol)) {
      return "";
    }
    for (const key of [...parsed.searchParams.keys()]) {
      const lowered = key.toLowerCase();
      if (lowered.startsWith("utm_") || lowered === "fbclid" || lowered === "gclid") {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = "";
    const href = parsed.toString();
    return href.endsWith("/") ? href.slice(0, -1) : href;
  } catch {
    return "";
  }
}

function resultMatchesDomains(url: string, domains: string[]): boolean {
  if (domains.length === 0) {
    return true;
  }
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function queryTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 1);
  return Array.from(new Set(terms)).slice(0, 24);
}

function scoreResult(params: {
  query: string;
  title: string;
  description: string;
  url: string;
  domains: string[];
  temporalIntent: boolean;
  anchorYear: number | null;
}): number {
  const haystack = `${params.title} ${params.description}`.toLowerCase();
  const terms = queryTerms(params.query);
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += 2;
    }
    if (params.url.toLowerCase().includes(term)) {
      score += 1;
    }
  }
  if (resultMatchesDomains(params.url, params.domains)) {
    score += 5;
  }
  if (/\/dp\/|\/gp\/product\//i.test(params.url)) {
    score += 2;
  }
  if (params.temporalIntent && params.anchorYear !== null) {
    const years = extractYears(`${params.title} ${params.description} ${params.url}`);
    if (years.includes(params.anchorYear)) {
      score += 10;
    } else if (years.length > 0) {
      const nearest = years.reduce((best, year) => Math.min(best, Math.abs(year - params.anchorYear!)), 100);
      score -= Math.min(12, nearest * 3);
      if (years.some((year) => year <= params.anchorYear! - 2)) {
        score -= 6;
      }
    } else {
      score += 1;
    }
  }
  return score;
}

function shapeAndRankResults(params: {
  query: string;
  rawResults: Array<{ title?: string; url?: string; description?: string }>;
  domains: string[];
  count: number;
  temporalIntent: boolean;
  anchorYear: number | null;
}): Array<{ title: string; url: string; description: string }> {
  const deduped: Array<{ title: string; url: string; description: string; score: number; years: number[] }> = [];
  const seen = new Set<string>();

  for (const row of params.rawResults) {
    const url = canonicalizeResultUrl(row.url);
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    if (!resultMatchesDomains(url, params.domains)) {
      continue;
    }
    const title = String(row.title ?? "").trim();
    const description = String(row.description ?? "").trim();
    deduped.push({
      title,
      url,
      description,
      years: extractYears(`${title} ${description} ${url}`),
      score: scoreResult({
        query: params.query,
        title,
        description,
        url,
        domains: params.domains,
        temporalIntent: params.temporalIntent,
        anchorYear: params.anchorYear,
      }),
    });
  }

  const anchorYear = params.anchorYear;
  const filtered =
    params.temporalIntent && anchorYear !== null
      ? (() => {
          const matching = deduped.filter((entry) => entry.years.includes(anchorYear));
          if (matching.length === 0) {
            return deduped;
          }
          const unknownYear = deduped.filter((entry) => entry.years.length === 0);
          return [...matching, ...unknownYear];
        })()
      : deduped;

  return filtered
    .sort((a, b) => b.score - a.score)
    .slice(0, params.count)
    .map((entry) => ({
      title: entry.title,
      url: entry.url,
      description: entry.description,
    }));
}

async function fetchSearchPagePreview(params: {
  url: string;
  maxBytes: number;
  timeoutMs: number;
}) {
  const fetched = await webFetch({
    url: params.url,
    maxBytes: params.maxBytes,
    timeoutMs: params.timeoutMs,
  });
  const text = String(fetched?.text ?? "");
  return {
    ok: Boolean(fetched?.ok),
    status: Number(fetched?.status ?? 0),
    url: String(fetched?.url ?? params.url),
    contentType: String(fetched?.contentType ?? ""),
    truncated: Boolean(fetched?.truncated),
    bytes: Number(fetched?.bytes ?? 0),
    textPreview: toTextPreview(text),
  };
}

function resolveWebSearchProvider(value: unknown): WebSearchProvider {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "duckduckgo") {
    return "duckduckgo";
  }
  return "brave";
}

function resolveWebSearchConfig(options?: WebToolOptions): ResolvedWebSearchConfig {
  const env = options?.env ?? process.env;
  const search = options?.config?.tools?.web?.search;
  const providerRaw = typeof search?.provider === "string" ? search.provider.trim() : "";
  const providerExplicit = providerRaw.length > 0;
  const configuredProvider = resolveWebSearchProvider(search?.provider ?? DEFAULT_SEARCH_PROVIDER);
  const apiKeyFromConfig = String(search?.apiKey ?? "").trim();
  const apiKeyFromEnv = String(env.BRAVE_API_KEY ?? "").trim();
  const apiKey = apiKeyFromConfig || apiKeyFromEnv || undefined;
  const provider =
    !providerExplicit && configuredProvider === "brave" && !apiKey ? "duckduckgo" : configuredProvider;
  const explicitEnabled = typeof search?.enabled === "boolean" ? search.enabled : undefined;
  const enabled = explicitEnabled ?? (provider === "brave" ? Boolean(apiKey) : true);
  const maxCount = provider === "brave" ? 10 : 20;
  const defaultCount = clampInt(search?.maxResults, 1, maxCount, DEFAULT_SEARCH_COUNT);
  const timeoutMs = clampInt(search?.timeoutMs, 1000, 120000, DEFAULT_SEARCH_TIMEOUT_MS);
  const region = String(search?.region ?? "wt-wt").trim() || "wt-wt";
  const fetchTop = clampInt(search?.fetchTop, 0, 5, DEFAULT_SEARCH_FETCH_TOP);
  const fetchMaxBytes = clampInt(search?.fetchMaxBytes, 10_000, 400_000, DEFAULT_SEARCH_FETCH_MAX_BYTES);
  return {
    enabled,
    provider,
    configuredProvider,
    apiKey,
    defaultCount,
    timeoutMs,
    region,
    fetchTop,
    fetchMaxBytes,
  };
}

function resolveWebFetchConfig(options?: WebToolOptions): ResolvedWebFetchConfig {
  const fetch = options?.config?.tools?.web?.fetch;
  const enabled = typeof fetch?.enabled === "boolean" ? fetch.enabled : true;
  const maxBytes = clampInt(fetch?.maxBytes, 10_000, 500_000, DEFAULT_FETCH_MAX_BYTES);
  const timeoutMs = clampInt(fetch?.timeoutMs, 1000, 120000, DEFAULT_FETCH_TIMEOUT_MS);
  return {
    enabled,
    maxBytes,
    timeoutMs,
  };
}

export function createWebSearchTool(options?: WebToolOptions): AnyAgentTool | null {
  void options?.sandboxed;
  const config = resolveWebSearchConfig(options);
  if (!config.enabled) {
    return null;
  }
  if (config.provider === "brave" && !config.apiKey) {
    return null;
  }

  return {
    name: "web_search",
    description:
      "Search the web for up-to-date information (Brave when configured, automatic DuckDuckGo fallback without keys) and optionally fetch top results for grounded excerpts.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      count: Type.Optional(Type.Number({ description: "Result count (1-20).", minimum: 1, maximum: 20 })),
      provider: Type.Optional(Type.String({ description: "Optional provider override (brave or duckduckgo)." })),
      domains: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional domain filters (for example [\"amazon.ca\", \"raspberrypi.com\"]).",
          maxItems: MAX_DOMAIN_FILTERS,
        }),
      ),
      recency: Type.Optional(
        Type.Number({
          description: "Optional recency hint in days (for example 1 for last day, 7 for last week).",
          minimum: 1,
          maximum: 365,
        }),
      ),
      region: Type.Optional(Type.String({ description: "DuckDuckGo region code (for example: wt-wt, us-en)." })),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Network timeout in milliseconds (1000-120000).",
          minimum: 1000,
          maximum: 120000,
        }),
      ),
      fetchTop: Type.Optional(
        Type.Number({
          description: "Fetch and summarize top N search results (0-5).",
          minimum: 0,
          maximum: 5,
        }),
      ),
      fetchMaxBytes: Type.Optional(
        Type.Number({
          description: "Per-page fetch byte limit when fetchTop > 0 (10000-400000).",
          minimum: 10_000,
          maximum: 400_000,
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const query = String(params.query ?? "").trim();
      if (!query) {
        throw new Error("query is required.");
      }

      const requestedProvider = normalizeSearchProvider(params.provider);
      if (params.provider !== undefined && !requestedProvider) {
        throw new Error('provider must be "brave" or "duckduckgo".');
      }

      const provider = requestedProvider ?? config.provider;
      if (provider === "brave" && !config.apiKey) {
        throw new Error("Brave provider requires BRAVE_API_KEY.");
      }

      const maxCount = provider === "brave" ? 10 : 20;
      const count = clampInt(params.count, 1, maxCount, config.defaultCount);
      const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, config.timeoutMs);
      const region = String(params.region ?? config.region).trim() || config.region;
      const fetchTop = clampInt(params.fetchTop, 0, 5, config.fetchTop);
      const fetchMaxBytes = clampInt(params.fetchMaxBytes, 10_000, 400_000, config.fetchMaxBytes);
      const recencyDays = clampInt(params.recency, 1, 365, 0);
      const domains = normalizeDomainList(params.domains);

      const temporal = buildTemporalAnchoredQuery(query);
      const runQuery = applyRecencyHint(temporal.queryUsed, recencyDays);
      let rawResults: Array<{ title?: string; url?: string; description?: string }> = [];
      let providerUsed = provider;
      let runtimeFallbackFrom: WebSearchProvider | undefined;
      let providerError: string | undefined;

      if (provider === "brave") {
        try {
          rawResults = await braveWebSearch({
            apiKey: config.apiKey,
            query: runQuery,
            count,
            timeoutMs,
          });
        } catch (error) {
          providerError = error instanceof Error ? error.message : String(error);
          if (!requestedProvider) {
            providerUsed = "duckduckgo";
            runtimeFallbackFrom = "brave";
            rawResults = await duckDuckGoSearch({
              query: runQuery,
              count,
              timeoutMs,
              region,
            });
          } else {
            throw error;
          }
        }
      } else {
        rawResults = await duckDuckGoSearch({
          query: runQuery,
          count,
          timeoutMs,
          region,
        });
      }

      const results = shapeAndRankResults({
        query: runQuery,
        rawResults,
        domains,
        count,
        temporalIntent: temporal.temporalIntent,
        anchorYear: temporal.anchorYear,
      });
      const products = extractEcommerceCandidates({
        query,
        outcomes: [
          {
            toolName: "web_search",
            content: JSON.stringify({
              results,
            }),
          },
        ],
        limit: 8,
      });
      const cheapest = pickCheapestCandidate(products);

      const pages = [];
      if (fetchTop > 0 && results.length > 0) {
        const top = results.slice(0, fetchTop);
        const hydrated = await Promise.all(
          top.map(async (row: { title?: string; url?: string }) => {
            try {
              const preview = await fetchSearchPagePreview({
                url: String(row.url ?? ""),
                maxBytes: fetchMaxBytes,
                timeoutMs,
              });
              return {
                title: row.title,
                ...preview,
              };
            } catch (error) {
              return {
                title: row.title,
                url: row.url,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }),
        );
        pages.push(...hydrated);
      }

      return {
        provider: providerUsed,
        configuredProvider: config.configuredProvider,
        fallbackFrom:
          runtimeFallbackFrom ??
          (providerUsed !== config.configuredProvider ? config.configuredProvider : undefined),
        providerError,
        query,
        queryUsed: runQuery,
        temporalIntent: temporal.temporalIntent,
        anchorYear: temporal.anchorYear ?? undefined,
        queryAnchoredToCurrentYear: temporal.anchored || undefined,
        recencyDays: recencyDays > 0 ? recencyDays : undefined,
        domains: domains.length > 0 ? domains : undefined,
        region: providerUsed === "duckduckgo" ? region : undefined,
        count: results.length,
        results,
        products: products.length > 0 ? products : undefined,
        cheapest:
          cheapest && cheapest.price
            ? {
                title: cheapest.title,
                url: cheapest.url,
                price: cheapest.price,
                sourceTool: cheapest.sourceTool,
              }
            : undefined,
        fetchedPages: pages.length,
        pages,
      };
    },
  };
}

export function createWebFetchTool(options?: WebToolOptions): AnyAgentTool | null {
  void options?.sandboxed;
  const config = resolveWebFetchConfig(options);
  if (!config.enabled) {
    return null;
  }

  return {
    name: "web_fetch",
    description:
      "Fetch an HTTP/HTTPS URL and return a readable text snapshot for grounding answers.",
    parameters: Type.Object({
      url: Type.String({ description: "HTTP/HTTPS URL to fetch." }),
      maxBytes: Type.Optional(
        Type.Number({
          description: "Maximum download size in bytes (10000-500000).",
          minimum: 10_000,
          maximum: 500_000,
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Network timeout in milliseconds (1000-120000).",
          minimum: 1000,
          maximum: 120000,
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const url = String(params.url ?? "").trim();
      if (!url) {
        throw new Error("url is required.");
      }

      const maxBytes = clampInt(params.maxBytes, 10_000, 500_000, config.maxBytes);
      const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, config.timeoutMs);
      const fetched = await webFetch({
        url,
        maxBytes,
        timeoutMs,
      });
      const text = String(fetched?.text ?? "");
      const clamped = clampFetchText(text);

      return {
        ok: Boolean(fetched?.ok),
        status: Number(fetched?.status ?? 0),
        url: String(fetched?.url ?? url),
        contentType: String(fetched?.contentType ?? ""),
        truncated: Boolean(fetched?.truncated),
        bytes: Number(fetched?.bytes ?? 0),
        truncatedForModel: clamped.truncatedForModel,
        text: clamped.text,
      };
    },
  };
}
