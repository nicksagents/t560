# t560 Architecture

## Core goals

- Terminal-native AI assistant
- Modular providers and tools
- Safe defaults for local machine control
- Easy clone-and-run setup

## Platform support

- Linux is the primary target environment.
- macOS is supported.
- Windows is supported through WSL2 (native PowerShell/CMD is not a first-class target).

## Modules

1. `t560.config`
- Loads `.env` and environment variables
- Loads secrets from `~/.config/t560/.secrets`
- Produces runtime settings and safety flags
- Default config file path is `~/.config/t560/.env` (override with `T560_CONFIG_DIR`)

2. `t560.bootstrap`
- Startup env schema validator/prompter for required credentials
- Separates secret storage from normal env settings (`.secrets` file with strict permissions)
- Captures identity values (`T560_AGENT_NAME`, `T560_HUMAN_NAME`) for personalized assistant context
- Auto-prompts newly added required env vars in future versions
- GitHub readiness checks (git identity, auth mode, key/token presence)
- Maintains launcher command alias (`~/.local/bin/<agent_name>`) and enforces canonical command usage
- Persists long-term memory as markdown files under `<workspace>/.t560/memory/` (indexed locally for fast recall)

3. `t560.providers`
- One provider contract (`respond`)
- Pluggable implementations (`compatible`, `openai`, `mock`, later local models)
- Provider conversation context is bounded to a configurable recent-user-turn window (`T560_MAX_CONTEXT_USER_MESSAGES`)

4. `t560.orchestrator`
- Layered request handling:
  - Analyze request complexity/sensitivity
  - Choose `direct` or `plan` mode
  - Build LLM-ready structured prompt for plan mode
  - Route to reasoning model when needed (`think` mode or plan mode)

5. `t560.tools`
- Plugin registry with module-level tool loaders (`src/t560/tools/plugins/`)
- Built-in capabilities (system, filesystem, code_dev, computer, web, shell, github)
- External plugin support via `T560_TOOL_PLUGINS` import paths
- Auto-discovery of plugin modules in `src/t560/tools/plugins/`
- Configurable file access scope (`workspace` or `computer_safe`)

6. `t560.agent`
- REPL runtime and command dispatch
- Provider responses and tool execution loop

7. `t560.conversation`
- Stores one persistent conversation state under `<workspace>/.t560/conversation.json`
- Persists active recent messages, rolling summary, and archived snippets for relevance retrieval
- Removes chat-id switching; all turns continue the same long-running conversation state

## Memory

t560 has two distinct notions of "memory":

- Recent chat history: the provider maintains a rolling window of the last N user turns (plus tool messages).
- Durable memory: file-backed memory entries under `<workspace>/.t560/memory/` that are recalled via tools (`memory_search` -> `memory_get`) and written via `memory_save`.

### Pre-Compaction Memory Flush (OpenClaw-Style)

Before the chat history is compressed into the rolling conversation summary, t560 can run a silent memory flush turn. The flush uses tools (`memory_search`, `memory_save`) to store durable facts/preferences/procedures/solutions that should survive compaction.

Env controls:

- `T560_MEMORY_FLUSH_ENABLED` (default `true`)
- `T560_MEMORY_FLUSH_MAX_ITEMS` (default `6`)
- `T560_MEMORY_FLUSH_MAX_TRANSCRIPT_CHARS` (default `12000`)
- `T560_MEMORY_FLUSH_MODEL` (default: use primary model)
- `T560_MEMORY_FLUSH_VERBOSE=1` prints a muted note when the flush saves items

### Hybrid Retrieval (FTS + Embeddings, Optional)

By default, `memory_search` uses SQLite FTS5 over memory chunks (fast + local). Optionally, you can enable semantic retrieval using an OpenAI-compatible embeddings endpoint and merge results (hybrid recall).

Env controls:

- `T560_MEMORY_EMBED_MODEL` (empty disables embeddings)
- `T560_MEMORY_EMBED_PROVIDER` (`compatible` or `openai`; empty means "use main provider")
- `T560_MEMORY_EMBED_BATCH_SIZE` (default `64`)

## Safety baseline

- `T560_ENABLE_SHELL_TOOL=false` by default
- File writes block system-critical/protected paths
- `computer_safe` mode allows broad reads while blocking destructive mutations outside workspace
- Shell command timeout configurable
- Shell tool blocks dangerous/system-level commands by policy
- First-run startup validates required env keys and prompts user for missing values
- Conversation/memory state is local-only by default under `<workspace>/.t560/`
