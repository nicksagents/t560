export type ProviderId = "openai-codex" | "anthropic" | "deepseek";

export type CredentialKind = "oauth-token" | "setup-token" | "api-key";

export type OAuthCredentialData = {
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
};

export type ProviderCredential = {
  profileId: string;
  provider: ProviderId;
  kind: CredentialKind;
  token: string;
  addedAt: string;
  expiresAt?: number;
  oauth?: OAuthCredentialData;
  metadata?: Record<string, unknown>;
};

export type ModelProfile = {
  defaultModel: string;
  planningModel: string;
  codingModel: string;
};

export type TelegramAccessMode = "pair" | "allow-anyone" | "disabled";

export type TelegramConfig = {
  enabled: boolean;
  botToken: string;
  accessMode: TelegramAccessMode;
  allowedChatIds: string[];
};

export type AppConfig = {
  version: number;
  onboardingCompleted: boolean;
  providers: ProviderCredential[];
  models: ModelProfile | null;
  telegram: TelegramConfig;
};
