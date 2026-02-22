export function printCompletionHelp(): void {
  process.stdout.write(
    [
      "Shell completion is not available in this recovered build.",
      "Use `t560 help` for command usage.",
    ].join("\n") + "\n",
  );
}
