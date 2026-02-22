#!/usr/bin/env node

import { runCli } from "../cli/run.js";

runCli(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`Fatal error while starting t560:\n${message}\n`);
  process.exit(1);
});
