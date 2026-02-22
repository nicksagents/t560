import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { loginOpenAICodex } from "@mariozechner/pi-ai";

export type OAuthPrompter = {
  note: (message: string, title?: string) => Promise<void>;
  askRequired: (message: string, initial?: string) => Promise<string>;
  progress: (label: string) => { update: (message: string) => void; stop: (message?: string) => void };
};
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";

export async function loginOpenAICodexOAuth(params: {
  prompter: OAuthPrompter;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  localBrowserMessage?: string;
}): Promise<OAuthCredentials | null> {
  const { prompter, isRemote, openUrl, localBrowserMessage } = params;

  await prompter.note(
    isRemote
      ? [
          "You are running in a remote/VPS environment.",
          "A URL will be shown for you to open in your LOCAL browser.",
          "After signing in, paste the redirect URL back here."
        ].join("\n")
      : [
          "Browser will open for OpenAI authentication.",
          "If callback does not auto-complete, paste the redirect URL.",
          "OpenAI OAuth uses localhost:1455 for the callback."
        ].join("\n"),
    "OpenAI Codex OAuth"
  );

  const spin = prompter.progress("Starting OAuth flow...");
  try {
    const { onAuth, onPrompt } = createVpsAwareOAuthHandlers({
      isRemote,
      prompter,
      spin,
      openUrl,
      localBrowserMessage: localBrowserMessage ?? "Complete sign-in in browser..."
    });

    const creds = await loginOpenAICodex({
      onAuth,
      onPrompt,
      onProgress: (msg: string) => spin.update(msg)
    });
    spin.stop("OpenAI OAuth complete");
    return creds ?? null;
  } catch (error) {
    spin.stop("OpenAI OAuth failed");
    await prompter.note(String(error), "OAuth error");
    await prompter.note("Trouble with OAuth? Re-run onboarding and try again.", "OAuth help");
    throw error;
  }
}
