---
name: terminal-exec
description: Run terminal commands and manage background processes with the exec/process tools. Use for shell work (bash commands, file operations, installs, system checks), or when verifying/creating/removing files on the host.
---

# Terminal Exec (exec/process)

Use this skill to run any terminal command safely and verify outcomes. Use `exec` for the actual command and `process` to monitor background jobs.

## Golden Rules

- Always use `exec` for shell actions. Do not claim success without a successful tool result.
- Prefer explicit, absolute paths. Expand `~` when constructing paths.
- Use `cd <dir> && <command>` inside `exec` when the user asks to “cd then do X”.
- Verify file operations with a follow-up check (`ls`, `test -f`, `cat`, etc.).
- If a command fails (non-zero exit or error), report the failure and the error text.

## Exec Tool Usage

Basic:

```bash
exec command:"ls -la"
```

With working directory:

```bash
exec workdir:"/home/agent_t490/Desktop" command:"rm -f t560_exec_test.txt"
```

Chained (cd then act):

```bash
exec command:"cd ~/Desktop && touch hello.txt && ls -la"
```

Timeout (seconds):

```bash
exec timeoutSec:120 command:"long_running_task"
```

## Background Jobs

Start a background process and poll it:

```bash
exec background:true command:"sleep 10 && echo done"
process action:poll sessionId:"<from exec result>" timeout:2000
```

Use `process action:log` to fetch output, and `process action:kill` to terminate.

## Verification Patterns

- File exists: `test -f /path && echo "ok"`
- File removed: `test ! -f /path && echo "gone"`
- Directory exists: `test -d /path && echo "ok"`
- Show file contents: `cat /path`

## Reporting

When you finish, report:
- A brief, user-friendly summary of what changed
- Any important warnings or errors
- A quick verification note (e.g., "verified the file exists" or "confirmed removal")

Do not include raw commands, tool syntax, or full stdout/stderr dumps in the user-facing reply.
Never output sections titled "Commands executed" or "Tool calls".
