import { spawnSync } from "node:child_process";

export type TailscaleStatus = {
  ip: string | null;
  error: string | null;
};

function parseFirstIpv4(value: string): string | null {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^\d{1,3}(?:\.\d{1,3}){3}$/);
    if (!match) {
      continue;
    }
    if (line.startsWith("127.")) {
      continue;
    }
    return line;
  }
  return null;
}

export async function resolveTailscaleStatus(): Promise<TailscaleStatus> {
  const envIp = process.env.T560_TAILSCALE_IP?.trim() || process.env.TAILSCALE_IP?.trim();
  if (envIp) {
    return { ip: envIp, error: null };
  }

  const cmd = spawnSync("tailscale", ["ip", "-4"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (cmd.error) {
    return { ip: null, error: "Tailscale CLI not available." };
  }

  const ip = parseFirstIpv4(cmd.stdout ?? "");
  if (ip) {
    return { ip, error: null };
  }

  const stderr = String(cmd.stderr ?? "").trim();
  return {
    ip: null,
    error: stderr || "Tailscale is not connected.",
  };
}
