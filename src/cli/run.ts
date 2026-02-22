import { readFile } from "node:fs/promises";
import { cancel, confirm, isCancel } from "@clack/prompts";
import { readOnboardingStatus } from "../config/state.js";
import { runRuntimePreflight } from "../config/runtime-preflight.js";
import { printBanner } from "./banner.js";
import { stylePromptMessage, stylePromptTitle } from "./prompt-style.js";
import { isRich, theme } from "./theme.js";

async function resolveVersion(): Promise<string> {
  try {
    const packageUrl = new URL("../../package.json", import.meta.url);
    const packageRaw = await readFile(packageUrl, "utf-8");
    const parsed = JSON.parse(packageRaw) as { version?: string };
    return parsed.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function printHelp(): void {
  const heading = (label: string) => (isRich() ? theme.heading(label) : label);
  const cmd = (value: string) => (isRich() ? theme.command(value) : value);

  process.stdout.write(
    [
      `${heading("Usage:")} t560 [command]`,
      "",
      `${heading("Commands:")}`,
      `  ${cmd("start")}        Start the local t560 runtime (legacy readline mode)`,
      `  ${cmd("gateway")}      Start gateway runtime (alias of start)`,
      `  ${cmd("tui")}          Start full-screen t560 terminal UI (default)`,
      `  ${cmd("onboard")}      Run onboarding wizard`,
      `  ${cmd("pairing")}      Manage DM pairing approvals`,
      `  ${cmd("completion")}   Show completion scaffold status`,
      `  ${cmd("help")}         Show this help`
    ].join("\n") + "\n"
  );
}

function isVitalMissing(path: string): boolean {
  return (
    path === "providers" ||
    path.startsWith("providers.") ||
    path.startsWith("routing.") ||
    path.startsWith("tools.selfProtection.") ||
    path === "user.md" ||
    path === "users.md" ||
    path === "soul.md"
  );
}

async function promptYesNo(message: string, initial = true): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const response = await confirm({
    message: stylePromptMessage(message),
    initialValue: initial
  });
  if (isCancel(response)) {
    cancel(stylePromptTitle("Setup cancelled.") ?? "Setup cancelled.");
    return false;
  }
  return Boolean(response);
}

async function maybeRunStartupOnboarding(command: string): Promise<boolean> {
  if (command !== "start" && command !== "gateway" && command !== "tui") {
    return true;
  }

  const status = await readOnboardingStatus();
  if (status.onboarded) {
    return true;
  }

  const vitalMissing = status.missing.filter((item) => isVitalMissing(item));
  if (vitalMissing.length === 0) {
    return true;
  }

  process.stdout.write(`Missing required onboarding fields: ${vitalMissing.join(", ")}\n`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write("Run `t560 onboard` to complete setup.\n");
    return false;
  }

  const shouldRun = await promptYesNo("Start onboarding now?", true);
  if (shouldRun) {
    const onboardingModule = await import("../onboarding/onboard.js").catch(() => null);
    if (!onboardingModule || typeof onboardingModule.runOnboarding !== "function") {
      process.stderr.write("onboard command unavailable in this recovered build.\n");
      return false;
    }
    await onboardingModule.runOnboarding();
  } else {
    return false;
  }

  const nextStatus = await readOnboardingStatus();
  const stillMissing = nextStatus.missing.filter((item) => isVitalMissing(item));
  if (stillMissing.length > 0) {
    process.stdout.write(`Missing required onboarding fields: ${stillMissing.join(", ")}\n`);
    process.stdout.write("Run `t560 onboard` to complete setup.\n");
    return false;
  }

  return true;
}

async function runStartupPreflight(command: string): Promise<boolean> {
  if (command !== "start" && command !== "gateway" && command !== "tui") {
    return true;
  }

  const preflight = await runRuntimePreflight();
  if (preflight.warnings.length > 0) {
    process.stderr.write("Runtime warnings:\n");
    for (const warning of preflight.warnings) {
      process.stderr.write(`- ${warning}\n`);
    }
    process.stderr.write("Proceeding despite warnings.\n");
  }
  if (preflight.ok) {
    return true;
  }

  process.stderr.write("Startup blocked: configuration validation failed.\n");
  for (const error of preflight.errors) {
    process.stderr.write(`- ${error}\n`);
  }
  process.stderr.write("Run `t560 onboard` to update configuration.\n");
  return false;
}

export async function runCli(argv: string[]): Promise<void> {
  const command = argv[2] ?? "tui";
  const version = await resolveVersion();
  printBanner({ version });

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "onboard") {
    const onboardingModule = await import("../onboarding/onboard.js").catch(() => null);
    if (!onboardingModule || typeof onboardingModule.runOnboarding !== "function") {
      process.stderr.write("onboard command unavailable in this recovered build.\n");
      process.exitCode = 1;
      return;
    }
    await onboardingModule.runOnboarding();
    return;
  }

  if (command === "completion") {
    const mod = await import("./completion-cli.js").catch(() => null);
    if (!mod || typeof mod.printCompletionHelp !== "function") {
      process.stderr.write("completion command unavailable in this recovered build.\n");
      process.exitCode = 1;
      return;
    }
    mod.printCompletionHelp();
    return;
  }

  if (command === "pairing") {
    const mod = await import("./pairing-cli.js").catch(() => null);
    if (!mod || typeof mod.runPairingCli !== "function") {
      process.stderr.write("pairing command unavailable in this recovered build.\n");
      process.exitCode = 1;
      return;
    }
    await mod.runPairingCli(argv);
    return;
  }

  if (command !== "start" && command !== "gateway" && command !== "tui") {
    process.stderr.write(`Unknown command: ${command}\n\n`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const onboardingReady = await maybeRunStartupOnboarding(command);
  if (!onboardingReady) {
    process.exitCode = 1;
    return;
  }

  const preflightReady = await runStartupPreflight(command);
  if (!preflightReady) {
    process.exitCode = 1;
    return;
  }

  if (command === "tui") {
    const tuiModule = await import("../tui/tui.js").catch(() => null);
    if (!tuiModule || typeof tuiModule.runTui !== "function") {
      process.stderr.write("tui command unavailable in this recovered build.\n");
      process.stderr.write("Run `t560 onboard` or rebuild from a fresh clone.\n");
      process.exitCode = 1;
      return;
    }
    await tuiModule.runTui();
    return;
  }

  const runtimeModule = await import("../agent/runtime.js").catch(() => null);
  if (!runtimeModule || typeof runtimeModule.runAgentRuntime !== "function") {
    process.stderr.write("runtime command unavailable in this recovered build.\n");
    process.stderr.write("Run `t560 onboard` or rebuild from a fresh clone.\n");
    process.exitCode = 1;
    return;
  }

  await runtimeModule.runAgentRuntime();
}
