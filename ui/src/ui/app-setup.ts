import type { T560App } from "./app.js";
import type { SettingsNoticeKind } from "./app-config.js";

export type SetupProviderCatalogEntry = {
  id: string;
  label: string;
  description: string;
  authModes: string[];
  models: string[];
  defaultModel: string;
  planningModel: string;
  codingModel: string;
};

export type SetupProviderState = {
  enabled: boolean;
  provider: string;
  authMode: string;
  models: string[];
  baseUrl: string;
  api: string;
  hasCredential: boolean;
};

export type SetupRoutingSlot = {
  provider: string;
  model: string;
};

export type SetupTelegramState = {
  dmPolicy: string;
  allowFrom: string[];
  allowedChatIds: number[];
  hasBotToken: boolean;
};

export type SetupVaultEntry = {
  service: string;
  identifierMasked: string;
  authMode: string;
  hasMfaCode: boolean;
  createdAt: number;
  updatedAt: number;
};

type SetupResponse = {
  catalog?: unknown;
  providers?: unknown;
  routing?: unknown;
  telegram?: unknown;
};

type VaultResponse = {
  entries?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return fallback;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload: unknown = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const errObj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
    const message = typeof errObj?.message === "string" ? errObj.message : `Request failed: ${response.status}`;
    throw new Error(message);
  }

  if (payload && typeof payload === "object") {
    return payload as T;
  }
  return {} as T;
}

function normalizeCatalog(raw: unknown): SetupProviderCatalogEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item): SetupProviderCatalogEntry | null => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const obj = item as Record<string, unknown>;
      const id = typeof obj.id === "string" ? obj.id.trim() : "";
      if (!id) {
        return null;
      }
      return {
        id,
        label: typeof obj.label === "string" ? obj.label : id,
        description: typeof obj.description === "string" ? obj.description : "",
        authModes: Array.isArray(obj.authModes)
          ? obj.authModes.map((entry) => String(entry).trim()).filter(Boolean)
          : ["api_key"],
        models: Array.isArray(obj.models)
          ? obj.models.map((entry) => String(entry).trim()).filter(Boolean)
          : [],
        defaultModel: typeof obj.defaultModel === "string" ? obj.defaultModel : "",
        planningModel: typeof obj.planningModel === "string" ? obj.planningModel : "",
        codingModel: typeof obj.codingModel === "string" ? obj.codingModel : "",
      };
    })
    .filter((entry): entry is SetupProviderCatalogEntry => entry !== null);
}

function normalizeProviders(raw: unknown): Record<string, SetupProviderState> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, SetupProviderState> = {};
  for (const [providerId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const obj = value as Record<string, unknown>;
    out[providerId] = {
      enabled: obj.enabled !== false,
      provider: typeof obj.provider === "string" ? obj.provider : providerId,
      authMode: typeof obj.authMode === "string" ? obj.authMode : "api_key",
      models: Array.isArray(obj.models)
        ? obj.models.map((entry) => String(entry).trim()).filter(Boolean)
        : [],
      baseUrl: typeof obj.baseUrl === "string" ? obj.baseUrl : "",
      api: typeof obj.api === "string" ? obj.api : "",
      hasCredential: obj.hasCredential === true,
    };
  }
  return out;
}

function normalizeRoutingSlot(raw: unknown): SetupRoutingSlot | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const provider = typeof obj.provider === "string" ? obj.provider.trim() : "";
  const model = typeof obj.model === "string" ? obj.model.trim() : "";
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}

function normalizeTelegram(raw: unknown): SetupTelegramState {
  const obj = asRecord(raw);
  const allowFrom = Array.isArray(obj.allowFrom)
    ? obj.allowFrom.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  const allowedChatIds = Array.isArray(obj.allowedChatIds)
    ? obj.allowedChatIds
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry))
    : [];
  return {
    dmPolicy: typeof obj.dmPolicy === "string" ? obj.dmPolicy : "pairing",
    allowFrom,
    allowedChatIds,
    hasBotToken: obj.hasBotToken === true,
  };
}

function normalizeVaultEntries(raw: unknown): SetupVaultEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item): SetupVaultEntry | null => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const obj = item as Record<string, unknown>;
      const service = typeof obj.service === "string" ? obj.service.trim() : "";
      if (!service) {
        return null;
      }
      return {
        service,
        identifierMasked:
          typeof obj.identifierMasked === "string" ? obj.identifierMasked : "(hidden)",
        authMode: typeof obj.authMode === "string" ? obj.authMode : "password",
        hasMfaCode: obj.hasMfaCode === true,
        createdAt: Number.isFinite(Number(obj.createdAt)) ? Number(obj.createdAt) : 0,
        updatedAt: Number.isFinite(Number(obj.updatedAt)) ? Number(obj.updatedAt) : 0,
      };
    })
    .filter((entry): entry is SetupVaultEntry => entry !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function setSetupNotice(host: T560App, kind: SettingsNoticeKind, message: string): void {
  host.setupNotice = { kind, message };
}

function clearSetupNotice(host: T560App): void {
  host.setupNotice = null;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toCsv(values: string[]): string {
  return values.join(", ");
}

function normalizeProviderIdDraft(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveProviderModelForSlot(
  host: T560App,
  providerId: string,
  slot: "default" | "planning" | "coding"
): string {
  const provider = host.setupProviders[providerId];
  const catalog = host.setupCatalog.find((entry) => entry.id === providerId);
  const configured = provider?.models ?? [];
  const catalogModels = catalog?.models ?? [];
  const slotDefault =
    slot === "planning"
      ? catalog?.planningModel
      : slot === "coding"
        ? catalog?.codingModel
        : catalog?.defaultModel;

  const currentSlotModel =
    slot === "planning"
      ? host.setupRoutingPlanningProvider === providerId
        ? host.setupRoutingPlanningModel.trim()
        : ""
      : slot === "coding"
        ? host.setupRoutingCodingProvider === providerId
          ? host.setupRoutingCodingModel.trim()
          : ""
        : host.setupRoutingDefaultProvider === providerId
          ? host.setupRoutingDefaultModel.trim()
          : "";

  const candidates = [
    currentSlotModel,
    slotDefault ?? "",
    configured[0] ?? "",
    catalogModels[0] ?? "",
    host.setupRoutingDefaultProvider === providerId ? host.setupRoutingDefaultModel.trim() : "",
    host.setupRoutingPlanningProvider === providerId ? host.setupRoutingPlanningModel.trim() : "",
    host.setupRoutingCodingProvider === providerId ? host.setupRoutingCodingModel.trim() : "",
  ];
  return candidates.find((entry) => entry.trim().length > 0) ?? "";
}

function ensureRoutingDraftComplete(host: T560App): void {
  const preferred =
    host.setupRoutingDefaultProvider.trim() ||
    host.setupRoutingPlanningProvider.trim() ||
    host.setupRoutingCodingProvider.trim() ||
    host.setupSelectedProvider.trim() ||
    Object.keys(host.setupProviders)[0] ||
    host.setupCatalog[0]?.id ||
    "";
  if (!preferred) {
    return;
  }
  if (!host.setupRoutingDefaultProvider.trim()) {
    host.setupRoutingDefaultProvider = preferred;
  }
  if (!host.setupRoutingPlanningProvider.trim()) {
    host.setupRoutingPlanningProvider = preferred;
  }
  if (!host.setupRoutingCodingProvider.trim()) {
    host.setupRoutingCodingProvider = preferred;
  }
  if (!host.setupRoutingDefaultModel.trim()) {
    host.setupRoutingDefaultModel = resolveProviderModelForSlot(host, host.setupRoutingDefaultProvider.trim(), "default");
  }
  if (!host.setupRoutingPlanningModel.trim()) {
    host.setupRoutingPlanningModel = resolveProviderModelForSlot(host, host.setupRoutingPlanningProvider.trim(), "planning");
  }
  if (!host.setupRoutingCodingModel.trim()) {
    host.setupRoutingCodingModel = resolveProviderModelForSlot(host, host.setupRoutingCodingProvider.trim(), "coding");
  }
}

function setRoutingDraftSlot(
  host: T560App,
  slot: "default" | "planning" | "coding",
  provider: string,
  model: string
): void {
  if (slot === "default") {
    host.setupRoutingDefaultProvider = provider;
    host.setupRoutingDefaultModel = model;
    return;
  }
  if (slot === "planning") {
    host.setupRoutingPlanningProvider = provider;
    host.setupRoutingPlanningModel = model;
    return;
  }
  host.setupRoutingCodingProvider = provider;
  host.setupRoutingCodingModel = model;
}

function applyProviderDraftFromSelection(host: T560App): void {
  const selected = host.setupSelectedProvider.trim();
  if (!selected) {
    return;
  }
  const configured = host.setupProviders[selected];
  const catalog = host.setupCatalog.find((entry) => entry.id === selected);
  host.setupProviderAuthMode = configured?.authMode ?? catalog?.authModes[0] ?? "api_key";
  host.setupProviderModels = toCsv(configured?.models ?? catalog?.models ?? []);
  host.setupProviderBaseUrl = configured?.baseUrl ?? "";
  host.setupProviderApi = configured?.api ?? "";
  host.setupProviderEnabled = configured?.enabled ?? true;
  host.setupProviderCredential = "";
}

function applySetupPayload(host: T560App, payload: SetupResponse): void {
  const record = asRecord(payload);
  const catalog = normalizeCatalog(record.catalog);
  const providers = normalizeProviders(record.providers);
  const routingRecord = asRecord(record.routing);
  const routingDefault = normalizeRoutingSlot(routingRecord.default);
  const routingPlanning = normalizeRoutingSlot(routingRecord.planning);
  const routingCoding = normalizeRoutingSlot(routingRecord.coding);
  const telegram = normalizeTelegram(record.telegram);

  host.setupCatalog = catalog;
  host.setupProviders = providers;

  // Only keep setupSelectedProvider open if the user was already editing a real provider.
  // Never auto-open the form on page load (when setupSelectedProvider is "").
  if (host.setupSelectedProvider && host.setupSelectedProvider !== "__new__") {
    if (providers[host.setupSelectedProvider] || catalog.some((entry) => entry.id === host.setupSelectedProvider)) {
      applyProviderDraftFromSelection(host); // refresh form fields for the provider being edited
    } else {
      host.setupSelectedProvider = ""; // provider was deleted — close the form
    }
  }

  host.setupRoutingDefaultProvider = routingDefault?.provider ?? "";
  host.setupRoutingDefaultModel = routingDefault?.model ?? "";
  host.setupRoutingPlanningProvider = routingPlanning?.provider ?? "";
  host.setupRoutingPlanningModel = routingPlanning?.model ?? "";
  host.setupRoutingCodingProvider = routingCoding?.provider ?? "";
  host.setupRoutingCodingModel = routingCoding?.model ?? "";
  ensureRoutingDraftComplete(host);

  host.setupTelegramDmPolicy = telegram.dmPolicy;
  host.setupTelegramAllowFrom = telegram.allowFrom.join(", ");
  host.setupTelegramAllowedChatIds = telegram.allowedChatIds.join(", ");
  host.setupTelegramHasToken = telegram.hasBotToken;

  if (!host.setupNewProviderTemplate && catalog.length > 0) {
    host.setupNewProviderTemplate = catalog[0]?.id ?? "";
  }
}

async function loadVaultEntries(host: T560App): Promise<void> {
  const payload = await requestJson<VaultResponse>("/api/vault");
  const record = asRecord(payload);
  host.setupVaultEntries = normalizeVaultEntries(record.entries);
}

export async function loadSetupState(host: T560App, force = false): Promise<void> {
  if (host.setupLoading) {
    return;
  }
  if (host.setupLoaded && !force) {
    return;
  }
  host.setupLoading = true;
  if (force) {
    clearSetupNotice(host);
  }
  try {
    const [setup, status] = await Promise.all([
      requestJson<SetupResponse>("/api/setup"),
      requestJson<Record<string, unknown>>("/api/status"),
    ]);
    applySetupPayload(host, setup);
    host.serverStatus = asRecord(status);
    await loadVaultEntries(host);
    host.setupLoaded = true;
  } catch (error: unknown) {
    setSetupNotice(host, "error", toErrorMessage(error, "Failed to load setup wizard data."));
  } finally {
    host.setupLoading = false;
  }
}

export function selectSetupProvider(host: T560App, providerId: string): void {
  const selected = normalizeProviderIdDraft(providerId);
  if (!selected) {
    return;
  }
  host.setupSelectedProvider = selected;
  applyProviderDraftFromSelection(host);
}

export function startSetupProviderDraft(host: T560App): void {
  const providerId = normalizeProviderIdDraft(
    host.setupNewProviderTemplate || host.setupNewProviderId || host.setupSelectedProvider
  );
  if (!providerId) {
    setSetupNotice(host, "error", "Pick a provider first.");
    return;
  }
  const template = host.setupCatalog.find((entry) => entry.id === host.setupNewProviderTemplate.trim());
  const existing = host.setupProviders[providerId];

  host.setupSelectedProvider = providerId;
  host.setupNewProviderId = providerId;

  if (existing) {
    applyProviderDraftFromSelection(host);
    setSetupNotice(host, "info", `Editing existing provider ${providerId}.`);
    return;
  }

  host.setupProviderAuthMode = template?.authModes[0] ?? "api_key";
  host.setupProviderModels = toCsv(template?.models ?? []);
  host.setupProviderBaseUrl = "";
  host.setupProviderApi = "";
  host.setupProviderCredential = "";
  host.setupProviderEnabled = true;
  if (!host.setupProviderModels.trim()) {
    const model =
      template?.defaultModel ||
      template?.planningModel ||
      template?.codingModel ||
      template?.models[0] ||
      "";
    if (model) {
      host.setupProviderModels = model;
    }
  }
  setSetupNotice(host, "info", `Now configure ${providerId}: choose model, auth mode, add credential, then save.`);
}

export async function saveSetupProvider(host: T560App): Promise<void> {
  if (host.setupSaving) {
    return;
  }
  const providerId = host.setupSelectedProvider.trim();
  if (!providerId) {
    setSetupNotice(host, "error", "Choose a provider first.");
    return;
  }

  host.setupSaving = true;
  clearSetupNotice(host);
  try {
    const payload = await requestJson<{ setup?: unknown }>("/api/setup/provider", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId,
        authMode: host.setupProviderAuthMode,
        models: splitCsv(host.setupProviderModels),
        baseUrl: host.setupProviderBaseUrl,
        api: host.setupProviderApi,
        enabled: host.setupProviderEnabled,
        credential: host.setupProviderCredential,
      }),
    });

    const payloadRecord = asRecord(payload);
    const setupPayload = asRecord(payloadRecord.setup);
    applySetupPayload(host, setupPayload);
    host.setupProviderCredential = "";
    host.setupSelectedProvider = "";
    setSetupNotice(host, "success", `Saved provider settings for ${providerId}.`);
  } catch (error: unknown) {
    setSetupNotice(host, "error", toErrorMessage(error, "Failed to save provider settings."));
  } finally {
    host.setupSaving = false;
  }
}

export async function deleteSetupProvider(host: T560App, providerId: string): Promise<void> {
  if (host.setupSaving) {
    return;
  }
  const target = normalizeProviderIdDraft(providerId);
  if (!target) {
    return;
  }

  host.setupSaving = true;
  clearSetupNotice(host);
  try {
    const payload = await requestJson<{ setup?: unknown }>("/api/setup/provider", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: target }),
    });

    const payloadRecord = asRecord(payload);
    const setupPayload = asRecord(payloadRecord.setup);
    applySetupPayload(host, setupPayload);
    host.setupSelectedProvider = "";
    setSetupNotice(host, "success", `Removed provider ${target}.`);
  } catch (error: unknown) {
    setSetupNotice(host, "error", toErrorMessage(error, "Failed to remove provider."));
  } finally {
    host.setupSaving = false;
  }
}

export async function saveSetupRouting(host: T560App): Promise<void> {
  if (host.setupSaving) {
    return;
  }
  ensureRoutingDraftComplete(host);
  const routes = [
    [host.setupRoutingDefaultProvider, host.setupRoutingDefaultModel, "default"],
    [host.setupRoutingPlanningProvider, host.setupRoutingPlanningModel, "planning"],
    [host.setupRoutingCodingProvider, host.setupRoutingCodingModel, "coding"],
  ] as const;

  for (const [provider, model, slot] of routes) {
    if (!provider.trim() || !model.trim()) {
      setSetupNotice(host, "error", `Routing for ${slot} requires provider and model.`);
      return;
    }
  }

  host.setupSaving = true;
  clearSetupNotice(host);
  try {
    const payload = await requestJson<{ setup?: unknown }>("/api/setup/routing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        default: {
          provider: host.setupRoutingDefaultProvider.trim(),
          model: host.setupRoutingDefaultModel.trim(),
        },
        planning: {
          provider: host.setupRoutingPlanningProvider.trim(),
          model: host.setupRoutingPlanningModel.trim(),
        },
        coding: {
          provider: host.setupRoutingCodingProvider.trim(),
          model: host.setupRoutingCodingModel.trim(),
        },
      }),
    });

    const payloadRecord = asRecord(payload);
    const setupPayload = asRecord(payloadRecord.setup);
    applySetupPayload(host, setupPayload);
    setSetupNotice(host, "success", "Saved model routing.");
  } catch (error: unknown) {
    setSetupNotice(host, "error", toErrorMessage(error, "Failed to save model routing."));
  } finally {
    host.setupSaving = false;
  }
}

export async function assignSetupRouteFromProvider(
  host: T560App,
  slot: "default" | "planning" | "coding",
  providerId: string
): Promise<void> {
  const provider = normalizeProviderIdDraft(providerId);
  if (!provider) {
    return;
  }

  const model = resolveProviderModelForSlot(host, provider, slot);
  if (!model) {
    setSetupNotice(host, "error", `No model found for provider ${provider}. Add models first.`);
    return;
  }

  setRoutingDraftSlot(host, slot, provider, model);
  ensureRoutingDraftComplete(host);
  await saveSetupRouting(host);
}

export async function assignSetupRouteModel(
  host: T560App,
  slot: "default" | "planning" | "coding",
  providerId: string,
  modelId: string
): Promise<void> {
  const provider = normalizeProviderIdDraft(providerId);
  const model = modelId.trim();
  if (!provider || !model) {
    return;
  }
  if (host.setupSaving) {
    return;
  }

  setRoutingDraftSlot(host, slot, provider, model);
  ensureRoutingDraftComplete(host);
  await saveSetupRouting(host);
}

export async function saveSetupTelegram(host: T560App): Promise<void> {
  if (host.setupSaving) {
    return;
  }
  host.setupSaving = true;
  clearSetupNotice(host);
  try {
    const payload = await requestJson<{ setup?: unknown }>("/api/setup/telegram", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        dmPolicy: host.setupTelegramDmPolicy,
        allowFrom: splitCsv(host.setupTelegramAllowFrom),
        allowedChatIds: splitCsv(host.setupTelegramAllowedChatIds)
          .map((entry) => Number(entry))
          .filter((entry) => Number.isInteger(entry)),
        ...(host.setupTelegramToken.trim() ? { botToken: host.setupTelegramToken.trim() } : {}),
      }),
    });

    const payloadRecord = asRecord(payload);
    const setupPayload = asRecord(payloadRecord.setup);
    applySetupPayload(host, setupPayload);
    host.setupTelegramToken = "";
    setSetupNotice(host, "success", "Saved Telegram settings.");
  } catch (error: unknown) {
    setSetupNotice(host, "error", toErrorMessage(error, "Failed to save Telegram settings."));
  } finally {
    host.setupSaving = false;
  }
}

export async function saveVaultCredential(host: T560App): Promise<void> {
  if (host.setupSaving) {
    return;
  }
  const service = host.setupVaultService.trim();
  const identifier = host.setupVaultIdentifier.trim();
  if (!service || !identifier) {
    setSetupNotice(host, "error", "Vault service and identifier are required.");
    return;
  }
  if (host.setupVaultAuthMode === "password" && !host.setupVaultSecret) {
    setSetupNotice(host, "error", "Vault password mode requires a secret.");
    return;
  }

  host.setupSaving = true;
  clearSetupNotice(host);
  try {
    const payload = await requestJson<VaultResponse>("/api/vault", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service,
        identifier,
        authMode: host.setupVaultAuthMode,
        secret: host.setupVaultSecret,
        mfaCode: host.setupVaultMfaCode,
      }),
    });

    const record = asRecord(payload);
    host.setupVaultEntries = normalizeVaultEntries(record.entries);
    host.setupVaultSecret = "";
    host.setupVaultMfaCode = "";
    setSetupNotice(host, "success", `Saved vault credentials for ${service}.`);
  } catch (error: unknown) {
    setSetupNotice(host, "error", toErrorMessage(error, "Failed to save vault credentials."));
  } finally {
    host.setupSaving = false;
  }
}

export async function deleteVaultCredential(host: T560App, service: string): Promise<void> {
  const target = service.trim();
  if (!target || host.setupSaving) {
    return;
  }
  host.setupSaving = true;
  clearSetupNotice(host);
  try {
    const payload = await requestJson<VaultResponse>("/api/vault", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: target }),
    });
    const record = asRecord(payload);
    host.setupVaultEntries = normalizeVaultEntries(record.entries);
    setSetupNotice(host, "success", `Removed vault credentials for ${target}.`);
  } catch (error: unknown) {
    setSetupNotice(host, "error", toErrorMessage(error, "Failed to remove vault credential."));
  } finally {
    host.setupSaving = false;
  }
}

export async function startCodexOAuth(host: T560App): Promise<void> {
  if (host.setupOAuthStatus === "starting" || host.setupOAuthStatus === "awaiting_signin") return;
  host.setupOAuthStatus = "starting";
  host.setupOAuthError = "";
  host.setupOAuthUrl = "";
  host.setupOAuthJobId = "";
  host.setupOAuthRedirectDraft = "";
  try {
    const res = await requestJson<{ ok: boolean; jobId?: string; url?: string; error?: string }>(
      "/api/setup/oauth/codex/start",
      { method: "POST" }
    );
    if (!res.ok || !res.jobId || !res.url) {
      host.setupOAuthStatus = "error";
      host.setupOAuthError = res.error ?? "Failed to start OAuth flow.";
      return;
    }
    host.setupOAuthJobId = res.jobId;
    host.setupOAuthUrl = res.url;
    host.setupOAuthStatus = "awaiting_signin";
    pollCodexOAuthStatus(host);
  } catch (err: unknown) {
    host.setupOAuthStatus = "error";
    host.setupOAuthError = toErrorMessage(err, "Failed to start OAuth flow.");
  }
}

export async function submitCodexOAuthCode(host: T560App): Promise<void> {
  const redirectUrl = host.setupOAuthRedirectDraft.trim();
  if (!redirectUrl || !host.setupOAuthJobId) return;
  try {
    await requestJson("/api/setup/oauth/codex/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: host.setupOAuthJobId, redirectUrl }),
    });
  } catch {
    // Ignore — polling will catch the error
  }
}

async function pollCodexOAuthStatus(host: T560App): Promise<void> {
  const jobId = host.setupOAuthJobId;
  if (!jobId) return;
  for (let i = 0; i < 240; i++) {
    await new Promise<void>((r) => setTimeout(r, 2_500));
    if (host.setupOAuthJobId !== jobId) return; // user restarted
    try {
      const res = await requestJson<{ ok: boolean; status?: string; error?: string }>(
        `/api/setup/oauth/codex/status?jobId=${encodeURIComponent(jobId)}`
      );
      if (res.status === "done") {
        host.setupOAuthStatus = "done";
        host.setupOAuthJobId = "";
        host.setupOAuthUrl = "";
        // Reload setup state so the new provider appears
        await loadSetupState(host, true);
        // Close the provider form
        host.setupSelectedProvider = "";
        return;
      }
      if (res.status === "error") {
        host.setupOAuthStatus = "error";
        host.setupOAuthError = res.error ?? "OAuth sign-in failed.";
        return;
      }
    } catch {
      // Transient network error — keep polling
    }
  }
  host.setupOAuthStatus = "error";
  host.setupOAuthError = "OAuth sign-in timed out. Please try again.";
}

export async function refreshVault(host: T560App): Promise<void> {
  if (host.setupSaving) {
    return;
  }
  host.setupSaving = true;
  clearSetupNotice(host);
  try {
    await loadVaultEntries(host);
    setSetupNotice(host, "info", "Vault list refreshed.");
  } catch (error: unknown) {
    setSetupNotice(host, "error", toErrorMessage(error, "Failed to refresh vault list."));
  } finally {
    host.setupSaving = false;
  }
}
