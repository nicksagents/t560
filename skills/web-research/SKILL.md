---
name: web-research
description: Use web_search and web_fetch to ground answers in current external sources with date-aware verification.
tools: [web_search, web_fetch]
---

# Web Research

Use this skill for internet fact-checking, news, and source-backed claims.

## Workflow

1. Use `web_search` to discover relevant sources.
2. Prefer recent/high-authority sources for time-sensitive requests.
3. Use `web_fetch` on top URLs to extract grounded evidence.
4. Compare publish dates when the user asks for current/latest information.
5. Report conclusions tied to fetched evidence, not assumptions.

## Guardrails

- Do not claim external facts without fetched support.
- Avoid stale pages when newer equivalents exist.
- Call out uncertainty when source evidence conflicts.

## Output expectations

1. State what sources indicate.
2. Include concrete dates for time-sensitive findings.
3. Keep claims bounded to the fetched evidence.
