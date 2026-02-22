import os from "node:os";
import path from "node:path";

function normalizeProfileName(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }
  if (/[^a-zA-Z0-9._-]/.test(normalized)) {
    return "";
  }
  return normalized;
}

export function parseCliProfileArgs(argv) {
  const nextArgv = [];
  let profile;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--dev") {
      if (profile && profile !== "dev") {
        return { ok: false, error: "Cannot combine --dev with a different --profile value." };
      }
      profile = "dev";
      continue;
    }

    if (arg === "--profile") {
      const value = argv[i + 1];
      if (typeof value !== "string") {
        return { ok: false, error: "Missing value for --profile <name>." };
      }
      const normalized = normalizeProfileName(value);
      if (!normalized) {
        return { ok: false, error: `Invalid profile name: ${value}` };
      }
      if (profile && profile !== normalized) {
        return { ok: false, error: "Multiple conflicting profile flags provided." };
      }
      profile = normalized;
      i += 1;
      continue;
    }

    if (arg.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length);
      const normalized = normalizeProfileName(value);
      if (!normalized) {
        return { ok: false, error: `Invalid profile name: ${value}` };
      }
      if (profile && profile !== normalized) {
        return { ok: false, error: "Multiple conflicting profile flags provided." };
      }
      profile = normalized;
      continue;
    }

    nextArgv.push(arg);
  }

  return { ok: true, argv: nextArgv, profile };
}

export function applyCliProfileEnv({ profile }) {
  const normalized = normalizeProfileName(profile);
  if (!normalized || normalized === "default") {
    return;
  }

  const profileRoot = path.join(os.homedir(), `.t560-${normalized}`);
  process.env.OPENCLAW_PROFILE = normalized;
  process.env.T560_PROFILE = normalized;
  process.env.T560_STATE_DIR = profileRoot;
  process.env.OPENCLAW_STATE_DIR = profileRoot;
  process.env.T560_CONFIG_PATH = path.join(profileRoot, "openclaw.json");
  process.env.OPENCLAW_CONFIG_PATH = process.env.T560_CONFIG_PATH;

  if (normalized === "dev" && !process.env.T560_GATEWAY_PORT) {
    process.env.T560_GATEWAY_PORT = "19001";
  }
}
