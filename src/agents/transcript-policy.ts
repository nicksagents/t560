import type { ToolCallIdMode } from "./tool-call-id.js";

export type TranscriptPolicy = {
  sanitizeToolCallIds: boolean;
  toolCallIdMode?: ToolCallIdMode;
  repairToolUseResultPairing: boolean;
  allowSyntheticToolResults: boolean;
};

const MISTRAL_HINTS = [
  "mistral",
  "mixtral",
  "codestral",
  "pixtral",
  "devstral",
  "ministral",
  "mistralai"
];

function isMistral(params: { provider?: string | null; modelId?: string | null }): boolean {
  const provider = (params.provider ?? "").trim().toLowerCase();
  if (provider === "mistral") return true;
  const modelId = (params.modelId ?? "").toLowerCase();
  return MISTRAL_HINTS.some((hint) => modelId.includes(hint));
}

function isAnthropic(provider?: string | null): boolean {
  return (provider ?? "").trim().toLowerCase() === "anthropic";
}

function isGoogle(provider?: string | null, modelId?: string | null): boolean {
  const normalized = (provider ?? "").trim().toLowerCase();
  if (normalized.startsWith("google")) return true;
  const model = (modelId ?? "").toLowerCase();
  return model.includes("gemini");
}

export function resolveTranscriptPolicy(params: {
  provider?: string | null;
  modelId?: string | null;
}): TranscriptPolicy {
  const provider = params.provider ?? "";
  const modelId = params.modelId ?? "";
  const mistral = isMistral({ provider, modelId });
  const anthropic = isAnthropic(provider);
  const google = isGoogle(provider, modelId);

  const sanitizeToolCallIds = mistral || anthropic || google;
  const toolCallIdMode: ToolCallIdMode | undefined = mistral
    ? "strict9"
    : sanitizeToolCallIds
      ? "strict"
      : undefined;

  return {
    sanitizeToolCallIds,
    toolCallIdMode,
    repairToolUseResultPairing: anthropic || google,
    allowSyntheticToolResults: anthropic || google
  };
}
