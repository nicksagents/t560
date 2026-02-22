#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const entryTs = path.join(here, "../src/entry.ts");

let tsxLoaderPath;
try {
  tsxLoaderPath = require.resolve("tsx");
} catch {
  console.error("t560 error: missing dependency `tsx`.");
  console.error("Run: npm install");
  process.exit(1);
}

const child = spawn(process.execPath, ["--import", tsxLoaderPath, entryTs, ...process.argv.slice(2)], {
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
  console.error(`[t560] Failed to launch CLI: ${message}`);
  process.exit(1);
});
