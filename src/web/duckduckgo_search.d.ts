export type DuckDuckGoSearchResult = {
  title: string;
  url: string;
  description: string;
};

export function parseDuckDuckGoHtml(
  html: string,
  count?: number,
): DuckDuckGoSearchResult[];

export function duckDuckGoSearch(params: {
  query: string;
  count?: number;
  timeoutMs?: number;
  region?: string;
}): Promise<DuckDuckGoSearchResult[]>;

export const __testing: {
  decodeHtmlEntities(value: unknown): string;
  stripTags(value: unknown): string;
  resolveResultUrl(href: unknown): string;
  parseDuckDuckGoHtml(html: string, count?: number): DuckDuckGoSearchResult[];
};
