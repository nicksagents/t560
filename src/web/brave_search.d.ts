export type BraveSearchResult = {
  title: string;
  url: string;
  description: string;
};

export function braveWebSearch(input: {
  apiKey: string;
  query: string;
  count?: number;
  timeoutMs?: number;
}): Promise<BraveSearchResult[]>;
