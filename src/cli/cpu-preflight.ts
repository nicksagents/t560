import { spawnSync } from "node:child_process";

export type CpuProcessSample = {
  pid: number;
  cpu: number;
  mem: number;
  command: string;
  args: string;
  isT560: boolean;
};

const DEFAULT_LIMIT = 6;

function parseNumber(value: string): number {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return parsed;
}

function parsePsLine(line: string): CpuProcessSample | null {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.*)$/);
  if (!match) {
    return null;
  }
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const cpu = parseNumber(match[2]);
  const mem = parseNumber(match[3]);
  const command = String(match[4] ?? "").trim();
  const args = String(match[5] ?? "").trim();
  const haystack = `${command} ${args}`.toLowerCase();
  const isT560 =
    haystack.includes("/desktop/t560/") &&
    (haystack.includes("dist/bin/t560.js") ||
      haystack.includes("src/bin/t560.ts") ||
      haystack.includes("/scripts/t560"));
  return {
    pid,
    cpu,
    mem,
    command,
    args,
    isT560,
  };
}

function collectFromPs(limit: number): CpuProcessSample[] {
  const attempts: string[][] = [
    // GNU ps (Linux)
    ["-eo", "pid=,pcpu=,pmem=,comm=,args=", "--sort=-pcpu"],
    // BSD/macOS ps fallback
    ["-Ao", "pid=,pcpu=,pmem=,comm=,args=", "-r"],
  ];

  for (const args of attempts) {
    const result = spawnSync("ps", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error || result.status !== 0) {
      continue;
    }
    const lines = String(result.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      continue;
    }
    const out: CpuProcessSample[] = [];
    for (const line of lines) {
      const parsed = parsePsLine(line);
      if (!parsed) {
        continue;
      }
      out.push(parsed);
      if (out.length >= limit) {
        break;
      }
    }
    if (out.length > 0) {
      return out;
    }
  }
  return [];
}

export function collectCpuSamples(limit = DEFAULT_LIMIT): CpuProcessSample[] {
  const safeLimit = Math.max(1, Math.min(12, Math.floor(limit)));
  return collectFromPs(safeLimit);
}

export function formatCpuSamples(samples: CpuProcessSample[]): string[] {
  return samples.map((entry) => {
    const label = `${entry.command} ${entry.args}`.trim();
    const compact = label.replace(/\s+/g, " ");
    const preview = compact.length > 72 ? `${compact.slice(0, 69)}...` : compact;
    return `- pid=${entry.pid} cpu=${entry.cpu.toFixed(1)}% mem=${entry.mem.toFixed(1)}% ${preview}`;
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function stopProcesses(pids: number[]): Promise<number[]> {
  const unique = Array.from(
    new Set(
      pids.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid),
    ),
  );
  if (unique.length === 0) {
    return [];
  }

  for (const pid of unique) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
  await wait(900);

  const stillRunning = unique.filter((pid) => isProcessAlive(pid));
  for (const pid of stillRunning) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
  await wait(150);

  return unique.filter((pid) => !isProcessAlive(pid));
}
