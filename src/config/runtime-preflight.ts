import { readFile } from "node:fs/promises";
import {
  readOnboardingStatus,
  resolveSoulPath,
  resolveTelegramBotToken,
  resolveUserPath,
  resolveUsersPath
} from "./state.js";
import { resolveTailscaleStatus } from "../network/tailscale.js";

export type RuntimePreflightResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

function looksLikeTelegramToken(token: string): boolean {
  return /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token.trim());
}

async function validateTelegramToken(token: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      method: "POST",
      signal: controller.signal
    });
    const raw = await response.text();

    if (!response.ok) {
      return `Telegram bot token check failed with HTTP ${response.status}.`;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return "Telegram bot token check failed: invalid Telegram API response.";
    }

    if (!parsed || typeof parsed !== "object") {
      return "Telegram bot token check failed: invalid Telegram API payload.";
    }

    const ok = (parsed as { ok?: unknown }).ok === true;
    if (!ok) {
      const description = (parsed as { description?: unknown }).description;
      return `Telegram bot token check failed: ${
        typeof description === "string" && description.trim() ? description.trim() : "unknown Telegram API error"
      }.`;
    }

    return null;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      return "Telegram bot token check timed out.";
    }
    const message = error instanceof Error ? error.message : String(error);
    return `Telegram bot token check failed: ${message}`;
  } finally {
    clearTimeout(timeout);
  }
}

async function validateReadableFile(filePath: string, label: string): Promise<string | null> {
  try {
    await readFile(filePath, "utf-8");
    return null;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `${label} is not readable: ${message}`;
  }
}

export async function runRuntimePreflight(): Promise<RuntimePreflightResult> {
  const status = await readOnboardingStatus();
  const errors: string[] = [];
  const warnings: string[] = [];

  const tailscale = await resolveTailscaleStatus();
  if (!tailscale.ip) {
    errors.push(tailscale.error ?? "Tailscale is required but unavailable.");
  }

  if (!status.onboarded) {
    errors.push(`Missing required onboarding fields: ${status.missing.join(", ")}`);
  }

  const fileChecks = await Promise.all([
    validateReadableFile(resolveSoulPath(), "soul.md"),
    validateReadableFile(resolveUserPath(), "user.md"),
    validateReadableFile(resolveUsersPath(), "users.md")
  ]);
  for (const issue of fileChecks) {
    if (issue) {
      errors.push(issue);
    }
  }

  const envToken = process.env.T560_TELEGRAM_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim();
  const configToken = status.config.channels?.telegram?.botToken?.trim();
  const telegramConfigured = Boolean(envToken || configToken || status.config.channels?.telegram);

  if (telegramConfigured) {
    const token = resolveTelegramBotToken(status.config);
    if (!token) {
      errors.push("Telegram is configured but bot token is missing.");
    } else if (!looksLikeTelegramToken(token)) {
      errors.push("Telegram bot token format looks invalid. Expected format: <digits>:<secret>.");
    } else {
      const tokenError = await validateTelegramToken(token);
      if (tokenError) {
        const normalized = tokenError.toLowerCase();
        const networkIssue =
          normalized.includes("fetch failed") ||
          normalized.includes("timed out") ||
          normalized.includes("timeout") ||
          normalized.includes("network");
        if (networkIssue) {
          warnings.push(tokenError);
        } else {
          errors.push(tokenError);
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings
  };
}
