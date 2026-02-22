function normalizeBaseUrl(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return "";
  return v.replace(/\/+$/, "");
}

function resolveChatCompletionsUrl(baseUrl) {
  const base = normalizeBaseUrl(baseUrl) || "https://api.openai.com/v1";
  if (base.endsWith("/chat/completions")) return base;
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export function extractChatMessage(json) {
  const choices = Array.isArray(json?.choices) ? json.choices : [];
  const msg = choices[0]?.message;
  return msg && typeof msg === "object" ? msg : null;
}

export function extractChatText(json) {
  const msg = extractChatMessage(json);
  const t = msg?.content;
  return typeof t === "string" ? t.trim() : "";
}

export function extractChatToolCalls(json) {
  const msg = extractChatMessage(json);
  const calls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
  return calls
    .filter((c) => c && c.type === "function" && c.function && typeof c.function.name === "string")
    .map((c) => ({
      id: String(c.id ?? "").trim(),
      name: String(c.function.name),
      arguments: c.function.arguments,
    }))
    .filter((c) => c.id && c.name);
}

export async function createChatCompletion(params) {
  const {
    apiKey,
    baseUrl,
    model,
    messages,
    tools,
    toolChoice,
    timeoutMs = 120_000,
    extraHeaders,
  } = params;

  if (!apiKey || !String(apiKey).trim()) throw new Error("Missing auth token.");
  if (!model || !String(model).trim()) throw new Error("Missing model.");

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${String(apiKey).trim()}`,
    ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
  };

  const body = {
    model: String(model).trim(),
    messages: Array.isArray(messages) ? messages : [],
  };
  if (Array.isArray(tools) && tools.length > 0) body.tools = tools;
  if (toolChoice !== undefined) body.tool_choice = toolChoice;

  const url = resolveChatCompletionsUrl(baseUrl);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = (json && (json.error?.message || json.message)) || text || `API error (status ${res.status})`;
      throw new Error(String(msg));
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

