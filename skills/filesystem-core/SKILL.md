---
name: filesystem-core
description: Use filesystem tools for safe local file work: inspect, edit, and verify changes with read/write/edit/ls/find/exists.
tools: [read, write, edit, ls, find, exists]
---

# Filesystem Core

Use this skill for local workspace file operations.

## Workflow

1. Discover targets with `find` or `ls`.
2. Read files with `read` before changing behavior-critical sections.
3. Apply focused updates with `edit` when possible.
4. Use `write` for full-file replacements only when necessary.
5. Verify postconditions with `read`, `exists`, and `ls`.

## Guardrails

- Prefer minimal diffs over broad rewrites.
- Keep edits inside intended files only.
- Respect editable marker constraints when present.
- Do not claim completion without verification.

## Verification checklist

1. Confirm target path exists (or does not exist for deletes).
2. Confirm content changed as requested.
3. Confirm no unintended nearby changes.
