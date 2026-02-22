import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveStateDir } from "../config/paths.js";
import { loadConfig } from "../config/store.js";

function nonEmpty(value) {
  const v = String(value ?? "").trim();
  return v.length > 0 ? v : "";
}

function repoRootDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

function parseFrontmatterAndBody(raw) {
  const text = String(raw ?? "");
  if (!text.startsWith("---\n")) {
    return { frontmatter: {}, body: text.trim() };
  }
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) {
    return { frontmatter: {}, body: text.trim() };
  }
  const fmText = text.slice(4, end);
  const body = text.slice(end + 5).trim();
  const lines = fmText.split("\n");
  const frontmatter = {};

  const stripQuotes = (v) => {
    const t = String(v ?? "").trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
    return t;
  };
  const isKeyLine = (line) => /^[A-Za-z0-9_-]+:\s*/.test(String(line ?? ""));
  const sanitizeJsonish = (v) =>
    String(v ?? "")
      .replace(/,\s*([}\]])/g, "$1")
      .trim();

  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] ?? "");
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = String(m[1]).trim();
    let rest = String(m[2] ?? "").trim();

    if (key === "description" && (rest === "|" || rest === ">")) {
      const parts = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = String(lines[j] ?? "");
        if (isKeyLine(next)) {
          i = j - 1;
          break;
        }
        parts.push(next.replace(/^\s{2}/, ""));
        i = j;
      }
      frontmatter[key] = parts.join("\n").trim();
      continue;
    }

    if (key === "metadata") {
      if (!rest) {
        const parts = [];
        let depth = 0;
        let started = false;
        for (let j = i + 1; j < lines.length; j += 1) {
          const next = String(lines[j] ?? "");
          const trimmed = next.trim();
          if (!started && !trimmed) {
            i = j;
            continue;
          }
          if (!started && !trimmed.startsWith("{")) {
            if (isKeyLine(next)) {
              i = j - 1;
              break;
            }
            i = j;
            continue;
          }
          started = true;
          parts.push(trimmed);
          depth += (trimmed.match(/\{/g) || []).length;
          depth -= (trimmed.match(/\}/g) || []).length;
          i = j;
          if (depth <= 0 && trimmed.includes("}")) break;
        }
        rest = parts.join("\n");
      }
      const metaRaw = sanitizeJsonish(rest);
      try {
        frontmatter[key] = JSON.parse(metaRaw);
      } catch {
        frontmatter[key] = {};
      }
      continue;
    }

    frontmatter[key] = stripQuotes(rest);
  }
  return { frontmatter, body };
}

function listSkillDirs(baseDir) {
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(baseDir, e.name))
      .filter((d) => fs.existsSync(path.join(d, "SKILL.md")));
  } catch {
    return [];
  }
}

function loadSkillFromDir(skillDir, source) {
  const skillPath = path.join(skillDir, "SKILL.md");
  try {
    const raw = fs.readFileSync(skillPath, "utf8");
    const { frontmatter, body } = parseFrontmatterAndBody(raw);
    const fallbackName = path.basename(skillDir);
    const name = nonEmpty(frontmatter.name) || fallbackName;
    const description = nonEmpty(frontmatter.description);
    if (!body) return null;
    return {
      name,
      description,
      metadata: frontmatter.metadata && typeof frontmatter.metadata === "object" ? frontmatter.metadata : {},
      body,
      source,
      path: skillPath,
    };
  } catch {
    return null;
  }
}

function mergeSkillsWithPrecedence(lists) {
  const map = new Map();
  for (const list of lists) {
    for (const skill of list) {
      map.set(String(skill.name).toLowerCase(), skill);
    }
  }
  return [...map.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const hasBinCache = new Map();
function hasBin(bin) {
  const key = String(bin ?? "").trim();
  if (!key) return false;
  if (hasBinCache.has(key)) return hasBinCache.get(key);
  const quoted = key.replace(/(["\\$`])/g, "\\$1");
  const cmd = process.platform === "win32" ? `where ${quoted}` : `command -v "${quoted}"`;
  const out = spawnSync(cmd, { shell: true, stdio: "ignore" });
  const ok = out.status === 0;
  hasBinCache.set(key, ok);
  return ok;
}

function configPathTruthy(cfg, dottedPath) {
  const parts = String(dottedPath ?? "")
    .split(".")
    .map((p) => p.trim())
    .filter(Boolean);
  let cur = cfg;
  for (const p of parts) {
    if (!cur || typeof cur !== "object" || !(p in cur)) return false;
    cur = cur[p];
  }
  return Boolean(cur);
}

function isSkillEnabledByConfig(skill, cfg) {
  const entries = cfg?.skills?.entries;
  if (!entries || typeof entries !== "object") return true;
  const meta = skill?.metadata?.t560 ?? {};
  const skillKey = nonEmpty(meta?.skillKey) || nonEmpty(skill?.name);
  const direct = entries[skillKey];
  if (direct && typeof direct === "object" && direct.enabled === false) return false;
  return true;
}

function skillEligibility(skill, cfg, env) {
  if (!isSkillEnabledByConfig(skill, cfg)) return { ok: false, reason: "disabled-by-config" };
  const meta = skill?.metadata?.t560 ?? {};
  if (!meta || typeof meta !== "object") return { ok: true, reason: "" };
  if (meta.always === true) return { ok: true, reason: "" };

  if (Array.isArray(meta.os) && meta.os.length > 0) {
    const allow = meta.os.map((v) => String(v).toLowerCase());
    if (!allow.includes(String(process.platform).toLowerCase())) return { ok: false, reason: "os" };
  }

  const req = meta.requires && typeof meta.requires === "object" ? meta.requires : {};
  if (Array.isArray(req.bins) && req.bins.some((b) => !hasBin(b))) return { ok: false, reason: "missing-bin" };
  if (Array.isArray(req.anyBins) && req.anyBins.length > 0 && !req.anyBins.some((b) => hasBin(b)))
    return { ok: false, reason: "missing-any-bin" };
  if (Array.isArray(req.env) && req.env.some((k) => !nonEmpty(env?.[String(k)])))
    return { ok: false, reason: "missing-env" };
  if (Array.isArray(req.config) && req.config.some((p) => !configPathTruthy(cfg, p)))
    return { ok: false, reason: "missing-config" };

  return { ok: true, reason: "" };
}

function isSkillActiveForMessage(skill, message) {
  const text = String(message ?? "").toLowerCase();
  if (!text) return false;
  const name = String(skill?.name ?? "").toLowerCase().trim();
  if (!name) return false;
  if (text.includes(`$${name}`)) return true;
  if (new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(text)) return true;
  const spaced = name.replace(/[-_]+/g, " ");
  if (spaced !== name && text.includes(spaced)) return true;
  return false;
}

function trimChars(text, maxChars) {
  const v = String(text ?? "");
  if (v.length <= maxChars) return v;
  return v.slice(0, maxChars) + "\n\n[truncated]";
}

export function loadSkillsCatalog({ workspaceDir, env = process.env } = {}) {
  const cfgSnap = loadConfig(env);
  const cfg = cfgSnap?.config ?? {};
  const bundledDir = path.join(repoRootDir(), "skills");
  const managedDir = path.join(resolveStateDir(env), "skills");
  const workspaceSkillsDir = path.join(path.resolve(String(workspaceDir ?? "")), "skills");

  const bundled = listSkillDirs(bundledDir)
    .map((d) => loadSkillFromDir(d, "bundled"))
    .filter(Boolean);
  const managed = listSkillDirs(managedDir)
    .map((d) => loadSkillFromDir(d, "managed"))
    .filter(Boolean);
  const workspace = listSkillDirs(workspaceSkillsDir)
    .map((d) => loadSkillFromDir(d, "workspace"))
    .filter(Boolean);

  // Precedence: bundled < managed < workspace
  const merged = mergeSkillsWithPrecedence([bundled, managed, workspace]);
  return merged.map((s) => {
    const el = skillEligibility(s, cfg, env);
    return { ...s, eligible: el.ok, reason: el.reason };
  });
}

export function loadMergedSkills({ workspaceDir, env = process.env } = {}) {
  return loadSkillsCatalog({ workspaceDir, env }).filter((s) => s.eligible);
}
