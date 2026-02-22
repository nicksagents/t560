import type { T560Config } from "../config/state.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";

export function createT560Tools(options?: {
  config?: T560Config;
}): AnyAgentTool[] {
  const webSearch = createWebSearchTool({
    config: options?.config,
    env: process.env,
  });
  const webFetch = createWebFetchTool({
    config: options?.config,
    env: process.env,
  });
  return [createBrowserTool(), ...(webSearch ? [webSearch] : []), ...(webFetch ? [webFetch] : [])];
}
