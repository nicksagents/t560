# t560 CODEX.md

This file is the maintainer handbook for this repository.

It is written for engineers who need to:
- understand how the agent works end-to-end
- know exactly which files to edit for a given change
- safely add new tools/providers/skills without breaking runtime behavior

## 0) Ground Truth and Scope

Active runtime for `t560` command:
- `src/bin/t560.ts`
- `src/cli/run.ts`
- `src/tui/tui.ts`
- `src/gateway/runtime.ts`
- `src/gateway/router.ts`
- `src/agent/chat-service.ts`
- `src/provider/run.ts`
- `src/web/dashboard.ts`
- `ui/src/*`

The active runtime is TypeScript-first under `src/` with JS helper modules only where needed for runtime interop.

Embedded upstream reference repos were removed from this workspace (`references/` no longer exists).

If you are fixing behavior seen in normal `t560` usage, start with the active runtime files first.

## 1) Runtime Architecture (Active Path)

### 1.1 Startup sequence

1. CLI entry:
- `src/bin/t560.ts` -> `runCli(process.argv)`

2. Command/router:
- `src/cli/run.ts`
- default command is `tui`
- runs onboarding gate and preflight gate before launching runtime

3. TUI runtime + gateway startup:
- `src/tui/tui.ts`
- starts shared runtime via `startGatewayRuntime()` from `src/gateway/runtime.ts`

4. Gateway components:
- Dashboard HTTP/WS server: `src/web/dashboard.ts`
- Telegram bridge: `src/channels/telegram.ts`

5. Chat execution path:
- transport -> `src/gateway/router.ts` -> `processChatMessage()` in `src/agent/chat-service.ts` -> `chatWithProvider()` in `src/provider/run.ts`

### 1.2 Mode and route selection

`src/agent/chat-service.ts`:
- handles secure setup interception first (`src/security/setup-flow.ts`)
- if onboarding incomplete, returns foundation-mode response
- if onboarding complete, selects route slot:
  - `planning`
  - `coding`
  - `default`
- resolves target provider/model and calls provider loop

### 1.3 Provider loop core

`src/provider/run.ts` is the core behavior engine:
- resolves runtime provider (including aliases like `deepseek -> openai` runtime)
- resolves model ID aliases
- loads soul/users/bootstrap/skills prompt context
- builds toolset through policy pipeline
- runs iterative tool-call loop (`MAX_TOOL_ROUNDS`)
- streams progress events
- enforces login/MFA continuation logic
- enforces checkout confirmation guard
- persists session history via `src/provider/session.ts`

## 2) Repository Map (What Owns What)

### 2.1 Entry and CLI
- `src/bin/t560.ts`: process entry
- `src/cli/run.ts`: command dispatch + startup checks

### 2.2 Runtime and transport
- `src/tui/tui.ts`: terminal UX and slash commands
- `src/gateway/runtime.ts`: starts dashboard + telegram with unified handler
- `src/gateway/router.ts`: thin route to chat service
- `src/gateway/types.ts`: inbound message types

### 2.3 Chat and provider orchestration
- `src/agent/chat-service.ts`: mode logic + route selection + failover behavior
- `src/provider/run.ts`: provider call/tool loop/progress/memory autosave hooks
- `src/provider/session.ts`: transcript persistence and cleanup
- `src/provider/usage-summary.ts`: usage aggregation exposed in status

### 2.4 Tooling layer
- `src/agents/pi-tools.ts`: full tool assembly + policy filtering
- `src/agents/t560-tools.ts`: product tool registration (browser/web/memory)
- `src/agents/tools/browser-tool.ts`: browser automation tool
- `src/agents/tools/web-tools.ts`: `web_search`, `web_fetch`
- `src/agents/tools/memory-tools.ts`: memory tools
- `src/agents/tools/fs-tools.ts`: read/write/edit/ls/find/exists
- `src/agents/bash-tools.exec.ts`: `exec`
- `src/agents/bash-tools.process.ts`: `process`
- `src/agents/pi-tool-definition-adapter.ts`: arg normalization, call execution, error/result shaping
- `src/agents/tool-result-contract.ts`: post-tool normalization for stable shape
- `src/agents/tool-policy.ts`: groups/profiles/allow/deny matching
- `src/agents/pi-tools.policy.ts`: effective policy resolution
- `src/agents/tool-policy-pipeline.ts`: ordered policy steps

### 2.5 Prompt and context injection
- `src/agents/system-prompt.ts`: global behavior + tool instructions
- `src/agents/bootstrap-context.ts`: injects workspace context files
- `src/agents/skills.ts`: runtime skill summary injection from workspace `skills/*/SKILL.md`

### 2.6 Security and credentials
- `src/security/setup-flow.ts`: conversational `/setup` flow
- `src/security/credentials-vault.ts`: encrypted credential storage and retrieval
- `src/agents/self-protection.ts`: command/path protection rules used by exec tool

### 2.7 Onboarding and provider catalog
- `src/onboarding/onboard.ts`: interactive onboarding flow
- `src/onboarding/provider-catalog.ts`: provider templates/default models/auth modes

### 2.8 Web backend
- `src/web/dashboard.ts`: HTTP APIs, WS chat RPC, setup endpoints, static UI serving

### 2.9 Web frontend
- `ui/src/main.ts`: frontend entry
- `ui/src/ui/app.ts`: central state + event handling
- `ui/src/ui/app-render.ts`: shell/nav/page rendering
- `ui/src/ui/app-gateway.ts`: WS client and live progress stream
- `ui/src/ui/app-setup.ts`: setup API calls/state normalization
- `ui/src/ui/views/chat.ts`: chat page UI
- `ui/src/ui/views/setup.ts`: setup page UI
- `ui/src/ui/views/status.ts`: status diagnostics page
- `ui/src/ui/views/settings.ts`: advanced editor page
- `ui/src/ui/chat/*`: chat rendering helpers
- `ui/src/styles/*`: visual system and responsive layout

## 3) Web App: Complete Breakdown

### 3.1 Frontend render stack

1. Browser loads bundle from `dist/control-ui`.
2. `ui/src/main.ts` imports global styles and app element.
3. `ui/src/ui/app.ts` (`<t560-app>`) is state owner.
4. `renderApp()` in `ui/src/ui/app-render.ts` chooses active page.
5. Page components in `ui/src/ui/views/*.ts` output HTML strings.

### 3.2 Where app behavior lives

- Global app state, click/input delegation, route switching:
  - `ui/src/ui/app.ts`
- WebSocket connection and event handling:
  - `ui/src/ui/app-gateway.ts`
- Setup data writes/reads and form orchestration:
  - `ui/src/ui/app-setup.ts`
- Theme/nav toggles:
  - `ui/src/ui/app-settings.ts`
- Scroll/new-message behavior:
  - `ui/src/ui/app-scroll.ts`

### 3.3 Page ownership

- Chat page:
  - `ui/src/ui/views/chat.ts`
  - edit compose area, queue, attachments, submit/stop controls here

- Setup page:
  - `ui/src/ui/views/setup.ts` (view layout)
  - `ui/src/ui/app-setup.ts` (all setup actions/API wiring)

- Status page:
  - `ui/src/ui/views/status.ts`
  - runtime cards, usage panel, event log, reconnect/history/inject actions

- Settings page:
  - `ui/src/ui/views/settings.ts`
  - soul/users/config/bootstrap editors

### 3.4 Styling ownership

- `ui/src/styles/base.css`: variables/tokens/base elements
- `ui/src/styles/layout.css`: shell desktop layout
- `ui/src/styles/layout.mobile.css`: mobile overrides
- `ui/src/styles/components.css`: shared components/cards/forms
- `ui/src/styles/chat/*.css`: chat-specific visuals

### 3.5 Backend endpoint ownership for web app

In `src/web/dashboard.ts`:

Read/status:
- `GET /health`
- `GET /api/status`
- `GET /api/events`
- `GET /api/setup`
- `GET /api/vault`
- `GET /api/profile/soul`
- `GET /api/profile/users`
- `GET /api/config`
- `GET /api/context/bootstrap`

Write/setup:
- `PUT /api/setup/provider`
- `DELETE /api/setup/provider`
- `PUT /api/setup/routing`
- `PUT /api/setup/telegram`
- `PUT /api/vault`
- `DELETE /api/vault`
- `PUT /api/profile/soul`
- `PUT /api/profile/users`
- `PUT /api/config`
- `PUT /api/context/bootstrap`

OAuth helper endpoints:
- `POST /api/setup/oauth/codex/start`
- `POST /api/setup/oauth/codex/code`
- `GET /api/setup/oauth/codex/status`
- `GET /api/setup/cc-token`

Chat over WS (`/ws`):
- request methods include:
  - `chat.send`
  - `chat.history`
  - `chat.inject`
  - `chat.abort`

### 3.6 Web edit recipes

If you need to edit...

- Add a new button or action:
  - add markup in the relevant `ui/src/ui/views/*.ts`
  - handle `data-action` in `ui/src/ui/app.ts`

- Add a new setup operation:
  - client call/state in `ui/src/ui/app-setup.ts`
  - endpoint handler in `src/web/dashboard.ts`
  - optionally add UI inputs in `ui/src/ui/views/setup.ts`

- Change live progress behavior:
  - `ui/src/ui/app-gateway.ts` (`summarizeAgentEvent`, `pushLiveProgress`)

- Add a new page/tab:
  - update `ui/src/ui/navigation.ts`
  - add renderer branch in `ui/src/ui/app-render.ts`
  - create `ui/src/ui/views/<new-page>.ts`

## 4) Providers and Models

### 4.1 Catalog source of truth

Provider templates/default models/auth are in:
- `src/onboarding/provider-catalog.ts`

This feeds:
- onboarding TUI (`src/onboarding/onboard.ts`)
- web setup payload (`src/web/dashboard.ts` -> `buildSetupPayload()`)
- web setup UI (`ui/src/ui/app-setup.ts` + `ui/src/ui/views/setup.ts`)

### 4.2 DeepSeek behavior (current)

DeepSeek canonical model IDs are normalized to:
- `deepseek-chat`
- `deepseek-reasoner`

Normalization and aliases are handled in:
- `src/onboarding/provider-catalog.ts` (`normalizeProviderModels`)
- runtime aliasing in `src/provider/run.ts` (`resolveModelAlias`)

Runtime provider mapping is handled in:
- `src/provider/run.ts` (`resolveRuntimeProvider`)
- allows providers not natively in underlying runtime by mapping to compatible runtime provider (for example DeepSeek via OpenAI-compatible path)

## 5) Config, State, and Filesystem Contracts

### 5.1 Canonical config type

`src/config/state.ts` defines `T560Config`:
- `providers`
- `routing`
- `models` (compatibility model refs)
- `channels`
- `tools`
- `skills`
- `usage`
- `agents`

### 5.2 Default state directory

By default state lives at:
- `~/.t560`

Overridable via:
- `T560_STATE_DIR`

Important files:
- `~/.t560/config.json`
- `~/.t560/sessions/*.json`
- `~/.t560/memory.jsonl`
- `~/.t560/soul.md`
- `~/.t560/users.md`
- `~/.t560/user.md` (compatibility mirror)
- `~/.t560/pairing.json`

### 5.3 Secure credentials

Credentials are split between encrypted payload and key:
- encrypted payload in workspace: `.t560-secure/credentials.v1.enc`
- key in home state area: `~/.t560/secure/vault.key`

Sensitive path access is blocked in:
- filesystem tools (`src/agents/tools/fs-tools.ts`)
- exec tool (`src/agents/bash-tools.exec.ts`)

## 6) Tooling Architecture (Detailed)

### 6.1 Tool assembly pipeline

`createT560CodingTools()` in `src/agents/pi-tools.ts` builds tools in order:
1. `exec`
2. `process`
3. filesystem tools (`read/write/edit/ls/find/exists`)
4. t560 tools from `src/agents/t560-tools.ts`:
   - `browser`
   - `web_search`
   - `web_fetch`
   - memory tools (`memory_search`, `memory_get`, `memory_save`, `memory_delete`, `memory_list`, `memory_prune`, `memory_feedback`, `memory_stats`, `memory_compact`)

### 6.2 Policy filtering order

Policy pipeline in `src/agents/tool-policy-pipeline.ts`:
1. profile policy (`tools.profile`)
2. global allow/deny (`tools.allow`/`tools.deny`)
3. provider policy (`tools.byProvider.allow`)
4. runtime policy (`tools.runtime`)
5. owner-only filter (`applyOwnerOnlyToolPolicy`)

Group/profile definitions are in `src/agents/tool-policy.ts`.

### 6.3 Tool execution contract

`src/agents/pi-tool-definition-adapter.ts` handles:
- tool arg normalization (aliases and shape fixes)
- tool execution
- stream update hooks
- error wrapping
- result serialization

`src/agents/tool-result-contract.ts` then normalizes result shapes for selected tools so models receive stable contracts.

### 6.4 Prompt-level tool guidance

Tool instruction text and ordering in prompt are defined in:
- `src/agents/system-prompt.ts`

If you add/rename tools and do not update this file, tool-call quality usually degrades.

### 6.5 Progress narration integration

Tool progress summaries are generated in:
- `src/provider/run.ts`
  - `summarizeArgsForProgress`
  - `summarizeOutcomeForProgress`

Add entries there when adding new high-impact tools, otherwise live progress in TUI/web/Telegram will be generic.

## 7) Memory Engine Internals

Memory tools live in `src/agents/tools/memory-tools.ts`.

Current capabilities:
- recall:
  - `memory_search`
  - `memory_get`
- write/manage:
  - `memory_save`
  - `memory_delete`
  - `memory_feedback`
- audit/retention:
  - `memory_list`
  - `memory_stats`
  - `memory_prune`
  - `memory_compact`

Data model highlights:
- trust tiers: `unverified`, `observed`, `verified`, `system`
- namespace scoping (default `global`)
- reinforce counters and confidence/importance scoring
- conflict detection and `onConflict` behavior (`upsert`/`replace`)
- namespace quota enforcement and eviction policy
- secret detection guard for `memory_save`

Storage:
- append-only JSONL file with delete markers, compactable later
- default path: `~/.t560/memory.jsonl`

Memory search also scans workspace docs:
- `MEMORY.md`, `memory.md`, `memory/*.md`
- surrounding context files (AGENTS/SOUL/TOOLS/etc) when enabled

## 8) How To Add a New Tool (Production Workflow)

This is the required path for safe tool additions.

### Step 1: Implement tool module

Create file in `src/agents/tools/<tool-name>-tool.ts`.

Rules:
- export `create<YourTool>Tool(...): AnyAgentTool`
- use `Type.Object(...)` schema from `@mariozechner/pi-ai`
- validate params defensively
- return structured JSON-safe objects
- throw clear errors for invalid inputs

### Step 2: Register tool

Wire tool into `src/agents/t560-tools.ts` (or `src/agents/pi-tools.ts` for core changes).

Recommendation:
- product-level tools go in `t560-tools.ts`
- keep `pi-tools.ts` focused on assembly/policy

### Step 3: Add policy support

Update `src/agents/tool-policy.ts`:
- include tool name in appropriate `TOOL_GROUPS`
- ensure relevant profiles allow it (for example `coding`)

### Step 4: Add system prompt summary

Update `src/agents/system-prompt.ts`:
- `coreToolSummaries`
- tool ordering list

### Step 5: Add result normalization (if needed)

If tool outputs complex payloads, normalize in:
- `src/agents/tool-result-contract.ts`

### Step 6: Add progress summaries

Update in `src/provider/run.ts`:
- `summarizeArgsForProgress`
- `summarizeOutcomeForProgress`

### Step 7: Optional UI tool-card support

If you want richer tool call rendering in chat:
- `ui/src/ui/chat/tool-cards.ts`
- keep progress summary strings clean in `src/provider/run.ts` so cards remain readable

### Step 8: Add tests

Add focused tests in `test/`.

Common patterns:
- tool unit behavior
- result contract normalization
- provider loop regression where tool appears in orchestration

### Step 9: Build and verify

From repo root:

```bash
npm run build:server
npm run build:ui
```

Run targeted tests:

```bash
node --import tsx --test test/<your_test>.test.js
```

### Step 10: Document the tool

Update:
- `codex.md` (this file)
- `TOOLS.md` if behavior/policy expectations changed

## 9) Add a Skill for a Tool (So Agent Uses It Well)

Skills are instruction files that teach usage patterns.

### 9.1 Runtime skill discovery

Active provider loop uses:
- `src/agents/skills.ts`

It scans workspace directory:
- `skills/<skill-folder>/SKILL.md`

It injects compact summaries into prompt as `<available_skills>`.

### 9.2 Create a tool-specific skill

1. Create folder:
- `skills/<tool-name>/`

2. Create `skills/<tool-name>/SKILL.md` with frontmatter:

```md
---
name: your-tool-skill
description: When and how to use <tool_name> safely and effectively.
---

# Your Tool Skill

Use this skill when...

## Input Checklist
- ...

## Call Patterns
- ...

## Failure Handling
- ...

## Verification
- ...
```

3. Keep it operational:
- include concrete call sequencing
- include verification steps
- include fail-safe behavior

### 9.3 Skill metadata parsed today

`src/agents/skills.ts` currently reads:
- `name:` and `description:` from skill frontmatter/body
- fallback description from first non-empty line when description is missing

Reference examples:
- `skills/clawhub/SKILL.md`
- `skills/terminal-exec/SKILL.md`

## 10) Web App Editing Playbook (By Task)

If you need to...

- change chat input/send behavior:
  - `ui/src/ui/app.ts`
  - `ui/src/ui/app-chat.ts`
  - `ui/src/ui/views/chat.ts`

- change rendered message grouping or markdown behavior:
  - `ui/src/ui/chat/grouped-render.ts`
  - `ui/src/ui/markdown.ts`

- change WS reconnect or event handling:
  - `ui/src/ui/app-gateway.ts`

- add setup provider fields:
  - backend shape: `src/web/dashboard.ts`
  - client state/payload: `ui/src/ui/app-setup.ts`
  - UI controls: `ui/src/ui/views/setup.ts`

- change status diagnostics cards:
  - `ui/src/ui/views/status.ts`

- change settings editor behavior:
  - `ui/src/ui/views/settings.ts`
  - `ui/src/ui/app-config.ts`

- change page routes/navigation labels:
  - `ui/src/ui/navigation.ts`
  - `ui/src/ui/app-render.ts`

## 11) Bootstrap Context Files (Prompt Contract)

Runtime expects these files for injected workspace context:
- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`

Loader:
- `src/agents/bootstrap-context.ts`

If missing in workspace, fallback uses state files for soul/user where available.

## 12) Build, Run, and Validation Commands

Build server:

```bash
npm run build:server
```

Build UI:

```bash
npm run build:ui
```

Full build:

```bash
npm run build
```

Run development CLI (tsx):

```bash
npm run dev
```

Run installed runtime:

```bash
t560
```

Useful checks:

```bash
curl http://127.0.0.1:5600/health
curl http://127.0.0.1:5600/api/status
```

## 13) Troubleshooting Map

- Provider unsupported/model not found:
  - `src/provider/run.ts`
  - `src/onboarding/provider-catalog.ts`
  - `src/web/dashboard.ts` setup normalization

- Tool not callable or missing:
  - `src/agents/t560-tools.ts`
  - `src/agents/pi-tools.ts`
  - `src/agents/tool-policy.ts`

- Tool executes but results are noisy:
  - `src/agents/tool-result-contract.ts`
  - `src/provider/run.ts` progress summaries

- Web UI action does nothing:
  - check `data-action` in view file
  - ensure handler exists in `ui/src/ui/app.ts`
  - ensure network call exists in `ui/src/ui/app-setup.ts` or `ui/src/ui/app-config.ts`

- Setup save works but routing/provider resolves wrong:
  - `src/web/dashboard.ts` (`handlePutSetupProvider`, `handlePutSetupRouting`)
  - `src/agent/chat-service.ts` route slot and fallback

- Skill not being surfaced:
  - folder must be `skills/<name>/SKILL.md`
  - summary parse is in `src/agents/skills.ts`

## 14) Change Checklist Before You Merge

1. Did you edit the active runtime path?
2. If you added/changed a tool, did you update:
- registration
- policy groups/profiles
- prompt summaries
- result contract
- progress summaries
- tests
3. If web UI changed, did you verify both desktop and mobile CSS paths?
4. If setup payload changed, did you update both backend route and frontend state normalization?
5. Did `npm run build:server` pass?
6. Did relevant tests pass?
7. Did you update `codex.md` and any affected bootstrap docs?

## 15) Practical Rules for This Repo

- Prefer targeted edits over broad rewrites.
- Keep self-protection enabled.
- Do not edit `dist/` by hand.
- Verify destructive changes with explicit checks.
- For major behavior changes, update tests and this document in the same branch.
