import { Type } from "@mariozechner/pi-ai";
import type { AnyAgentTool } from "../pi-tools.types.js";
import { duckDuckGoSearch } from "../../web/duckduckgo_search.js";
import { webFetch } from "../../web/fetch.js";

const DEFAULT_FETCH_MAX_BYTES = 200_000;
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_SEARCH_COUNT = 8;
const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_SEARCH_FETCH_TOP = 0;
const DEFAULT_SEARCH_FETCH_MAX_BYTES = 120_000;
const MAX_FETCH_TEXT_CHARS = 40_000;

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

export function createWebSearchTool(): AnyAgentTool {
  return {
    name: "web_search",
    description:
      "Search the web using DuckDuckGo and optionally fetch top results for grounded excerpts.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      count: Type.Optional(Type.Number({ description: "Result count (1-20).", minimum: 1, maximum: 20 })),
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

      const count = clampInt(params.count, 1, 20, DEFAULT_SEARCH_COUNT);
      const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_SEARCH_TIMEOUT_MS);
      const region = String(params.region ?? "wt-wt").trim() || "wt-wt";
      const fetchTop = clampInt(params.fetchTop, 0, 5, DEFAULT_SEARCH_FETCH_TOP);
      const fetchMaxBytes = clampInt(
        params.fetchMaxBytes,
        10_000,
        400_000,
        DEFAULT_SEARCH_FETCH_MAX_BYTES,
      );

      const results = await duckDuckGoSearch({
        query,
        count,
        timeoutMs,
        region,
      });
      const pages = [];
      if (fetchTop > 0 && results.length > 0) {
        const top = results.slice(0, fetchTop);
        const hydrated = await Promise.all(
          top.map(async (row) => {
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
        query,
        region,
        count: results.length,
        results,
        fetchedPages: pages.length,
        pages,
      };
    },
  };
}

export function createWebFetchTool(): AnyAgentTool {
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

      const maxBytes = clampInt(params.maxBytes, 10_000, 500_000, DEFAULT_FETCH_MAX_BYTES);
      const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_FETCH_TIMEOUT_MS);
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
