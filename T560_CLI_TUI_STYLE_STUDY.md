# T560 CLI/TUI Style Study Blueprint

This document captures the CLI/TUI styling and layout patterns observed from `references/openclaw/` and translates them into implementation targets for `t560`.

## Source Scope Reviewed

Primary files inspected:
- `references/openclaw/src/cli/banner.ts`
- `references/openclaw/src/cli/route.ts`
- `references/openclaw/src/cli/run-main.ts`
- `references/openclaw/src/cli/tui-cli.ts`
- `references/openclaw/src/runtime.ts`
- `references/openclaw/src/terminal/theme.ts`
- `references/openclaw/src/terminal/prompt-style.ts`
- `references/openclaw/src/tui/theme/theme.ts`
- `references/openclaw/src/tui/theme/syntax-theme.ts`
- `references/openclaw/src/tui/components/chat-log.ts`
- `references/openclaw/src/tui/components/user-message.ts`
- `references/openclaw/src/tui/components/assistant-message.ts`
- `references/openclaw/src/tui/components/tool-execution.ts`
- `references/openclaw/src/tui/components/custom-editor.ts`
- `references/openclaw/src/tui/components/filterable-select-list.ts`
- `references/openclaw/src/tui/components/searchable-select-list.ts`
- `references/openclaw/src/tui/components/selectors.ts`
- `references/openclaw/src/tui/commands.ts`
- `references/openclaw/src/tui/tui-event-handlers.ts`
- `references/openclaw/src/tui/tui-formatters.ts`
- `references/openclaw/src/tui/tui-overlays.ts`
- `references/openclaw/src/tui/tui-types.ts`
- `references/openclaw/src/tui/tui-waiting.ts`
- `references/openclaw/src/tui/tui.ts`

## Important Limitation In This Local Reference Snapshot

The local `references/openclaw` copy is partially corrupted/truncated:
- `references/openclaw/src/tui/tui.ts` ends mid-state setter.
- `references/openclaw/src/tui/tui-command-handlers.ts` ends mid-switch.
- `references/openclaw/src/tui/components/searchable-select-list.ts` ends mid-handler.
- `references/openclaw/src/tui/index.ts` contains an error string, not code.
- Additional files show similar corruption markers and hard truncation.

Because of this, we can confidently reproduce observed style/layout patterns, but not claim complete parity from this local snapshot alone.

## Core CLI/TUI Visual System

### 1) Theming Strategy

- A centralized theme token map drives all text/bg styling.
- Distinct roles are separated into semantic tokens:
  - `accent`, `accentSoft`, `dim`, `systemText`, `error`, `success`
  - `userBg`, `userText`
  - `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`
  - markdown-specific tokens for `heading/link/code/quote/hr/listBullet`
- Syntax highlighting is implemented with a dedicated token theme map and fallback coloring.

Implementation takeaway for `t560`:
- Keep all colors and typography effects in one source (`src/cli/theme.ts` + markdown tool renderer theme object).
- Keep role-based tokens, not hardcoded per component.

### 2) Message Presentation Hierarchy

- User messages render as padded markdown blocks with background fill.
- Assistant messages render in terminal default foreground for contrast portability.
- System lines are short and dim/secondary.
- Tool messages are boxed, state-colored, and include:
  - icon + title
  - normalized argument line
  - output preview with truncation
  - optional expanded mode for full output

Implementation takeaway for `t560`:
- Preserve role contrast: user bubble, assistant plain, system dim.
- Keep tool output collapsible with preview line cap.

### 3) Streaming + Run Lifecycle UX

- Assistant text updates incrementally by `runId`.
- Tool events attach to `toolCallId` and continue even after chat final events.
- Event gating depends on verbosity settings:
  - tool events hidden when verbose is off
  - tool partial/final output hidden unless full verbosity
- Waiting state uses animated shimmer + rotating phrase + elapsed time + connection status.

Implementation takeaway for `t560`:
- Keep event model run-scoped (`runId`) and tool-scoped (`toolCallId`).
- Preserve live feedback: show incremental progress, not only final one-shot responses.

### 4) Overlay/Picker UX

- Modal overlays for model/agent/session/settings selection.
- Searchable and filterable lists support fuzzy match and keyboard navigation.
- Selected rows use accent + stronger visual weight.

Implementation takeaway for `t560`:
- Add/keep searchable selectors for session/agent/model routing.
- Keep keyboard-first navigation (`j/k`, arrows, Enter, Esc).

### 5) Slash Command UX

- Slash commands are explicit, discoverable, and include completion hints.
- Command parsing includes aliases and argument completion for constrained values.
- Settings toggles are directly reflected in rendering behavior (e.g. tools expanded, show thinking).

Implementation takeaway for `t560`:
- Keep command grammar strict and ergonomic.
- Tie command-side state directly to renderer behavior.

## Behavioral Rules Worth Mirroring In T560

1. Ignore empty submissions.
2. Distinguish shell-bang lines from chat lines.
3. Keep prompt history and keybindings first-class.
4. Maintain max component count and prune oldest entries to avoid TUI memory growth.
5. Sanitize renderable text:
   - strip ANSI where needed
   - remove binary/noise artifacts
   - preserve copy-sensitive tokens (paths/urls)
6. Use safe markdown rendering with controlled styling.

## Foundation Parity Checklist For T560

- [ ] Single source of truth for theme tokens (CLI + message formatter)
- [ ] User/assistant/system role rendering parity
- [ ] Tool execution panel states (pending/success/error)
- [ ] Streaming assistant updates by `runId`
- [ ] Tool updates by `toolCallId`
- [ ] Verbosity gates for tool visibility and output detail
- [ ] Waiting shimmer + elapsed + connection status line
- [ ] Searchable/fuzzy selector components for overlays
- [ ] Slash command aliases + argument completions
- [ ] Render sanitation for long/binary/control-char content
- [ ] Message history/component pruning

## Immediate Work Plan For T560

1. Stabilize render stream surface:
   - Ensure incremental status/tool lines are emitted while agent is running.
   - Preserve final answer after streamed progress.
2. Improve tool narration quality:
   - Convert raw tool events to concise, human-readable progress lines.
   - Include fallback/retry and engine details in summaries.
3. Tighten browser task feedback:
   - Show deterministic "step -> finding -> next step" updates for web tasks.
4. Add parity tests:
   - formatter snapshots for role/tool/waiting states
   - run/tool event ordering tests
   - verbosity gate behavior tests

