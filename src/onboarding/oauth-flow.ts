import type { OAuthPrompter } from "./openai-codex-oauth.js";

type OAuthPrompt = { message: string; placeholder?: string };

const validateRequiredInput = (value: string) => (value.trim().length > 0 ? undefined : "Required");

export function createVpsAwareOAuthHandlers(params: {
  isRemote: boolean;
  prompter: OAuthPrompter;
  spin: { update: (message: string) => void; stop: (message?: string) => void };
  openUrl: (url: string) => Promise<unknown>;
  localBrowserMessage: string;
  manualPromptMessage?: string;
}): {
  onAuth: (event: { url: string }) => Promise<void>;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
} {
  const manualPromptMessage = params.manualPromptMessage ?? "Paste the redirect URL";
  let manualCodePromise: Promise<string> | undefined;

  return {
    onAuth: async ({ url }) => {
      process.stdout.write(`OpenAI Codex login URL: ${url}\n`);
      if (params.isRemote) {
        params.spin.stop("OAuth URL ready");
        await params.prompter.note(`Open this URL in your LOCAL browser:\n\n${url}`, "OpenAI Codex OAuth");
        manualCodePromise = params.prompter
          .askRequired(manualPromptMessage)
          .then((value) => String(value));
        return;
      }

      params.spin.update(params.localBrowserMessage);
      await params.openUrl(url);
      await params.prompter.note(`Open: ${url}`, "OpenAI Codex OAuth");
    },
    onPrompt: async (prompt) => {
      if (manualCodePromise) {
        return manualCodePromise;
      }
      const code = await params.prompter.askRequired(prompt.message, prompt.placeholder);
      const err = validateRequiredInput(String(code));
      if (err) {
        throw new Error(err);
      }
      return String(code);
    }
  };
}
