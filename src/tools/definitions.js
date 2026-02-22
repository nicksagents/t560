function toolDef(name, description, schema) {
  return { name, description, schema };
}

export function getToolDefinitions({ enableEmailTools, enableGitHubTools, enableWebTools, enableTerminalTools }) {
  const defs = [];

  if (enableWebTools) {
    defs.push(
      toolDef("web_search", "Search the web for up-to-date information.", {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Search query" },
          count: {
            type: ["integer", "null"],
            minimum: 1,
            maximum: 10,
            description: "Number of results (1-10). Use null for default.",
          },
        },
        required: ["query", "count"],
      }),
    );

    defs.push(
      toolDef("web_fetch", "Fetch a URL and return a text snapshot.", {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", description: "HTTP/HTTPS URL" },
          maxBytes: {
            type: ["integer", "null"],
            minimum: 10_000,
            maximum: 500_000,
            description: "Max bytes to download (10k-500k). Use null for default.",
          },
        },
        required: ["url", "maxBytes"],
      }),
    );
  }

  defs.push(
    toolDef("memory_search", "Search t560 long-term memory for relevant preferences, facts, or procedures.", {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Search query" },
        limit: {
          type: ["integer", "null"],
          description: "Max results (1-10). Use null for default.",
          minimum: 1,
          maximum: 10,
        },
      },
      required: ["query", "limit"],
    }),
  );

  defs.push(
    toolDef("memory_save", "Save a durable memory item (preferences, recurring context, procedures). Do not store secrets.", {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        tags: { type: ["array", "null"], items: { type: "string" } },
      },
      required: ["title", "content", "tags"],
    }),
  );

  defs.push(
    toolDef("sessions_list", "List known t560 sessions with status metadata.", {
      type: "object",
      additionalProperties: false,
      properties: {
        kinds: {
          type: ["array", "null"],
          items: { type: "string" },
          description: "Optional kind filters: main, group, cron, hook, node, other.",
        },
        limit: {
          type: ["integer", "null"],
          description: "Max sessions to return (1-200). Use null for default.",
          minimum: 1,
          maximum: 200,
        },
        activeMinutes: {
          type: ["integer", "null"],
          description: "Only include sessions active in the last N minutes.",
          minimum: 1,
          maximum: 10080,
        },
        messageLimit: {
          type: ["integer", "null"],
          description: "Include up to N trailing messages per row (0 disables).",
          minimum: 0,
          maximum: 20,
        },
      },
      required: ["kinds", "limit", "activeMinutes", "messageLimit"],
    }),
  );

  defs.push(
    toolDef("sessions_history", "Read message history from a t560 session.", {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: {
          type: ["string", "null"],
          description: "Session id to inspect. Use null for current session.",
        },
        sessionKey: {
          type: ["string", "null"],
          description: "Alias for sessionId (OpenClaw-compatible).",
        },
        limit: {
          type: ["integer", "null"],
          description: "Max messages to return (1-500). Use null for default.",
          minimum: 1,
          maximum: 500,
        },
        includeTools: {
          type: ["boolean", "null"],
          description: "Include tool role messages when true.",
        },
      },
      required: ["sessionId", "sessionKey", "limit", "includeTools"],
    }),
  );

  defs.push(
    toolDef("session_status", "Get detailed status for one t560 session.", {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: {
          type: ["string", "null"],
          description: "Session id to inspect. Use null for current session.",
        },
      },
      required: ["sessionId"],
    }),
  );

  defs.push(
    toolDef("agents_list", "List configured t560 agents.", {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    }),
  );

  defs.push(
    toolDef("sessions_send", "Send a message into another t560 session.", {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionKey: {
          type: ["string", "null"],
          description: "Target session key/id. Use null when label is provided.",
        },
        label: {
          type: ["string", "null"],
          description: "Target session label. Use null when sessionKey is provided.",
        },
        agentId: {
          type: ["string", "null"],
          description: "Optional agent id filter for label lookup.",
        },
        message: { type: "string", description: "Message to send to the target session." },
        timeoutSeconds: {
          type: ["number", "null"],
          minimum: 0,
          maximum: 3600,
          description: "Wait timeout in seconds. Use 0 for fire-and-forget.",
        },
      },
      required: ["sessionKey", "label", "agentId", "message", "timeoutSeconds"],
    }),
  );

  defs.push(
    toolDef("sessions_spawn", "Spawn a background t560 sub-agent session for a task.", {
      type: "object",
      additionalProperties: false,
      properties: {
        task: { type: "string", description: "Task for the spawned sub-agent." },
        label: {
          type: ["string", "null"],
          description: "Optional label to assign to the spawned session.",
        },
        agentId: {
          type: ["string", "null"],
          description: "Optional target agent id for the sub-agent session id prefix.",
        },
        model: {
          type: ["string", "null"],
          description: "Optional model override for the spawned session.",
        },
        thinking: {
          type: ["string", "null"],
          description: "Optional thinking level hint (provider/model specific).",
        },
        runTimeoutSeconds: {
          type: ["number", "null"],
          minimum: 0,
          maximum: 3600,
          description: "Run timeout for the spawned task in seconds.",
        },
        timeoutSeconds: {
          type: ["number", "null"],
          minimum: 0,
          maximum: 3600,
          description: "Legacy alias for runTimeoutSeconds.",
        },
        cleanup: {
          type: ["string", "null"],
          enum: ["keep", "delete", null],
          description: "Whether to keep or delete the spawned session after completion.",
        },
      },
      required: [
        "task",
        "label",
        "agentId",
        "model",
        "thinking",
        "runTimeoutSeconds",
        "timeoutSeconds",
        "cleanup",
      ],
    }),
  );

  defs.push(
    toolDef("message", "Send a message through the active channel bridge.", {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["send", "reply", "thread-reply", "broadcast", "list_actions"],
          description: "Message action.",
        },
        channel: {
          type: ["string", "null"],
          description: "Optional channel override.",
        },
        target: {
          type: ["string", "null"],
          description: "Optional channel target/user/group.",
        },
        targets: {
          type: ["array", "null"],
          items: { type: "string" },
