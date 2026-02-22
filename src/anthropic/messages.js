function buildAnthropicMessages(messages) {
  const out = [];
  for (const m of messages ?? []) {
    const role = m?.role === "assistant" ? "assistant" : "user";
    const content = m?.content;
    // Allow callers to pass pre-built Anthropic block content (tool_use/tool_result/etc).
    if (Array.isArray(content) && content.every((b) => b && typeof b === "object" && typeof b.type === "string")) {
      out.push({ role, content });
      continue;
    }
    const text = String(content ?? "");
    out.push({ role, content: [{ type: "text", text }] });
  }
  return out;
}

export async function anthropicCreateMessage(params) {
  const {
    apiKey,
    model,
    system,
    messages,
    tools,
    maxTokens = 1024,
    temperature,
    timeoutMs = 120_000,
  } = params;

  const key = String(apiKey ?? "").trim();
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY.");
  const mdl = String(model ?? "").trim();
  if (!mdl) throw new Error("Missing model.");

  const body = {
    model: mdl,
    max_tokens: Number(maxTokens) || 1024,
    messages: buildAnthropicMessages(messages),
  };
  if (system && String(system).trim()) body.system = String(system);
  if (Array.isArray(tools) && tools.length > 0) body.tools = tools;
  if (temperature !== undefined) body.temperature = Number(temperature);

  const headers = {
    "Content-Type": "application/json",
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
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
      const msg = json?.error?.message || json?.message || text || `Anthropic API error (status ${res.status})`;
      throw new Error(String(msg));
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

export function anthropicExtractText(messageJson) {
  const blocks = Array.isArray(messageJson?.content) ? messageJson.content : [];
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export function anthropicExtractToolUses(messageJson) {
  const blocks = Array.isArray(messageJson?.content) ? messageJson.content : [];
  return blocks
    .filter((b) => b && b.type === "tool_use" && typeof b.name === "string")
    .map((b) => ({
      id: b.id,
      name: b.name,
      input: b.input,
    }));
}
