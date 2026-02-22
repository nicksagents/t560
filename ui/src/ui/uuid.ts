/**
 * Generate a UUID that works in non-secure contexts (plain HTTP).
 * crypto.randomUUID() requires a secure context (HTTPS or localhost),
 * so we fall back to Math.random() when it's unavailable.
 */
export function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // Falls through to fallback
    }
  }
  // Fallback: generate v4-like UUID using Math.random
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Short ID (8 hex chars) */
export function shortId(): string {
  return uuid().slice(0, 8);
}
