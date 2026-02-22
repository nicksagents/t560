import path from "node:path";
import type { T560Config } from "../config/state.js";
import { createExecTool, createProcessTool } from "./bash-tools.js";
import { resolveSelfProtectionPolicy } from "./self-protection.js";
import { resolveEffectiveToolPolicy } from "./pi-tools.policy.js";
import type { AnyAgentTool, ToolPolicyLike } from "./pi-tools.types.js";
import {
  applyOwnerOnlyToolPolicy,
  mergeAlsoAllowPolicy,
  resolveToolProfilePolicy
} from "./tool-policy.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps
} from "./tool-policy-pipeline.js";
import { createT560Tools } from "./t560-tools.js";
import { createFilesystemTools } from "./tools/fs-tools.js";

function resolveRuntimePolicy(config: T560Config | undefined): ToolPolicyLike | undefined {
  const runtime = config?.tools?.runtime;
  if (!runtime) {
    return undefined;
  }
  return {
    allow: runtime.allow,
    deny: runtime.deny
  };
}

export function createT560CodingTools(options?: {
  workspaceDir?: string;
  config?: T560Config;
  modelProvider?: string;
  senderIsOwner?: boolean;
}): AnyAgentTool[] {
  const workspaceDir = path.resolve(options?.workspaceDir ?? process.cwd());
  const senderIsOwner = options?.senderIsOwner !== false;
  const dangerouslyUnrestricted = options?.config?.tools?.dangerouslyUnrestricted === true;
  const selfProtectionPolicy = resolveSelfProtectionPolicy({
    config: options?.config,
    workspaceDir
  });

  const timeoutSec = dangerouslyUnrestricted
    ? options?.config?.tools?.exec?.timeoutSec ?? 3600
    : options?.config?.tools?.exec?.timeoutSec ?? 180;
  const allowBackground = dangerouslyUnrestricted
    ? true
    : options?.config?.tools?.exec?.allowBackground !== false;
  const workspaceOnly = options?.config?.tools?.fs?.workspaceOnly !== false;

  const baseTools: AnyAgentTool[] = [
    createExecTool({
      cwd: workspaceDir,
      timeoutSec,
      allowBackground,
      selfProtection: selfProtectionPolicy
    }),
    createProcessTool({
      scopeKey: "session:local"
    }),
    ...createFilesystemTools({
      workspaceDir,
      workspaceOnly
    }),
    ...createT560Tools({
      config: options?.config
    }),
  ];

  if (dangerouslyUnrestricted) {
    return applyOwnerOnlyToolPolicy(baseTools, senderIsOwner);
  }

  const effective = resolveEffectiveToolPolicy({
    configTools: options?.config?.tools,
    provider: options?.modelProvider
  });

  const profilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(effective.profile),
    options?.config?.tools?.alsoAllow
  );

  const filtered = applyToolPolicyPipeline({
    tools: baseTools,
    steps: buildDefaultToolPolicyPipelineSteps({
      profilePolicy,
      globalPolicy: effective.globalPolicy,
      providerPolicy: effective.providerPolicy,
      runtimePolicy: resolveRuntimePolicy(options?.config)
    })
  });

  return applyOwnerOnlyToolPolicy(filtered, senderIsOwner);
}
