import path from "node:path";
import os from "node:os";

const PATH_REGEX = /(?:~\/|\/)[^\s"'<>|;]+/g;

function splitCommand(command: string): string {
  const segments = command
    .split(/&&|\|\||;|\|/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : command.trim();
}

function commandPreview(command: string, maxLength = 72): string {
  const compact = command.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3)}...`;
}

function extractPaths(command: string): string[] {
  return command.match(PATH_REGEX) ?? [];
}

function normalizePath(raw: string): string {
  if (raw.startsWith("~/")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  if (raw === "~") {
    return os.homedir();
  }
  return raw;
}

function locationPhrase(paths: string[]): string {
  const normalized = paths.map((p) => normalizePath(p));
  const lower = normalized.map((p) => p.toLowerCase());

  if (lower.some((p) => p.includes("/desktop/") || p.endsWith("/desktop"))) {
    return " in the Desktop";
  }
  if (lower.some((p) => p.includes("/downloads/") || p.endsWith("/downloads"))) {
    return " in Downloads";
  }
  if (lower.some((p) => p.includes("/documents/") || p.endsWith("/documents"))) {
    return " in Documents";
  }
  if (lower.some((p) => p.startsWith(os.homedir().toLowerCase() + "/"))) {
    return " in the home directory";
  }

  const cwd = process.cwd();
  if (normalized.some((p) => p.startsWith(cwd))) {
    return " in the project directory";
  }

  return "";
}

function describeExecCommand(command: string): string {
  const segment = splitCommand(command);
  const lower = segment.toLowerCase();
  const location = locationPhrase(extractPaths(command));
  const preview = commandPreview(segment);

  if (/^ls\b/.test(lower)) return `Listing files${location}.`;
  if (/^pwd\b/.test(lower)) return "Checking current directory.";
  if (/^rm\b/.test(lower)) return `Deleting a path${location}.`;
  if (/^mkdir\b/.test(lower)) return `Creating a folder${location}.`;
  if (/^touch\b/.test(lower)) return `Creating a file${location}.`;
  if (/^(echo|printf)\b/.test(lower) && />/.test(segment)) return `Writing file content${location}.`;
  if (/^cat\b/.test(lower)) return `Reading a file${location}.`;
  if (/^stat\b/.test(lower)) return `Inspecting file metadata${location}.`;
  if (/^test\b/.test(lower)) {
    if (/!\s*-f|!\s*-d/.test(lower)) return `Verifying removal${location}.`;
    return `Checking file status${location}.`;
  }
  if (/^(rg|grep)\b/.test(lower)) return `Searching text${location}.`;
  if (/^find\b/.test(lower)) return `Scanning directories${location}.`;
  if (/^cp\b/.test(lower)) return `Copying files${location}.`;
  if (/^mv\b/.test(lower)) return `Moving files${location}.`;
  if (/^(npm|pnpm|yarn)\b/.test(lower)) {
    if (lower.includes(" install")) return "Installing dependencies.";
    return "Running a package manager task.";
  }
  if (/^git\b/.test(lower)) return "Running a git command.";
  if (/^(curl|wget)\b/.test(lower)) return "Downloading data.";

  if (preview) {
    return `Running \`${preview}\`${location}.`;
  }
  return `Running a shell command${location}.`;
}

export function progressMessageForToolStart(params: {
  toolName: string;
  args: Record<string, unknown>;
}): string | null {
  const tool = params.toolName.toLowerCase();
  if (tool === "browser") {
    const action = String(params.args.action ?? "open")
      .trim()
      .toLowerCase();
    const url = typeof params.args.url === "string" ? params.args.url.trim() : "";
    const query = typeof params.args.query === "string" ? params.args.query.trim() : "";
    if (action === "launch") {
      return `Launching the external browser${url ? ` at ${url}` : ""}.`;
    }
    if (action === "open" || action === "navigate") {
      return `Opening browser tab${url ? ` at ${url}` : ""}.`;
    }
    if (action === "search") {
      return `Searching in browser${query ? ` for "${query}"` : ""}.`;
    }
    if (action === "snapshot") {
      return "Capturing current page snapshot.";
    }
    if (action === "products") {
      return "Extracting product candidates from the current page.";
    }
    if (action === "click" || action === "fill" || action === "submit" || action === "act") {
      return `Performing browser action: ${action}.`;
    }
    return `Running browser action: ${action || "open"}.`;
  }
  if (tool === "web_search") {
    const query = typeof params.args.query === "string" ? params.args.query.trim() : "";
    return `Searching the web${query ? ` for "${query}"` : ""}.`;
  }
  if (tool === "web_fetch") {
    const url = typeof params.args.url === "string" ? params.args.url.trim() : "";
    return `Fetching web page${url ? ` ${url}` : ""}.`;
  }
  if (tool === "read") {
    return "Reading file contents.";
  }
  if (tool === "write") {
    return "Writing file changes.";
  }
  if (tool === "edit") {
    return "Applying targeted file edits.";
  }
  if (tool === "ls") {
    return "Listing directory contents.";
  }
  if (tool === "find") {
    return "Searching for files.";
  }
  if (tool === "exists") {
    return "Checking whether a path exists.";
  }
  if (tool === "exec") {
    const command = typeof params.args.command === "string" ? params.args.command.trim() : "";
    return command ? describeExecCommand(command) : "Running a shell command.";
  }
  if (tool === "process") {
    const actionRaw = typeof params.args.action === "string" ? params.args.action.toLowerCase() : "";
    const action =
      actionRaw === "wait"
        ? "poll"
        : actionRaw === "tail"
          ? "log"
          : actionRaw === "stop"
            ? "kill"
            : actionRaw;
    if (action === "status") {
      return "Checking background task status.";
    }
    if (action === "poll" || action === "log") {
      return "Checking background task output.";
    }
    if (action === "kill") {
      return "Stopping a background task.";
    }
    return "Managing a background task.";
  }
  return null;
}
