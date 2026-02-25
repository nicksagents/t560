function toStringValue(value: unknown): string {
  return String(value ?? "");
}

function toNumberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBooleanValue(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === null || value === undefined) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return fallback;
}

function normalizeLink(entry: unknown): { index: number; text: string; url: string } | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const row = entry as Record<string, unknown>;
  const url = toStringValue(row.url).trim();
  if (!url) {
    return null;
  }
  return {
    index: toNumberValue(row.index, 0),
    text: toStringValue(row.text).trim(),
    url,
  };
}

function normalizeRef(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const row = entry as Record<string, unknown>;
  const ref = toStringValue(row.ref).trim();
  if (!ref) {
    return null;
  }
  return {
    ref,
    kind: toStringValue(row.kind).trim(),
    role: toStringValue(row.role).trim(),
    name: toStringValue(row.name).trim(),
    ...(toStringValue(row.url).trim() ? { url: toStringValue(row.url).trim() } : {}),
    ...(Number.isFinite(Number(row.formIndex)) ? { formIndex: Number(row.formIndex) } : {}),
    ...(toStringValue(row.fieldName).trim() ? { fieldName: toStringValue(row.fieldName).trim() } : {}),
    ...(toStringValue(row.method).trim() ? { method: toStringValue(row.method).trim() } : {}),
    ...(toStringValue(row.selector).trim() ? { selector: toStringValue(row.selector).trim() } : {}),
  };
}

function normalizeSnapshot(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const snapshot = entry as Record<string, unknown>;
  const links = Array.isArray(snapshot.links)
    ? snapshot.links.map((row) => normalizeLink(row)).filter((row): row is NonNullable<typeof row> => Boolean(row))
    : [];
  const refs = Array.isArray(snapshot.refs)
    ? snapshot.refs.map((row) => normalizeRef(row)).filter((row): row is NonNullable<typeof row> => Boolean(row))
    : [];
  return {
    capturedAt: toNumberValue(snapshot.capturedAt, Date.now()),
    url: toStringValue(snapshot.url).trim(),
    title: toStringValue(snapshot.title).trim(),
    status: toNumberValue(snapshot.status, 0),
    ok: toBooleanValue(snapshot.ok, false),
    contentType: toStringValue(snapshot.contentType).trim(),
    truncated: toBooleanValue(snapshot.truncated, false),
    bytes: toNumberValue(snapshot.bytes, 0),
    text: toStringValue(snapshot.text),
    links,
    refs,
  };
}

function normalizeBrowserResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const record = result as Record<string, unknown>;
  const out: Record<string, unknown> = { ...record };
  if ("snapshot" in out) {
    out.snapshot = normalizeSnapshot(out.snapshot);
  }
  if ("openedSnapshot" in out) {
    out.openedSnapshot = normalizeSnapshot(out.openedSnapshot);
  }
  if (Array.isArray(out.refs)) {
    out.refs = out.refs
      .map((row) => normalizeRef(row))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
  }
  return out;
}

function normalizeWebSearchResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const row = result as Record<string, unknown>;
  const results = Array.isArray(row.results)
    ? row.results
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          const item = entry as Record<string, unknown>;
          const url = toStringValue(item.url).trim();
          if (!url) {
            return null;
          }
          return {
            title: toStringValue(item.title).trim(),
            url,
            description: toStringValue(item.description).trim(),
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : [];
  const products = Array.isArray(row.products)
    ? row.products
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          const item = entry as Record<string, unknown>;
          const url = toStringValue(item.url).trim();
          if (!url) {
            return null;
          }
          return {
            title: toStringValue(item.title).trim(),
            url,
            description: toStringValue(item.description).trim(),
            relevanceScore: toNumberValue(item.relevanceScore, 0),
            ...(item.price && typeof item.price === "object"
              ? {
                  price: {
                    amount: toNumberValue((item.price as Record<string, unknown>).amount, 0),
                    currency: toStringValue((item.price as Record<string, unknown>).currency).trim(),
                    display: toStringValue((item.price as Record<string, unknown>).display).trim(),
                  },
                }
              : {}),
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : [];

  return {
    ...row,
    provider: toStringValue(row.provider).trim(),
    query: toStringValue(row.query).trim(),
    queryUsed: toStringValue(row.queryUsed).trim(),
    count: toNumberValue(row.count, results.length),
    results,
    ...(products.length > 0 ? { products } : {}),
  };
}

function normalizeWebFetchResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const row = result as Record<string, unknown>;
  return {
    ...row,
    ok: toBooleanValue(row.ok, false),
    status: toNumberValue(row.status, 0),
    url: toStringValue(row.url).trim(),
    contentType: toStringValue(row.contentType).trim(),
    truncated: toBooleanValue(row.truncated, false),
    bytes: toNumberValue(row.bytes, 0),
    text: toStringValue(row.text),
  };
}

function normalizeEmailMessage(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const row = entry as Record<string, unknown>;
  return {
    sequence: toNumberValue(row.sequence, 0),
    uid: toNumberValue(row.uid, 0),
    subject: toStringValue(row.subject).trim(),
    from: toStringValue(row.from).trim(),
    to: toStringValue(row.to).trim(),
    date: toStringValue(row.date).trim(),
    snippet: toStringValue(row.snippet),
    messageId: toStringValue(row.messageId).trim(),
    inReplyTo: toStringValue(row.inReplyTo).trim(),
    threadKey: toStringValue(row.threadKey).trim(),
    references: Array.isArray(row.references)
      ? row.references.map((value) => toStringValue(value).trim()).filter(Boolean)
      : [],
    flags: Array.isArray(row.flags)
      ? row.flags.map((value) => toStringValue(value).trim()).filter(Boolean)
      : [],
    size: toNumberValue(row.size, 0),
  };
}

function normalizeEmailResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const row = result as Record<string, unknown>;
  const messages = Array.isArray(row.messages)
    ? row.messages
        .map((entry) => normalizeEmailMessage(entry))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : [];
  return {
    ...row,
    ok: toBooleanValue(row.ok, false),
    action: toStringValue(row.action).trim(),
    service: toStringValue(row.service).trim(),
    provider: toStringValue(row.provider).trim(),
    reason: toStringValue(row.reason).trim(),
    nextStep: toStringValue(row.nextStep).trim(),
    loginUrl: toStringValue(row.loginUrl).trim(),
    requiresBrowserLogin: toBooleanValue(row.requiresBrowserLogin, false),
    count: toNumberValue(row.count, messages.length),
    acceptedCount: toNumberValue(row.acceptedCount, 0),
    messages,
    accepted: Array.isArray(row.accepted)
      ? row.accepted.map((value) => toStringValue(value).trim()).filter(Boolean)
      : [],
    to: Array.isArray(row.to)
      ? row.to.map((value) => toStringValue(value).trim()).filter(Boolean)
      : [],
    cc: Array.isArray(row.cc)
      ? row.cc.map((value) => toStringValue(value).trim()).filter(Boolean)
      : [],
    bcc: Array.isArray(row.bcc)
      ? row.bcc.map((value) => toStringValue(value).trim()).filter(Boolean)
      : [],
  };
}

export function applyToolResultContract(toolName: string, result: unknown): unknown {
  const normalizedName = String(toolName ?? "").trim().toLowerCase();
  if (normalizedName === "browser") {
    return normalizeBrowserResult(result);
  }
  if (normalizedName === "web_search") {
    return normalizeWebSearchResult(result);
  }
  if (normalizedName === "web_fetch") {
    return normalizeWebFetchResult(result);
  }
  if (normalizedName === "email") {
    return normalizeEmailResult(result);
  }
  return result;
}
