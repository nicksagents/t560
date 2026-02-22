export function buildInputFromMessages(messages) {
  return messages.map((m) => ({
    role: String(m?.role ?? "user").trim(),
    content: String(m?.content ?? ""),
  }));
}

export function isUnstoredInputItemReferenceError(err) {
  const msg = String(err?.message ?? err ?? "");
  return /item with id/i.test(msg) && /not found/i.test(msg) && /store/i.test(msg) && /false/i.test(msg);
}

export function sanitizeInputForUnstoredReplay(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object") {
      out.push(item);
      continue;
    }
    const type = String(item.type ?? "").trim();
    const next = { ...item };

    // Drop bare reference-only items that can break when store=false.
    if (!type && typeof next.id === "string" && next.id.trim()) {
      continue;
    }

    // OpenAI Responses accepts item IDs as optional metadata; removing them avoids stale-ID lookups.
    if (typeof next.id === "string" && /^(rs_|msg_|fc_)/i.test(next.id)) {
      delete next.id;
    }

    // Reasoning items can degrade to stale references; keep only if they still carry useful content.
    if (type === "reasoning") {
      const hasSummary = Array.isArray(next.summary) && next.summary.length > 0;
      const hasText = typeof next.text === "string" && next.text.trim().length > 0;
      const hasEncrypted = typeof next.encrypted_content === "string" && next.encrypted_content.trim().length > 0;
      if (!hasSummary && !hasText && !hasEncrypted) {
        continue;
      }
    }

    out.push(next);
  }
  return out;
}

export function extractOutputText(responseJson) {
  const direct = String(responseJson?.output_text ?? "").trim();
  if (direct) return direct;
  // Responses API returns a list of output items; pull assistant message text.
  const output = Array.isArray(responseJson?.output) ? responseJson.output : [];
  const parts = [];
  for (const item of output) {
    if (!item || item.type !== "message") continue;
    if (item.role !== "assistant") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c.text === "string") {
        parts.push(c.text);
        continue;
      }
      if (c?.type === "text" && typeof c.text === "string") {
        parts.push(c.text);
        continue;
      }
      if (c?.type === "refusal" && typeof c.refusal === "string") {
        parts.push(c.refusal);
      }
    }
  }
  return parts.join("\n").trim();
}

export function extractFunctionCalls(responseJson) {
  const output = Array.isArray(responseJson?.output) ? responseJson.output : [];
  return output
    .filter((item) => item && item.type === "function_call" && typeof item.name === "string")
    .map((item) => ({
      callId: item.call_id,
      name: item.name,
      arguments: item.arguments,
    }));
}

function normalizeBaseUrl(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return "";
  return v.replace(/\/+$/, "");
}

function resolveCodexResponsesUrl(baseUrl) {
  const base = normalizeBaseUrl(baseUrl) || "https://chatgpt.com/backend-api";
  if (base.endsWith("/codex/responses")) return base;
  if (base.endsWith("/codex")) return `${base}/responses`;
  return `${base}/codex/responses`;
}

async function sseToFinalResponseJson(res) {
  if (!res.body) throw new Error("No response body.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const pushChunk = async () => {
    const { done, value } = await reader.read();
    if (done) return false;
    buf += decoder.decode(value, { stream: true });
    return true;
  };

  const parseEvent = (chunk) => {
    const dataLines = chunk
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice("data:".length).trim());
    if (dataLines.length === 0) return null;
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]") return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  };

  let last = null;
  while (true) {
    let idx = buf.indexOf("\n\n");
    while (idx !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const event = parseEvent(chunk);
      if (event) {
        last = event;
        const t = String(event.type ?? "");
        if ((t === "response.completed" || t === "response.done") && event.response) {
          return event.response;
        }
      }
      idx = buf.indexOf("\n\n");
    }

    const hasMore = await pushChunk();
    if (!hasMore) break;
  }

  // Sometimes implementations omit a terminal "response.completed" but still emit a response payload.
  if (last && last.response && typeof last.response === "object") return last.response;
  throw new Error("Stream ended without a completed response.");
}

export async function createResponse(params) {
  const {
    apiKey,
    organization,
    project,
    model,
    messages,
    input,
    tools,
    toolChoice,
    parallelToolCalls,
    instructions,
    reasoning, // optional string; passed through when present
    transport = "openai", // "openai" | "openai-codex"
    codexAccountId,
    codexBaseUrl,
    timeoutMs = 120_000,
  } = params;

  if (!apiKey || !String(apiKey).trim()) {
    throw new Error("Missing auth token.");
  }
  if (!model || !String(model).trim()) {
    throw new Error("Missing model.");
  }

  const isCodex = String(transport) === "openai-codex";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${String(apiKey).trim()}` };
  let url = "https://api.openai.com/v1/responses";
  if (isCodex) {
    if (!codexAccountId || !String(codexAccountId).trim()) {
      throw new Error("Missing Codex account id.");
    }
    headers.accept = "text/event-stream";
    headers["OpenAI-Beta"] = "responses=experimental";
    headers.originator = "pi";
    headers["chatgpt-account-id"] = String(codexAccountId).trim();
    headers["User-Agent"] = "t560";
    url = resolveCodexResponsesUrl(codexBaseUrl);
  } else {
    if (organization && String(organization).trim()) headers["OpenAI-Organization"] = String(organization).trim();
    if (project && String(project).trim()) headers["OpenAI-Project"] = String(project).trim();
  }

  const body = {
    model: String(model).trim(),
    input: input ?? buildInputFromMessages(messages ?? []),
  };
  if (instructions && String(instructions).trim()) {
    body.instructions = String(instructions);
  }
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
  }
  if (toolChoice !== undefined) {
    body.tool_choice = toolChoice;
  }
  if (parallelToolCalls !== undefined) {
    body.parallel_tool_calls = Boolean(parallelToolCalls);
  }
  if (reasoning && String(reasoning).trim()) {
    body.reasoning = { effort: String(reasoning).trim() };
  }
  if (isCodex) {
    body.store = false;
    body.stream = true;
    body.tool_choice = body.tool_choice ?? "auto";
    body.parallel_tool_calls = body.parallel_tool_calls ?? true;
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let json = null;
    let text = "";
    if (isCodex) {
      if (!res.ok) {
        text = await res.text().catch(() => "");
        throw new Error(text || `Codex API error (status ${res.status})`);
      }
      json = await sseToFinalResponseJson(res);
    } else {
      text = await res.text();
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const msg =
        (json && (json.error?.message || json.message)) ||
        text ||
        `OpenAI API error (status ${res.status})`;
      throw new Error(String(msg));
    }
    const outputText = extractOutputText(json);
    return { json, outputText };
  } finally {
    clearTimeout(t);
  }
}

export async function listModels(params) {
  const { apiKey, organization, project, timeoutMs = 30_000 } = params;
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error("Missing OPENAI_API_KEY.");
  }
  const headers = { Authorization: `Bearer ${String(apiKey).trim()}` };
  if (organization && String(organization).trim()) {
    headers["OpenAI-Organization"] = String(organization).trim();
  }
  if (project && String(project).trim()) {
    headers["OpenAI-Project"] = String(project).trim();
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers,
      signal: ctrl.signal,
    });
    const text = await res.text();
    const json = JSON.parse(text);
    if (!res.ok) {
      throw new Error(String(json?.error?.message || text || `OpenAI API error (status ${res.status})`));
    }
    const data = Array.isArray(json?.data) ? json.data : [];
    return data.map((m) => String(m?.id ?? "")).filter((id) => id.trim().length > 0);
  } finally {
    clearTimeout(t);
  }
}
