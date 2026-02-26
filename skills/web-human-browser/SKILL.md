---
name: web-human-browser
description: Execute end-to-end website tasks using browser tool actions like a human operator: navigate, log in with vault credentials, handle OTP/MFA, detect human verification challenges, wait for network events, and safely gate purchases.
tools: [browser]
---

# Web Human Browser

Use this workflow for any multi-step website task (shopping, account actions, dashboards, forms).

## Core loop

1. `browser` `open` with `engine=live` on the user-provided root URL.
2. `browser` `snapshot` with `networkIdle=true` to get stable refs after SPA loads.
3. Use refs (`e1`, `e2`, ...) for `click`/`fill`/`type`/`submit`/`select`/`press`/`act`.
4. After major actions, run `snapshot` (or `wait`) before continuing.

## Authentication rules

1. If sign-in is needed, run `browser` `login` with `service=<host>`.
2. Never use social OAuth buttons when vault credentials exist.
3. If login returns `requiresMfa=true`, fetch code from `email` when configured; otherwise ask the user.
4. When user provides an OTP, call `browser` `mfa` first, immediately.
5. Use `browser` `challenge` when login/page state looks blocked by captcha or human verification.

## Reliability tools

1. Use `browser` `wait_for_request` when completion depends on API calls.
2. Use `browser` `downloads` to verify file downloads.
3. Use `browser` `console` and `browser` `dialog` when UI errors or prompts block progress.
4. For custom widgets, prefer semantic actions first (`select`, `press`, `fill`) before JS fallback.

## Safety rules

1. Never expose passwords or secrets.
2. Never claim OTP was sent unless login result confirms `submitted=true`.
3. Before purchase/checkout submit actions, require explicit user phrase: `confirm purchase`.

## Completion gate (required)

1. For any state-changing action (delete/update/submit/purchase/cancel), do not finalize immediately.
2. Run at least one direct verification step after the action, such as `browser` `snapshot` with `networkIdle=true` on the resulting state or a follow-up list/search/read view that proves the requested state change.
3. For destructive actions (remove/delete/cancel), verify absence from the UI (or status view), not just button clicks.
4. If verification is missing or ambiguous, explicitly report `not yet verified` and continue verification before claiming success.
