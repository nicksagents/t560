export function loadOpenAICodexOAuth(env?: NodeJS.ProcessEnv): {
  exists: boolean;
  creds: unknown;
  error?: unknown;
};

export function saveOpenAICodexOAuth(creds: unknown, env?: NodeJS.ProcessEnv): string;
export function deleteOpenAICodexOAuth(env?: NodeJS.ProcessEnv): void;

export function ensureFreshOpenAICodexOAuth(env?: NodeJS.ProcessEnv): Promise<{
  creds: unknown;
  updated: boolean;
}>;

export function loginOpenAICodexOAuth(options?: {
  prompter?: {
    note?: (message: string, title?: string) => void | Promise<void>;
    text?: (input: {
      message: string;
      placeholder?: string;
      validate?: (value: string) => string | undefined;
    }) => Promise<string>;
  };
  env?: NodeJS.ProcessEnv;
}): Promise<{
  creds: unknown;
  path: string;
}>;
