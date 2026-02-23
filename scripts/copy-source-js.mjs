import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const srcRoot = path.join(projectRoot, "src");
const distRoot = path.join(projectRoot, "dist");

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
      continue;
    }
    out.push(full);
  }
  return out;
}

async function main() {
  if (!(await pathExists(srcRoot))) {
    return;
  }
  await fs.mkdir(distRoot, { recursive: true });

  const files = await walk(srcRoot);
  let copied = 0;

  for (const sourcePath of files) {
    if (!sourcePath.endsWith(".js")) {
      continue;
    }

    // If a same-basename TS source exists, tsc already emitted the runtime JS.
    const tsSibling = sourcePath.slice(0, -3) + ".ts";
    if (await pathExists(tsSibling)) {
      continue;
    }

    const rel = path.relative(srcRoot, sourcePath);
    const dest = path.join(distRoot, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(sourcePath, dest);
    copied += 1;
  }

  process.stdout.write(`[build] copied ${copied} JS runtime file(s) from src to dist\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[build] copy-source-js failed: ${message}\n`);
  process.exitCode = 1;
});
