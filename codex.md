# t560 CODEX.md

## 1) What This Project Is

`t560` is a multi-channel agent runtime built around one shared message pipeline.

It accepts messages from:
- terminal (`t560` default command starts full-screen TUI)
- web chat (dashboard/websocket)
- Telegram (long-polling bot)

All three channels feed the same core handler, which means:
- same model routing
- same tool stack
- same session persistence behavior
- same security constraints

The architecture is intentionally centered on a single provider loop (`src/provider/run.ts`) so behavior changes are consistent everywhere.

---

## 2) Active Runtime Call Graph (End-to-End)

This is the **main path actually used** when running `t560` today.

1. Entry
- `src/bin/t560.ts`
  - calls `runCli(process.argv)`

2. CLI command routing
- `src/cli/run.ts`
  - handles command parsing (`tui`, `onboard`, etc.)
  - onboarding gate + preflight gate

3. Runtime startup
- `src/tui/tui.ts`
  - full-screen UI + same gateway runtime behind it

4. Gateway runtime
- `src/gateway/runtime.ts`
  - starts web dashboard server
  - starts Telegram bridge
  - exposes `handleMessage()` and `subscribeEvents()`

5. Message routing
- `src/gateway/router.ts`
  - passes to `processChatMessage()`
- `src/agent/chat-service.ts`
  - foundation/provider mode
  - route slot selection (default/planning/coding)
  - secure setup interception (`/setup` flow)
  - provider execution + auto-resume policy

6. Provider execution
- `src/provider/run.ts`
  - builds system prompt + tool definitions
  - runs tool-call loop
  - emits assistant progress events
  - enforces checkout confirmation guard
  - handles MFA continuation logic
  - persists trimmed session transcript

7. Tool execution
- `src/agents/pi-tools.ts` creates tool list
- `src/agents/t560-tools.ts` adds browser/web/memory tools
- `src/agents/tools/*.ts` implement actual tools
- `src/agents/pi-tool-definition-adapter.ts` normalizes calls + executes tool + serializes result

8. Output formatting
- terminal: `src/format/message-formatter.ts`
- Telegram: `src/format/message-formatter.ts` (`formatTelegramResponse`)
- web UI: `ui/src/ui/*`

---

## 3) What Is Core

### Core (you will edit these most)
- `src/cli/run.ts`
- `src/tui/tui.ts`
- `src/gateway/runtime.ts`
- `src/web/dashboard.ts`
- `src/channels/telegram.ts`
- `src/agent/chat-service.ts`
- `src/provider/run.ts`
- `src/provider/session.ts`
- `src/agents/*` (tooling/prompt/policies)
- `src/security/*`
- `ui/src/ui/*`

---

## 4) Project Map (By Responsibility)

## Runtime + Entry
- `src/bin/t560.ts` - CLI binary entry.
- `src/cli/run.ts` - command dispatch, onboarding/preflight checks.
- `src/tui/tui.ts` - full-screen TUI runtime.

## Gateway + Transport
- `src/gateway/runtime.ts` - starts dashboard + Telegram bridge, event bus subscriptions.
- `src/gateway/router.ts` - message pass-through to chat service.
- `src/gateway/types.ts` - inbound message shape and channel IDs.
- `src/web/dashboard.ts` - HTTP API + websocket + SSE + static UI serving.

## Chat + Model Orchestration
- `src/agent/chat-service.ts` - mode switching, route selection, error recovery behavior.
- `src/provider/run.ts` - main model/tool loop and response synthesis.
- `src/provider/session.ts` - transcript persistence + transcript sanitation/repair.
- `src/provider/usage-summary.ts` - usage aggregation for status endpoints.

## Prompt + Agent Internals
- `src/agents/system-prompt.ts` - system prompt builder and behavior constraints.
- `src/agents/bootstrap-context.ts` - injects workspace bootstrap files into prompt.
- `src/agents/skills.ts` - skills discovery and prompt injection.
- `src/agents/agent-events.ts` - cross-channel event stream (`assistant`, `tool`, `status`).
- `src/agents/tool-execution-events.ts` - tool event emission wrappers.

## Tools Layer
- `src/agents/pi-tools.ts` - master tool assembly pipeline.
- `src/agents/t560-tools.ts` - t560-specific tool registration (`browser`, `web_search`, `web_fetch`, `memory_search`, `memory_get`, `memory_save`).
- `src/agents/tools/browser-tool.ts` - stateful browser automation.
- `src/agents/tools/web-tools.ts` - web search + web fetch tools.
- `src/agents/tools/memory-tools.ts` - persistent memory search/get/save engine.
- `src/agents/tools/fs-tools.ts` - file tools (`read/write/edit/ls/find/exists`) with safety gates.
- `src/agents/bash-tools.exec.ts` - shell execution tool.
- `src/agents/bash-tools.process.ts` - background process management tool.
- `src/agents/pi-tool-definition-adapter.ts` - tool arg normalization and invocation.
- `src/agents/tool-result-contract.ts` - normalizes tool output contracts.
- `src/agents/pi-tools.schema.ts` - schema normalization for provider compatibility.

## Security
- `src/security/credentials-vault.ts` - encrypted credential storage.
- `src/security/setup-flow.ts` - `/setup` chat-driven credential provisioning.
- `src/agents/self-protection.ts` - destructive command/path self-protection policy.

## Channel Adapters
- `src/channels/telegram.ts` - Telegram polling bridge + progress relay + `/new` reset.
- `src/channels/pairing.ts` - pairing-code approval workflow.

## Config + State
- `src/config/state.ts` - canonical config types/load/save/onboarding status.
- `src/config/runtime-preflight.ts` - startup validation checks.
- `src/network/tailscale.ts` - Tailscale IP detection.

## UI (Web)
- `ui/src/ui/app.ts` - root web app component.
- `ui/src/ui/app-render.ts` - shell layout (topbar/sidebar/content) and page routing.
- `ui/src/ui/app-gateway.ts` - websocket integration + live progress rendering.
- `ui/src/ui/app-setup.ts` - setup wizard data actions + API writes.
- `ui/src/ui/views/chat.ts` - chat page layout.
- `ui/src/ui/views/setup.ts` - setup wizard UI.
- `ui/src/ui/views/status.ts` - diagnostics/status UI.
- `ui/src/ui/views/settings.ts` - advanced editors UI.
- `ui/src/ui/chat/grouped-render.ts` - chat bubble rendering.
- Dashboard serves this single UI bundle from `dist/control-ui` (auto-built at runtime when missing).

## Tests
- `test/*.test.js` - browser/web tool, setup-flow, session, event-streaming, checkout workflow tests.

---

## 5) Core Behavior Deep Dive

## 5.1 Routing and Modes

`src/agent/chat-service.ts` controls top-level behavior:

- Runs secure setup flow interception first.
- If onboarding incomplete: returns foundation-mode message.
- If onboarded: picks route slot:
  - `planning` if message hints planning/strategy/architecture
  - `coding` if message hints code/refactor/test/etc
  - else `default`
- Emits `status` route event.
- Calls `chatWithProvider()` from `src/provider/run.ts`.

Why this matters:
- If your model seems “wrong” for certain prompts, adjust route selection logic here.

## 5.2 Provider Loop

`src/provider/run.ts` is the heart of the agent.

What it does:
- Loads session history.
- Resolves provider/model and credentials.
- Builds tool set (or none for small-talk).
- Builds system prompt with injected workspace files + skills + tool descriptions.
- Runs iterative loop (up to `MAX_TOOL_ROUNDS`).
- Executes model-returned tool calls.
- Pushes tool results back into conversation.
- Emits assistant progress updates while running.
- Finalizes a user-facing answer.

Important controls in this file:
- forced tool-use heuristic (`requestLikelyNeedsTools`)
- empty-response recovery prompts
- browser-failure web-search recovery
- login/MFA continuation handling
- checkout confirmation guard integration
- progress quality filtering

If you want to change “agent reliability” behavior, this is usually where.

## 5.3 Tool Policy Pipeline

`src/agents/pi-tools.ts` builds tools in this order:
- `exec`
- `process`
- filesystem tools
- t560 tools (`browser`, `web_search`, `web_fetch`, `memory_search`, `memory_get`, `memory_save`)

Then policy filtering applies:
1. profile policy
2. global allow/deny
3. provider-specific policy
4. runtime policy
5. owner-only policy

Relevant files:
- `src/agents/tool-policy.ts`
- `src/agents/pi-tools.policy.ts`
- `src/agents/tool-policy-pipeline.ts`

## 5.4 Browser Tool

`src/agents/tools/browser-tool.ts` provides a stateful tab/session browser model.

Highlights:
- supports `fetch` engine and `live` engine (Playwright-backed)
- tab/session state maintained across calls
- snapshot/ref model for deterministic click/fill/submit
- `login` action with secure credential lookup by service
- `mfa` action for one-time code submission
- compatibility aliases (`targetUrl`, `targetId`, etc.) for t560-style calls
- supports many actions: `open`, `search`, `snapshot`, `click`, `fill`, `submit`, `wait`, `launch`, `console`, `dialog`, `upload`, `pdf`, etc.

If login automation fails often, investigate:
- service inference
- element selector/ref extraction
- live engine availability/fallback

## 5.5 Web Search / Fetch

`src/agents/tools/web-tools.ts`:
- `web_search`:
  - Brave when key exists
  - automatic DuckDuckGo fallback when Brave unavailable/fails
  - optional recency/domain filters
  - optional fetchTop hydration
  - temporal query anchoring for “latest/current/today”-style prompts
- `web_fetch`:
  - URL fetch and readable text extraction

Provider-level settings (in config) live under:
- `tools.web.search.*`
- `tools.web.fetch.*`

## 5.6 Memory Engine

`src/agents/tools/memory-tools.ts` implements long-term memory in the active runtime path.

Tools:
- `memory_search`
  - searches two sources:
    - durable store: `~/.t560/memory.jsonl`
    - workspace memory docs: `MEMORY.md`, `memory.md`, `memory/*.md`
  - returns scored refs in a stable format:
    - `store:<id>`
    - `file:<relative-path>#L<line>`
- `memory_get`
  - fetches exact memory content by `ref`, `id`, or `path`
  - supports focused line/context retrieval for file-backed memory
- `memory_save`
  - writes durable non-secret memory entries to JSONL store
  - blocks likely secret material (tokens/password-like data/private keys)

Where memory is wired:
- tool registration: `src/agents/t560-tools.ts`
- policy/profile availability: `src/agents/tool-policy.ts`
- prompt recall instructions: `src/agents/system-prompt.ts`
- live progress narration for memory actions: `src/provider/run.ts`

How to edit memory behavior:
- ranking/scoring: `computeScore`, `searchStoreEntries`, `searchMemoryFiles` in `src/agents/tools/memory-tools.ts`
- ref format / retrieval semantics: `parseFileRef`, `createMemoryGetTool` in `src/agents/tools/memory-tools.ts`
- secret-blocking heuristics: `containsLikelySecret` in `src/agents/tools/memory-tools.ts`
- prompt strategy for when the model should recall/save memory: `src/agents/system-prompt.ts`

Memory tests:
- `test/memory_tools.test.js`

## 5.7 Secure Credentials + Setup Flow

`src/security/credentials-vault.ts`:
- credential blob is encrypted in workspace `.t560-secure/credentials.v1.enc`
- encryption key is outside workspace in `~/.t560/secure/vault.key`
- supports arbitrary site/service IDs via normalized service key

`src/security/setup-flow.ts`:
- conversational `/setup` flow per session
- supports:
  - `/setup <service-or-site>`
  - `/setup list`
  - `/setup clear <service>`
  - `/setup mode password|mfa`
  - `/setup cancel`

Security guardrails:
- fs tools block sensitive path access (`isSensitivePath`)
- exec tool blocks direct access to sensitive credential paths

## 5.8 Session Storage + Repair

`src/provider/session.ts`:
- persists session messages under `~/.t560/sessions/<session>.json`
- trims history to `MAX_SESSION_MESSAGES` (currently 40)
- sanitizes transcript to prevent malformed tool-call/result pairs
- drops poisoned empty provider error assistant stubs
- `/new` or `/reset` in Telegram now clears the per-chat session file

This is critical for long-lived reliability.

## 5.9 Progress Updates Across Channels

Progress event source:
- `src/provider/run.ts` emits `assistant` stream progress lines.

Transport:
- `src/agents/agent-events.ts` event bus.

Consumers:
- TUI: `src/tui/tui.ts`
- Telegram batched updates: `src/channels/telegram.ts`
- webchat “Working update” block: `ui/src/ui/app-gateway.ts`

If updates disappear or become generic, inspect:
- prompt instructions in `src/agents/system-prompt.ts`
- progress gating/filtering in `src/provider/run.ts`
- channel relay throttling in Telegram/UI files

## 5.10 Web App Layout + Runtime Flow (Current)

The web app is a single SPA shell with four pages:
- `Chat` (`/chat`)
- `Setup` (`/setup`)
- `Status` (`/status`, `/overview` alias maps here)
- `Settings` (`/settings`)

Routing and shell:
- path-to-tab mapping: `ui/src/ui/navigation.ts`
- shell/topbar/sidebar/content render: `ui/src/ui/app-render.ts`
- app state + event delegation: `ui/src/ui/app.ts`

Startup flow in browser:
1. `ui/src/ui/app.ts` (`connectedCallback`) loads local UI settings and persisted chat state.
2. It calls `connectGateway()` from `ui/src/ui/app-gateway.ts`.
3. On WebSocket `hello`, the app marks connected, stores snapshot status/session, then calls `chat.history`.
4. Incoming gateway events update chat, status, and the live progress block in-place.

Gateway/WebSocket protocol touchpoints:
- WebSocket endpoint: `/ws` in `src/web/dashboard.ts`
- RPC methods used by web app:
  - `chat.send`
  - `chat.abort`
  - `chat.history`
  - `chat.inject`
- streamed events consumed by UI:
  - `chat`
  - `chat.sending`
  - `chat.done`
  - `chat.error`
  - `agent.event`
  - `status`

Live activity behavior:
- UI only renders assistant progress lines (`event.stream === "assistant"`) as a rolling “Working update” block.
- Implementation: `summarizeAgentEvent()` + `pushLiveProgress()` in `ui/src/ui/app-gateway.ts`.
- Detailed diagnostic logs are still available in Status page event log.

## 5.11 Web Pages (What Each Page Does)

### Chat page (`ui/src/ui/views/chat.ts`)
- Displays grouped conversation bubbles using `ui/src/ui/chat/grouped-render.ts`.
- Has a small corner “new chat” button (`new-chat-session`) to reset session key + local thread.
- Supports queued messages, image paste attachments, and Stop/Submit actions.
- Input behavior (enter-to-send, shift+enter newline, autosize, draft persistence) is wired in `ui/src/ui/app.ts`.

### Setup page (`ui/src/ui/views/setup.ts`)
This is the main onboarding/config surface for most users.

Sections:
- `Provider`
  - “Quick Setup” guidance
  - drag-and-drop model routing board for `default/planning/coding`
  - provider add/edit flow: choose provider template -> click “Use Provider” -> choose model/auth -> save
  - configured provider cards with quick route assignment and delete
- `Routing`
  - direct manual provider/model fields for all three route slots
- `Telegram`
  - bot token, DM policy, allowlists
- `Vault`
  - secure site credential management (`/api/vault`)
- `Files`
  - edit `soul.md`, `users.md`, `config.json`, and bootstrap prompt files

Setup actions/data layer:
- all setup network actions and normalization live in `ui/src/ui/app-setup.ts`
- backend endpoints:
  - `GET /api/setup`
  - `PUT /api/setup/provider`
  - `DELETE /api/setup/provider`
  - `PUT /api/setup/routing`
  - `PUT /api/setup/telegram`
  - `GET|PUT|DELETE /api/vault`

### Status page (`ui/src/ui/views/status.ts`)
- Runtime cards (connection/mode/provider/model)
- Onboarding/missing state visibility
- usage estimate panel from `/api/status`
- gateway diagnostics and manual actions:
  - reconnect websocket
  - refresh chat history
  - clear event log
  - inject assistant note into session (`chat.inject`)
- live event stream viewer (in-memory UI log)

### Settings page (`ui/src/ui/views/settings.ts`)
- Advanced direct editing surface.
- Profile files editor (`soul.md`, `user.md/users.md`)
- Raw `config.json` editor (with format + save)
- Bootstrap file editor (for prompt-injected workspace files)

## 5.12 Web UI Editing Map (If You Want To Modify Layout/UX)

Core files:
- app state + event handlers: `ui/src/ui/app.ts`
- shell layout + tab rendering: `ui/src/ui/app-render.ts`
- page components:
  - `ui/src/ui/views/chat.ts`
  - `ui/src/ui/views/setup.ts`
  - `ui/src/ui/views/status.ts`
  - `ui/src/ui/views/settings.ts`
- setup actions/API: `ui/src/ui/app-setup.ts`
- gateway/ws client behavior: `ui/src/ui/app-gateway.ts`
- nav paths/tabs: `ui/src/ui/navigation.ts`

Styling files:
- global/base theme + variables: `ui/src/styles/base.css`
- shell/layout desktop: `ui/src/styles/layout.css`
- shell/layout mobile: `ui/src/styles/layout.mobile.css`
- shared components/forms/cards: `ui/src/styles/components.css`
- chat spacing/text/grouping:
  - `ui/src/styles/chat/layout.css`
  - `ui/src/styles/chat/grouped.css`
  - `ui/src/styles/chat/text.css`

Practical edit recipes:
- Change page structure/content: edit the relevant file in `ui/src/ui/views/*`.
- Add a new button/action: add markup `data-action=...` in a view, then handle it in `ui/src/ui/app.ts`.
- Add a new setup API action: implement in `ui/src/ui/app-setup.ts`, then add backend route handler in `src/web/dashboard.ts`.
- Change live progress rendering logic: `ui/src/ui/app-gateway.ts`.
- Change topbar/sidebar/nav behavior: `ui/src/ui/app-render.ts` + `ui/src/ui/navigation.ts`.

---

## 6) Config and Data Locations

## 6.1 Config file
- `~/.t560/config.json`

Key sections:
- `providers`
- `routing`
- `channels.telegram`
- `tools` (policy + web + safety)
- `usage`

## 6.2 Runtime/session data
- `~/.t560/sessions/*.json`
- `~/.t560/pairing.json`
- `~/.t560/memory.jsonl`
- `~/.t560/soul.md`
- `~/.t560/users.md` and `~/.t560/user.md`
- workspace memory docs: `<workspace>/MEMORY.md` and `<workspace>/memory/*.md`

Memory privacy + git behavior:
- default durable memory store is outside this repo at `~/.t560/memory.jsonl`.
- if you override state directory into workspace, memory artifacts should remain untracked.
- repo gitignore includes:
  - `.t560/`
  - `memory.jsonl`
  - `MEMORY.md`
  - `memory.md`
  - `memory/`

## 6.3 Secure credential storage
- workspace: `<repo>/.t560-secure/credentials.v1.enc`
- key: `~/.t560/secure/vault.key`

---

## 7) How To Add A New Tool (Exact Workflow)

This is the practical extension recipe.

## Step 1: Implement the tool
Create a file in `src/agents/tools/`, for example:
- `src/agents/tools/weather-tool.ts`

Use `AnyAgentTool` shape from `src/agents/pi-tools.types.ts`.

Example skeleton:

```ts
import { Type } from "@mariozechner/pi-ai";
import type { AnyAgentTool } from "../pi-tools.types.js";

export function createWeatherTool(): AnyAgentTool {
  return {
    name: "weather",
    description: "Get current weather by city.",
    parameters: Type.Object({
      city: Type.String({ description: "City name" }),
    }),
    execute: async (_toolCallId, params) => {
      const city = String(params.city ?? "").trim();
      if (!city) throw new Error("city is required");
      return { city, temperatureC: 21, condition: "Clear" };
    },
  };
}
```

## Step 2: Register the tool
Add it to tool assembly in one of these places:
- `src/agents/t560-tools.ts` (for product-level tools)
- or `src/agents/pi-tools.ts` (if you want direct core insertion)

For most new tools: `src/agents/t560-tools.ts`.

## Step 3: Update policy groups (optional but recommended)
If you want policy profile control (minimal/coding/full, etc.), update:
- `src/agents/tool-policy.ts`

Add tool name to a relevant group (or make a new group).

## Step 4: Add prompt tool summary
Update `coreToolSummaries` + order in:
- `src/agents/system-prompt.ts`

Without this, the model still can call the tool, but quality drops because it has less guidance.

## Step 5: Normalize output contract (recommended)
If your tool returns complex object shapes, add normalization in:
- `src/agents/tool-result-contract.ts`

This prevents inconsistent downstream parsing.

## Step 6: Add progress narration support (recommended)
If you want better live updates, add your tool-specific argument/outcome summaries in:
- `src/provider/run.ts`
  - `summarizeArgsForProgress`
  - `summarizeOutcomeForProgress`

## Step 7: Add tests
Add one or more tests in `test/`.

Good pattern:
- unit test tool behavior directly
- add regression test for common failure path

Example command:

```bash
node --import tsx --test test/your_new_tool.test.js
```

## Step 8: Build

```bash
npm run build:server
cd ui && npx vite build
```

---

## 8) If You Want To Edit X, Go Here

## Change agent tone, transparency, response style
- `src/agents/system-prompt.ts`
- `src/provider/run.ts` (runtime enforcement/recovery + progress filtering)

## Change which model handles what
- `src/agent/chat-service.ts` (`chooseRouteSlot`)
- `~/.t560/config.json` (`routing`)

## Change tool availability by profile/provider
- `src/agents/tool-policy.ts`
- `src/agents/pi-tools.policy.ts`
- `~/.t560/config.json` (`tools.allow/deny/byProvider/profile`)

## Improve login/MFA reliability
- `src/agents/tools/browser-tool.ts`
- `src/provider/run.ts` (MFA continuation + login recovery rules)
- `src/security/credentials-vault.ts`
- `src/security/setup-flow.ts`

## Change Telegram behavior
- `src/channels/telegram.ts`
  - progress relay batching/throttling
  - `/new` and `/reset` behavior
  - DM pairing flow

## Change webchat behavior/UI
- backend events: `src/web/dashboard.ts`
- websocket client: `ui/src/ui/app-gateway.ts`
- render: `ui/src/ui/views/chat.ts`, `ui/src/ui/chat/grouped-render.ts`

## Change session trimming/history behavior
- `src/provider/session.ts`

## Change checkout safety guard
- `src/agents/checkout-workflow.ts`

## Change shell/self-protection limits
- `src/agents/self-protection.ts`
- `src/agents/bash-tools.exec.ts`

---

## 9) Web Stack Notes (Brave vs DuckDuckGo)

Search behavior:
- default configured provider is Brave
- if Brave key is not available and provider not explicitly forced, tool auto-falls back to DuckDuckGo

Relevant configuration:

```json
{
  "tools": {
    "web": {
      "search": {
        "enabled": true,
        "provider": "duckduckgo",
        "timeoutMs": 15000,
        "maxResults": 8,
        "fetchTop": 0
      },
      "fetch": {
        "enabled": true,
        "timeoutMs": 20000,
        "maxBytes": 200000
      }
    }
  }
}
```

Environment:
- `BRAVE_API_KEY` enables Brave provider.
- Without key, fallback path can still return DuckDuckGo results.

---

## 10) Build / Run / Validate Commands

## Build

```bash
npm run build:server
cd ui && npx vite build
```

## Run

```bash
t560
```

## Quick smoke checks

```bash
curl http://127.0.0.1:5600/health
curl http://127.0.0.1:5600/api/status
```

## Run one test file

```bash
node --import tsx --test test/tool_event_streaming.test.js
```

---

## 11) Audit Notes (Current Strengths + Risks)

## Strengths
- Single shared core pipeline across channels.
- Strong browser + web grounding tools.
- Secure credential vault separation (workspace encrypted file + home key).
- Live progress event architecture already in place.
- Tool policy pipeline supports profile/provider scoping.

## Risks / Maintenance Hotspots
- `src/provider/run.ts` is very large and central; regressions there affect all channels.
- `src/agents/tools/browser-tool.ts` is large and complex (high leverage, high risk).
- Session trimming can still hide long-context interactions if too many turns accumulate quickly.

## Suggested refactor directions (future)
- split `provider/run.ts` into:
  - model request/retry module
  - progress narration module
  - recovery policy module
- split browser tool by action families:
  - navigation/snapshot
  - interaction
  - auth/login/mfa
  - live-runtime lifecycle
- centralize channel progress throttling strategy in one reusable utility.

---

## 12) Editing Rules for Yourself (Practical)

- Do not edit `dist/` directly; rebuild from `src/`.
- Add tests for any provider-loop or browser-login changes.
- When changing tool outputs, verify:
  - `tool-result-contract`
  - progress summaries
  - channel formatting
- When adding new auth/service behavior, validate both:
  - `/setup ...` flow
  - browser `action=login` inference path

---

## 13) Quick Ownership Matrix

- Runtime startup issues: `src/cli/run.ts`, `src/tui/tui.ts`
- Message routing issues: `src/agent/chat-service.ts`
- Tool invocation issues: `src/provider/run.ts`, `src/agents/pi-tool-definition-adapter.ts`
- Browser auth/web automation issues: `src/agents/tools/browser-tool.ts`
- Credential storage/setup issues: `src/security/credentials-vault.ts`, `src/security/setup-flow.ts`
- Telegram issues: `src/channels/telegram.ts`, `src/channels/pairing.ts`
- Web dashboard/ws issues: `src/web/dashboard.ts`, `ui/src/ui/app-gateway.ts`
- Prompt quality issues: `src/agents/system-prompt.ts`, `src/provider/run.ts`

---

This file is intended to be the working engineer handbook for `t560`.
Update it whenever architecture or extension points change.
