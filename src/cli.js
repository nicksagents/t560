#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entryTs = path.join(here, "entry.ts");
const args = ["--import", "tsx", entryTs, ...process.argv.slice(2)];

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[t560] Failed to launch TS CLI: ${message}`);
  process.exit(1);
});
