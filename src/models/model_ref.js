export function parseModelRef(modelRef) {
  const raw = String(modelRef ?? "").trim();
  if (!raw) return { provider: "openai", model: "" };
  const idx = raw.indexOf("/");
  if (idx > 0) {
    const provider = raw.slice(0, idx).trim().toLowerCase();
    const model = raw.slice(idx + 1).trim();
    if (
      (provider === "openai" ||
        provider === "openai-codex" ||
        provider === "anthropic" ||
        provider === "openrouter" ||
        provider === "xai" ||
        provider === "google" ||
        provider === "together" ||
        provider === "venice" ||
        provider === "moonshot" ||
        provider === "ollama" ||
        provider === "minimax" ||
        provider === "xiaomi" ||
        provider === "synthetic" ||
        provider === "cloudflare-ai-gateway") &&
      model
    ) {
      return { provider, model };
    }
  }
  return { provider: "openai", model: raw };
}

export function formatModelRef(provider, model) {
  const p = String(provider ?? "").trim();
  const m = String(model ?? "").trim();
  if (!p || !m) return m;
  if (
    p === "openai" ||
    p === "openai-codex" ||
    p === "anthropic" ||
    p === "openrouter" ||
    p === "xai" ||
    p === "google" ||
    p === "together" ||
    p === "venice" ||
    p === "moonshot" ||
    p === "ollama" ||
    p === "minimax" ||
    p === "xiaomi" ||
    p === "synthetic" ||
    p === "cloudflare-ai-gateway"
  ) {
    return `${p}/${m}`;
  }
  return m;
}
