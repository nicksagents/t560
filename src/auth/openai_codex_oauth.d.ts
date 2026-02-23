export function loadOpenAICodexOAuth(env?: NodeJS.ProcessEnv): { exists: boolean; creds: unknown | null; error?: unknown };
export function saveOpenAICodexOAuth(creds: unknown, env?: NodeJS.ProcessEnv): string;
export function deleteOpenAICodexOAuth(env?: NodeJS.ProcessEnv): void;
export function ensureFreshOpenAICodexOAuth(env?: NodeJS.ProcessEnv): Promise<{ creds: unknown; updated: boolean }>;
export function loginOpenAICodexOAuth(opts?: { prompter?: unknown; env?: NodeJS.ProcessEnv }): Promise<{ creds: unknown; path: string }>;
