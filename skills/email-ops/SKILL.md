---
name: email-ops
description: Use the email tool to check inbox status, read unread/recent messages, and send replies with thread context.
tools: [email]
---

# Email Ops

Use this skill for mailbox actions via vault-backed credentials.

## Workflow

1. Start with `email` action `status` when mailbox state is unknown.
2. Use `list_unread` to discover candidate messages.
3. Use `read_unread` or `read_recent` for message content.
4. Use `send` for outbound messages and preserve threading fields when replying.

## Guardrails

- Do not expose secrets in outputs.
- If mailbox credentials are missing, direct user to Setup -> Vault or `/setup <service>`.
- If tool returns browser-login fallback for MFA/password flows, continue with browser login flow.

## Verification

1. For reads: confirm message count and identifiers.
2. For sends: confirm tool reported success and recipient/subject details.
