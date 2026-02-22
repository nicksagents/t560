import { approvePairingCode, listPendingPairings } from "../channels/pairing.js";

function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  t560 pairing list [channel]",
      "  t560 pairing approve <channel> <code>",
      "",
      "Examples:",
      "  t560 pairing list telegram",
      "  t560 pairing approve telegram ABCD1234",
    ].join("\n") + "\n"
  );
}

export async function runPairingCli(argv: string[]): Promise<void> {
  const action = String(argv[3] ?? "").trim().toLowerCase();
  if (!action || action === "help" || action === "--help" || action === "-h") {
    printUsage();
    return;
  }

  if (action === "list") {
    const channel = String(argv[4] ?? "").trim();
    const pending = await listPendingPairings({ channel: channel || undefined });
    if (pending.length === 0) {
      process.stdout.write(
        channel ? `No pending pairing requests for ${channel}.\n` : "No pending pairing requests.\n"
      );
      return;
    }
    process.stdout.write("Pending pairing requests:\n");
    for (const entry of pending) {
      process.stdout.write(
        `- ${entry.channel} code=${entry.code} user=${entry.userId} chat=${entry.chatId} lastSeen=${new Date(entry.lastSeenAt).toISOString()}\n`
      );
    }
    return;
  }

  if (action === "approve") {
    const channel = String(argv[4] ?? "").trim().toLowerCase();
    const code = String(argv[5] ?? "").trim().toUpperCase();
    if (!channel || !code) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    const approved = await approvePairingCode({ channel, code });
    if (!approved) {
      process.stderr.write(
        `No pending ${channel} pairing request found for code ${code}.\n` +
          `Run: t560 pairing list ${channel}\n`
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `Approved ${channel} pairing code ${approved.code} for user=${approved.userId} chat=${approved.chatId}\n`
    );
    return;
  }

  printUsage();
  process.exitCode = 1;
}
