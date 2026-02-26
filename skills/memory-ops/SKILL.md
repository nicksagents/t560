---
name: memory-ops
description: Use memory tools to retrieve, update, audit, and clean durable non-secret memory safely.
tools: [memory_search, memory_get, memory_save, memory_delete, memory_list, memory_prune, memory_feedback, memory_stats, memory_compact]
---

# Memory Ops

Use this skill for recall and durable context management.

## Recall flow

1. Run `memory_search` first for relevant entries.
2. Use `memory_get` for exact snippets before citing details.
3. If confidence is low, state uncertainty explicitly.

## Write flow

1. Save durable, non-secret preferences/workflow facts with `memory_save`.
2. Replace stale facts when corrected by the user.
3. Remove invalid memory with `memory_delete` when requested.

## Audit and maintenance

1. Use `memory_list` to inspect stored entries.
2. Use `memory_stats` to review quality and stale candidates.
3. Use `memory_prune` dry-run first, then apply cleanup.
4. Use `memory_compact` after heavy write/delete activity.
5. Use `memory_feedback` to reinforce useful entries.

## Guardrails

- Never store secrets (passwords, OTP codes, tokens, keys).
- Keep entries concise and scoped with namespace/trust settings.
