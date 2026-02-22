function safeTrim(v) {
  return String(v ?? "").trim();
}

function looksPlanning(text) {
  const t = String(text ?? "").toLowerCase();
  if (!t) return false;
  return (
    /\b(plan|roadmap|milestone|scope|timeline|priorit(y|ize)|trade[- ]?off|decision)\b/.test(t) ||
    /\bproduct|requirements|spec\b/.test(t)
  );
}

function looksCoding(text) {
  const t = String(text ?? "").toLowerCase();
  if (!t) return false;
  if (t.includes("```")) return true;
  if (/\b(error|exception|stack trace|traceback|bug|fix|refactor|implement|compile|build|test|benchmark)\b/.test(t))
    return true;
  if (/\b(npm|pnpm|yarn|pip|poetry|uv|go test|cargo|mvn|gradle)\b/.test(t)) return true;
  if (/\b(function|class|import|export|const|let|var|def |async |await )\b/.test(t)) return true;
  if (/[\\/](src|app|lib|test|tests)[\\/]/.test(t)) return true;
  if (/\.(js|ts|tsx|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|sh|yaml|yml|json|toml)\b/.test(t))
    return true;
  return false;
}

export function resolveModelRefForTurn({ cfg, session, message }) {
  const s = session ?? {};
  const override = safeTrim(s.modelRefOverride);
  if (override) return { modelRef: override, session: s };

  const models = cfg?.models ?? {};
  const defaultRef = safeTrim(models.default) || safeTrim(cfg?.openai?.defaultModel) || "openai/gpt-5.1-codex";
  const codingRef = safeTrim(models.coding);
  const planningRef = safeTrim(models.planning);

  const modeRaw = safeTrim(s.mode) || "auto";
  if (modeRaw === "default") return { modelRef: defaultRef, session: s };
  if (modeRaw === "coding") return { modelRef: codingRef || defaultRef, session: s };
  if (modeRaw === "planning") return { modelRef: planningRef || defaultRef, session: s };

  // Auto routing: only meaningful when the matrix exists.
  const hasCoding = Boolean(codingRef);
  const hasPlanning = Boolean(planningRef);
  if (!hasCoding && !hasPlanning) return { modelRef: defaultRef, session: { ...s, mode: "auto" } };

  const text = safeTrim(message);
  if (hasCoding && looksCoding(text)) return { modelRef: codingRef, session: { ...s, mode: "auto" } };
  if (hasPlanning && looksPlanning(text)) return { modelRef: planningRef, session: { ...s, mode: "auto" } };

  // Fall back to defaults.
  return { modelRef: defaultRef, session: { ...s, mode: "auto" } };
}

