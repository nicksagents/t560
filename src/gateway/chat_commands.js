import { loadMergedSkills } from "../skills/runtime.js";

function safeTrim(v) {
  return String(v ?? "").trim();
}

function providerConfigKey(provider) {
  const p = safeTrim(provider).toLowerCase();
  return p === "cloudflare-ai-gateway" ? "cloudflareAiGateway" : p;
}

export function handleChatCommand({ cfg, session, message }) {
  const text = safeTrim(message);
  if (!text.startsWith("/")) return null;

  const [cmd, ...rest] = text.split(/\s+/g);
  const arg = rest.join(" ").trim();

  if (cmd === "/new" || cmd === "/clear") {
    return {
      session: { ...session, messages: [] },
      reply: "t560: new session started.",
    };
  }

  if (cmd === "/role") {
    const next = arg.toLowerCase();
    if (!["auto", "default", "coding", "planning"].includes(next)) {
      return { session, reply: "t560: usage: /role auto|default|coding|planning" };
    }
    return { session: { ...session, mode: next }, reply: `t560: role set to ${next}.` };
  }

  if (cmd === "/use") {
    if (!arg) return { session, reply: "t560: usage: /use <provider/model>" };
    // Allow "/use <provider>" when onboarding saved a provider default model.
    if (!arg.includes("/")) {
      const key = providerConfigKey(arg);
      const providerDefault = safeTrim(cfg?.providers?.[key]?.defaultModel);
      if (providerDefault) {
        return { session: { ...session, modelRefOverride: providerDefault }, reply: `t560: using model ${providerDefault}.` };
      }
      return {
        session,
        reply: `t560: no default model saved for provider '${arg}'. Use /use provider/model or set it in setup.`,
      };
    }
    return { session: { ...session, modelRefOverride: arg }, reply: `t560: using model ${arg}.` };
  }

  if (cmd === "/unuse") {
    return { session: { ...session, modelRefOverride: "" }, reply: "t560: cleared model override." };
  }

  if (cmd === "/model" || cmd === "/models") {
    const models = cfg?.models ?? {};
    const providerDefaults = cfg?.providers ?? {};
    const providerLines = Object.entries(providerDefaults)
      .map(([provider, value]) => {
        const m = safeTrim(value?.defaultModel);
        if (!m) return "";
        const label = provider === "cloudflareAiGateway" ? "cloudflare-ai-gateway" : provider;
        return `- ${label}: ${m}`;
      })
      .filter(Boolean);
    const cur = safeTrim(session?.modelRefOverride) || safeTrim(models.default) || safeTrim(cfg?.openai?.defaultModel);
    const lines = [
      `Current: ${cur || "(unset)"}`,
      `Role: ${safeTrim(session?.mode) || "auto"}`,
      `Override: ${safeTrim(session?.modelRefOverride) || "(none)"}`,
      "",
      "Config routes:",
      `- default:  ${safeTrim(models.default) || safeTrim(cfg?.openai?.defaultModel) || "(unset)"}`,
      `- coding:   ${safeTrim(models.coding) || "(unset)"}`,
      `- planning: ${safeTrim(models.planning) || "(unset)"}`,
      ...(providerLines.length > 0 ? ["", "Provider defaults:", ...providerLines] : []),
      "",
      "Commands:",
      "- /role auto|default|coding|planning",
      "- /use provider/model",
      "- /use provider (uses saved provider default)",
      "- /unuse",
      "- /skills",
      "- /new",
    ];
    return { session, reply: lines.join("\n") };
  }

  if (cmd === "/skills") {
    const skills = loadMergedSkills({ workspaceDir: cfg?.workspaceDir });
    if (!Array.isArray(skills) || skills.length === 0) {
      return { session, reply: "t560: no skills loaded." };
    }
    const lines = ["Skills:"];
    for (const s of skills.slice(0, 80)) {
      lines.push(`- ${s.name}${safeTrim(s.description) ? `: ${safeTrim(s.description)}` : ""}`);
    }
    if (skills.length > 80) lines.push(`...and ${skills.length - 80} more`);
    lines.push("", "Use by name in chat, e.g. `$filesystem` or `use filesystem skill`.");
    return { session, reply: lines.join("\n") };
  }

  return { session, reply: `t560: unknown command: ${cmd}` };
}
