export function addWildcardAllowFrom(allowFrom?: Array<string | number>): string[] {
  const normalized = (allowFrom ?? [])
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  if (normalized.includes("*")) {
    return normalized;
  }
  return ["*", ...normalized];
}
