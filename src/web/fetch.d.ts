export function decodeHtmlEntities(value: unknown): string;
export function htmlToReadableText(html: unknown): string;
export function chooseReadableText(contentType: unknown, decodedText: string): string;

export type WebFetchResult = {
  ok: boolean;
  status: number;
  url: string;
  contentType: string;
  truncated: boolean;
  bytes: number;
  text: string;
};

export function webFetch(params: {
  url: string;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<WebFetchResult>;
