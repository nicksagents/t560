import type { T560Config } from "../config/state.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";

export function createT560Tools(options?: {
  config?: T560Config;
}): AnyAgentTool[] {
  void options;
  return [createBrowserTool(), createWebSearchTool(), createWebFetchTool()];
}
