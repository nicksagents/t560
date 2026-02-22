total 16
drwxrwxr-x  2 agent_t490 agent_t490 4096 Feb 18 01:30 .
drwxrwxr-x 18 agent_t490 agent_t490 4096 Feb 18 02:07 ..
-rw-rw-r--  1 agent_t490 agent_t490 1022 Feb 18 01:30 bootstrap.js
-rw-rw-r--  1 agent_t490 agent_t490  931 Feb 18 01:30 identity.js
import fs from "node:fs";
import path from "node:path";

function writeFileIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) return false;
  fs.writeFileSync(filePath, content, "utf8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
  return true;
}

export function ensureWorkspaceBootstrap({ workspaceDir }) {
  const dir = path.resolve(String(workspaceDir ?? "").trim() || ".");
  fs.mkdirSync(dir, { recursive: true });

  const soulPath = path.join(dir, "SOUL.md");
  const userPath = path.join(dir, "USER.md");

  const soulTemplate = `# SOUL.md

You are t560.

Persona:
- Direct, pragmatic, security-minded.
- Prefer clear next steps and short answers.

Behavior:
- Never reveal secrets.
- Ask before doing anything destructive.
`;

  const userTemplate = `# USER.md

- Name:
- Preferred address:
- Notes:
`;

  const created = {
    soul: writeFileIfMissing(soulPath, soulTemplate),
    user: writeFileIfMissing(userPath, userTemplate),
  };

  return { dir, soulPath, userPath, created };
}

