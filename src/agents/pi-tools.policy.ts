import type { AnyAgentTool, ToolPolicyLike } from "./pi-tools.types.js";
import { isToolAllowedByPolicy } from "./tool-policy.js";

export function filterToolsByPolicy(
  tools: AnyAgentTool[],
  policy?: ToolPolicyLike
): AnyAgentTool[] {
  if (!policy) {
    return tools;
  }

  return tools.filter((tool) => isToolAllowedByPolicy(tool.name, policy));
}

function resolveByProviderPolicy(
  byProvider: Record<string, ToolPolicyLike> | undefined,
  provider: string | undefined
): ToolPolicyLike | undefined {
  const normalizedProvider = provider?.trim().toLowerCase();
  if (!normalizedProvider || !byProvider) {
    return undefined;
  }

  for (const [key, value] of Object.entries(byProvider)) {
    if (key.trim().toLowerCase() === normalizedProvider) {
      return value;
    }
  }

  return undefined;
}

export function resolveEffectiveToolPolicy(params: {
  configTools?: {
    profile?: string;
    allow?: string[];
    deny?: string[];
    byProvider?: Record<string, ToolPolicyLike>;
  };
  provider?: string;
}): {
  profile?: string;
  globalPolicy?: ToolPolicyLike;
  providerPolicy?: ToolPolicyLike;
} {
  const globalPolicy: ToolPolicyLike | undefined =
    params.configTools?.allow || params.configTools?.deny
      ? {
          allow: params.configTools.allow,
          deny: params.configTools.deny
        }
      : undefined;

  return {
    profile: params.configTools?.profile,
    globalPolicy,
    providerPolicy: resolveByProviderPolicy(params.configTools?.byProvider, params.provider)
  };
}
