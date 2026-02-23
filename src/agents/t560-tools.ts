import type { T560Config } from "../config/state.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import {
  createMemoryGetTool,
  createMemorySaveTool,
  createMemorySearchTool,
} from "./tools/memory-tools.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";

export function createT560Tools(options?: {
  config?: T560Config;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): AnyAgentTool[] {
  const webSearch = createWebSearchTool({
    config: options?.config,
    env: options?.env ?? process.env,
  });
  const webFetch = createWebFetchTool({
    config: options?.config,
    env: options?.env ?? process.env,
  });
  const workspaceDir = options?.workspaceDir ?? process.cwd();
  const memorySearch = createMemorySearchTool({
    workspaceDir,
    env: options?.env ?? process.env,
  });
  const memoryGet = createMemoryGetTool({
    workspaceDir,
    env: options?.env ?? process.env,
  });
  const memorySave = createMemorySaveTool({
    workspaceDir,
    env: options?.env ?? process.env,
  });
  return [
    createBrowserTool(),
    ...(webSearch ? [webSearch] : []),
    ...(webFetch ? [webFetch] : []),
    memorySearch,
    memoryGet,
    memorySave,
  ];
}
