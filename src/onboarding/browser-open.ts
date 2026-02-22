import { spawn } from "node:child_process";

function runDetached(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

export async function openUrl(url: string): Promise<boolean> {
  if (process.platform === "darwin") {
    return runDetached("open", [url]);
  }
  if (process.platform === "win32") {
    return runDetached("cmd", ["/c", "start", "", url]);
  }
  if (process.platform === "linux") {
    return runDetached("xdg-open", [url]);
  }
  return false;
}

