import type { AnyAgentTool, ToolPolicyLike } from "./pi-tools.types.js";

export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: "exec",
  "apply-patch": "apply_patch"
};

export const TOOL_GROUPS: Record<string, string[]> = {
  "group:fs": ["read", "write", "edit", "ls", "find", "exists"],
  "group:runtime": ["exec", "process"],
  "group:email": ["email"],
  "group:messaging": ["message", "sessions_send", "email"],
  "group:web": ["web_search", "web_fetch"],
  "group:memory": ["memory_search", "memory_get", "memory_save", "memory_delete", "memory_list", "memory_prune", "memory_feedback", "memory_stats", "memory_compact"],
  "group:ui": ["browser"],
  "group:t560": [
    "exec",
    "process",
    "browser",
    "email",
    "web_search",
    "web_fetch",
    "memory_search",
    "memory_get",
    "memory_save",
    "memory_delete",
    "memory_list",
    "memory_prune",
    "memory_feedback",
    "memory_stats",
    "memory_compact",
  ]
};

const TOOL_PROFILES: Record<ToolProfileId, ToolPolicyLike> = {
  minimal: {
    allow: ["process"]
  },
  coding: {
    allow: ["group:runtime", "group:fs", "group:web", "group:memory", "group:ui", "group:email"]
  },
  messaging: {
    allow: ["group:messaging", "process"]
  },
  full: {}
};

export function normalizeToolName(name: string): string {
  const normalized = name.trim().toLowerCase();
  return TOOL_NAME_ALIASES[normalized] ?? normalized;
}

export function normalizeToolList(list?: string[]): string[] {
  if (!list) {
    return [];
  }
  return list.map(normalizeToolName).filter(Boolean);
}

export function expandToolGroups(list?: string[]): string[] {
  const normalized = normalizeToolList(list);
  const expanded: string[] = [];

  for (const item of normalized) {
    const group = TOOL_GROUPS[item];
    if (group) {
      expanded.push(...group);
      continue;
    }
    expanded.push(item);
  }

  return Array.from(new Set(expanded));
}

export function resolveToolProfilePolicy(profile?: string): ToolPolicyLike | undefined {
  if (!profile) {
    return undefined;
  }

  const normalized = profile.trim().toLowerCase() as ToolProfileId;
  const entry = TOOL_PROFILES[normalized];
  if (!entry) {
    return undefined;
  }

  return {
    allow: entry.allow ? [...entry.allow] : undefined,
    deny: entry.deny ? [...entry.deny] : undefined
  };
}

export function mergeAlsoAllowPolicy(
  policy: ToolPolicyLike | undefined,
  alsoAllow: string[] | undefined
): ToolPolicyLike | undefined {
  if (!policy && !alsoAllow?.length) {
    return policy;
  }

  const allow = [...(policy?.allow ?? []), ...(alsoAllow ?? [])];
  return {
    allow: allow.length > 0 ? allow : undefined,
    deny: policy?.deny ? [...policy.deny] : undefined
  };
}

function matchToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === "*") {
    return true;
  }

  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }

  return toolName === pattern;
}

export function isToolAllowedByPolicy(toolName: string, policy?: ToolPolicyLike): boolean {
  if (!policy) {
    return true;
  }

  const normalized = normalizeToolName(toolName);
  const deny = expandToolGroups(policy.deny);
  if (deny.some((entry) => matchToolPattern(normalized, entry))) {
    return false;
  }

  const allow = expandToolGroups(policy.allow);
  if (allow.length === 0) {
    return true;
  }

  return allow.some((entry) => matchToolPattern(normalized, entry));
}

export function applyOwnerOnlyToolPolicy(tools: AnyAgentTool[], senderIsOwner: boolean): AnyAgentTool[] {
  if (senderIsOwner) {
    return tools;
  }
  return tools.filter((tool) => !tool.ownerOnly);
}
