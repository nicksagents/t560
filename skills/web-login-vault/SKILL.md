---
name: web-login-vault
description: Run secure website/app sign-in using vault credentials with browser login+mfa flow. Use when the user asks to open a site, sign in, check account/dashboard/balance, or send/enter one-time codes. Prefer vault identifier+secret injection and never use social OAuth buttons.
tools: [browser, email]
---

# Web Login + Vault

Use this workflow for authentication tasks.

## Required flow

1. Open the target site with `browser` action `open` and `engine=live`.
2. Run `browser` action `login` with `service=<site host or saved service>`.
3. Never click social/OAuth sign-in providers (Google/Apple/Microsoft/GitHub/etc.).
4. Do not ask the user for password or secret; vault login handles secret injection.
5. If `requiresMfa=true`:
- If `mfa.sourceCredentialAvailable=true` and a source service exists, check mailbox using `email` first.
- If no usable code is found, ask the user for the one-time code in one short sentence.
6. When user sends a code, call `browser` action `mfa` immediately.
7. If `browser` action `challenge` reports human verification, pause and ask the user to complete the challenge before retrying login.

## MFA code retrieval order

1. `email` action `list_unread` with `includeBody=true` and small `limit`.
2. If no code found, `email` action `read_recent` with `includeBody=true`.
3. If still no code, ask user for the code.

## Guardrails

- Treat passwords, secrets, and one-time codes as secrets. Never echo them.
- Email/username identifiers are not secrets; report the exact identifier used when user asks what was entered.
- If login fails due missing vault credentials, instruct user to add them in Setup -> Vault or `/setup <service-or-site>`.
- If browser says code step not submitted, do not claim OTP was sent.

## Completion gate (required)

1. Do not claim sign-in/account task completion immediately after `login`/`mfa`.
2. Run a post-login verification step on the live page (for example `snapshot` with `networkIdle=true`) and confirm authenticated state evidence.
3. Evidence must be concrete (account dashboard elements, authenticated nav state, account-specific data, or explicit success state).
4. If authentication state cannot be confirmed, report `not yet verified` and continue verification before finalizing.
