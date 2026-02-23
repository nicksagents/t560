function toolDef(name, description, schema) {
  return { name, description, schema };
}

export function getToolDefinitions({ enableEmailTools, enableGitHubTools, enableWebTools, enableTerminalTools }) {
  const defs = [];

  if (enableWebTools) {
    defs.push(
      toolDef(
        "web_search",
        "Search the web for up-to-date information (Brave when configured, automatic DuckDuckGo fallback).",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", description: "Search query" },
            provider: {
              type: ["string", "null"],
              enum: ["brave", "duckduckgo", null],
              description: "Optional provider override when allowed by runtime config.",
            },
            region: {
              type: ["string", "null"],
              description: "DuckDuckGo region code (for example wt-wt or us-en).",
            },
            count: {
              type: ["integer", "null"],
              minimum: 1,
              maximum: 20,
              description: "Number of results (1-20). Use null for default.",
            },
            fetchTop: {
              type: ["integer", "null"],
              minimum: 0,
              maximum: 5,
              description: "Optionally fetch top N search results for grounded excerpts.",
            },
            fetchMaxBytes: {
              type: ["integer", "null"],
              minimum: 10_000,
              maximum: 400_000,
              description: "Per-page byte limit when fetchTop > 0.",
            },
            timeoutMs: {
              type: ["integer", "null"],
              minimum: 1000,
              maximum: 120000,
              description: "Network timeout in milliseconds. Use null for default.",
            },
          },
          required: ["query"],
        },
      ),
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
          timeoutMs: {
            type: ["integer", "null"],
            minimum: 1000,
            maximum: 120000,
            description: "Network timeout in milliseconds. Use null for default.",
          },
        },
        required: ["url"],
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
        includeStore: { type: ["boolean", "null"], description: "Search durable store entries when true." },
        includeFiles: { type: ["boolean", "null"], description: "Search memory files when true." },
        includeSurrounding: { type: ["boolean", "null"], description: "Include surrounding workspace context files." },
        namespace: { type: ["string", "null"], description: "Memory namespace scope." },
        minTrustTier: { type: ["string", "null"], description: "Minimum trust tier scope." },
      },
      required: ["query", "limit", "includeStore", "includeFiles", "includeSurrounding", "namespace", "minTrustTier"],
    }),
  );

  defs.push(
    toolDef("memory_get", "Retrieve an exact memory entry or source snippet by ref/id/path.", {
      type: "object",
      additionalProperties: false,
      properties: {
        ref: { type: ["string", "null"], description: "Reference from memory_search (store:<id> or file:<path>#L<n>)." },
        id: { type: ["string", "null"], description: "Store entry id or store:<id>." },
        path: { type: ["string", "null"], description: "Memory file path relative to workspace." },
        namespace: { type: ["string", "null"], description: "Memory namespace scope for store reads." },
        minTrustTier: { type: ["string", "null"], description: "Minimum trust tier for store reads." },
        reinforce: { type: ["boolean", "null"], description: "Reinforce the entry when recalled (default true)." },
        line: { type: ["integer", "null"], minimum: 1, description: "Target line for file refs." },
        contextLines: { type: ["integer", "null"], minimum: 0, maximum: 20 },
        maxChars: { type: ["integer", "null"], minimum: 200, maximum: 60_000 },
      },
      required: ["ref", "id", "path", "namespace", "minTrustTier", "reinforce", "line", "contextLines", "maxChars"],
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
        importance: { type: ["number", "null"], minimum: 1, maximum: 5, description: "Importance score (1-5)." },
        confidence: { type: ["number", "null"], minimum: 0.05, maximum: 1, description: "Confidence score (0.05-1)." },
        source: { type: ["string", "null"], description: "Memory source label (for example user, inferred, system)." },
        namespace: { type: ["string", "null"], description: "Memory namespace scope." },
        trustTier: { type: ["string", "null"], description: "Trust tier (unverified, observed, verified, system)." },
        onConflict: { type: ["string", "null"], description: "Conflict strategy: upsert or replace." },
      },
      required: ["title", "content", "tags", "importance", "confidence", "source", "namespace", "trustTier", "onConflict"],
    }),
  );

  defs.push(
    toolDef("memory_delete", "Delete a durable memory item by id/ref/title when it becomes outdated or incorrect.", {
      type: "object",
      additionalProperties: false,
      properties: {
        ref: { type: ["string", "null"], description: "Store ref (store:<id>) from memory_search." },
        id: { type: ["string", "null"], description: "Store entry id or store:<id>." },
        title: { type: ["string", "null"], description: "Exact memory title (case-insensitive)." },
        reason: { type: ["string", "null"], description: "Optional short reason for deletion." },
        namespace: { type: ["string", "null"], description: "Memory namespace scope for deletion." },
        minTrustTier: { type: ["string", "null"], description: "Minimum trust tier scope for deletion." },
      },
      required: ["ref", "id", "title", "reason", "namespace", "minTrustTier"],
    }),
  );

  defs.push(
    toolDef("memory_list", "List durable memory entries for audit/debug with optional filters.", {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: ["string", "null"], description: "Optional query filter." },
        tags: { type: ["array", "null"], items: { type: "string" }, description: "Optional required tags." },
        limit: { type: ["integer", "null"], minimum: 1, maximum: 500, description: "Max entries to return." },
        importanceAtLeast: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 5,
          description: "Only include entries at or above this importance level.",
        },
        source: { type: ["string", "null"], description: "Optional exact memory-source filter." },
        namespace: { type: ["string", "null"], description: "Memory namespace scope." },
        minTrustTier: { type: ["string", "null"], description: "Minimum trust tier scope." },
        order: {
          type: ["string", "null"],
          description: "Sort order: updated_desc, updated_asc, created_desc, created_asc.",
        },
        includeContent: { type: ["boolean", "null"], description: "Include full content in each result when true." },
        maxContentChars: {
          type: ["integer", "null"],
          minimum: 200,
          maximum: 60_000,
          description: "Max chars per content payload when includeContent=true.",
        },
      },
      required: ["query", "tags", "limit", "importanceAtLeast", "source", "namespace", "minTrustTier", "order", "includeContent", "maxContentChars"],
    }),
  );

  defs.push(
    toolDef("memory_prune", "Prune stale durable memory by count/age retention policy (dry-run by default).", {
      type: "object",
      additionalProperties: false,
      properties: {
        maxEntries: { type: ["integer", "null"], minimum: 1, maximum: 10_000, description: "Keep newest N entries." },
        olderThanDays: {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 3_650,
          description: "Prune entries older than N days.",
        },
        dryRun: { type: ["boolean", "null"], description: "When true, preview without applying deletes." },
        reason: { type: ["string", "null"], description: "Optional short reason for generated delete markers." },
        namespace: { type: ["string", "null"], description: "Memory namespace scope for pruning." },
        minTrustTier: { type: ["string", "null"], description: "Minimum trust tier scope for pruning." },
      },
      required: ["maxEntries", "olderThanDays", "dryRun", "reason", "namespace", "minTrustTier"],
    }),
  );

  defs.push(
    toolDef("memory_feedback", "Apply usefulness feedback to reinforce or down-rank memory retrieval.", {
      type: "object",
      additionalProperties: false,
      properties: {
        ref: { type: ["string", "null"], description: "Store ref (store:<id>) from memory_search." },
        id: { type: ["string", "null"], description: "Store entry id or store:<id>." },
        signal: { type: ["string", "null"], description: "Feedback signal: useful or not_useful." },
        weight: { type: ["integer", "null"], minimum: 1, maximum: 3, description: "Feedback weight." },
        note: { type: ["string", "null"], description: "Optional short feedback note." },
        namespace: { type: ["string", "null"], description: "Memory namespace scope for feedback." },
        minTrustTier: { type: ["string", "null"], description: "Minimum trust tier scope for feedback." },
      },
      required: ["ref", "id", "signal", "weight", "note", "namespace", "minTrustTier"],
    }),
  );

  defs.push(
    toolDef("memory_compact", "Compact memory storage by removing superseded/deleted history rows (dry-run by default).", {
      type: "object",
      additionalProperties: false,
      properties: {
        dryRun: { type: ["boolean", "null"], description: "When true, preview compaction without rewriting the file." },
        namespace: { type: ["string", "null"], description: "Optional namespace context for compaction report." },
        minTrustTier: { type: ["string", "null"], description: "Optional trust context for compaction report." },
      },
      required: ["dryRun", "namespace", "minTrustTier"],
    }),
  );

  defs.push(
    toolDef("memory_stats", "Report memory analytics across namespaces/trust tiers and stale candidates.", {
      type: "object",
      additionalProperties: false,
      properties: {
        namespace: { type: ["string", "null"], description: "Optional namespace filter." },
        minTrustTier: { type: ["string", "null"], description: "Minimum trust tier filter." },
        includeStaleCandidates: { type: ["boolean", "null"], description: "Include low-signal stale candidates." },
        staleLimit: { type: ["integer", "null"], minimum: 1, maximum: 50 },
        limitNamespaces: { type: ["integer", "null"], minimum: 1, maximum: 200 },
      },
      required: ["namespace", "minTrustTier", "includeStaleCandidates", "staleLimit", "limitNamespaces"],
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
