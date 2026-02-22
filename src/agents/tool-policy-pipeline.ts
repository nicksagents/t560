import { filterToolsByPolicy } from "./pi-tools.policy.js";
import type { AnyAgentTool, ToolPolicyLike } from "./pi-tools.types.js";

export type ToolPolicyPipelineStep = {
  label: string;
  policy?: ToolPolicyLike;
};

export function buildDefaultToolPolicyPipelineSteps(params: {
  profilePolicy?: ToolPolicyLike;
  globalPolicy?: ToolPolicyLike;
  providerPolicy?: ToolPolicyLike;
  runtimePolicy?: ToolPolicyLike;
}): ToolPolicyPipelineStep[] {
  return [
    { label: "tools.profile", policy: params.profilePolicy },
    { label: "tools.allow", policy: params.globalPolicy },
    { label: "tools.byProvider.allow", policy: params.providerPolicy },
    { label: "tools.runtime", policy: params.runtimePolicy }
  ];
}

export function applyToolPolicyPipeline(params: {
  tools: AnyAgentTool[];
  steps: ToolPolicyPipelineStep[];
}): AnyAgentTool[] {
  let filtered = params.tools;

  for (const step of params.steps) {
    if (!step.policy) {
      continue;
    }
    filtered = filterToolsByPolicy(filtered, step.policy);
  }

  return filtered;
}
