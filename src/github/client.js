import { Octokit } from "@octokit/rest";

export function createGitHubClient(token) {
  const t = String(token ?? "").trim();
  if (!t) {
    throw new Error("Missing GITHUB_TOKEN.");
  }
  return new Octokit({ auth: t });
}

