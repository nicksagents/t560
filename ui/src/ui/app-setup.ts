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
  websiteUrl: string;
  identifier: string;
  identifierMasked: string;
  authMode: string;
  mfaStrategy: string;
  mfaSourceService: string;
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
  created?: unknown;
  identifierReused?: unknown;
  service?: unknown;
};

type SetupProviderModelsResponse = {
  ok?: unknown;
  models?: unknown;
  normalizedBaseUrl?: unknown;
  error?: unknown;
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
        websiteUrl: typeof obj.websiteUrl === "string" ? obj.websiteUrl : "",
        identifier:
          typeof obj.identifier === "string"
            ? obj.identifier
            : typeof obj.identifierMasked === "string"
              ? obj.identifierMasked
              : "",
        identifierMasked:
          typeof obj.identifierMasked === "string" ? obj.identifierMasked : "(hidden)",
        authMode: typeof obj.authMode === "string" ? obj.authMode : "password",
        mfaStrategy: typeof obj.mfaStrategy === "string" ? obj.mfaStrategy : "user_prompt",
        mfaSourceService:
          typeof obj.mfaSourceService === "string" ? obj.mfaSourceService : "",
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

function readSetupInputValue(
  host: T560App,
  inputName: string,
  options: { trim?: boolean } = {}
): string {
  const el = host.querySelector(`[data-input="${inputName}"]`) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | HTMLSelectElement
    | null;
  const value = String(el?.value ?? "");
  return options.trim === false ? value : value.trim();
}

function resolveEmailProviderDefaults(provider: string): {
  websiteUrl: string;
  service: string;
} {
  const key = String(provider ?? "").trim().toLowerCase();
  if (key === "gmail") {
    return { websiteUrl: "https://mail.google.com", service: "mail.google.com" };
  }
  if (key === "outlook") {
    return { websiteUrl: "https://outlook.live.com", service: "outlook.live.com" };
  }
  if (key === "yahoo") {
    return { websiteUrl: "https://mail.yahoo.com", service: "mail.yahoo.com" };
  }
  if (key === "proton") {
    return { websiteUrl: "https://mail.proton.me", service: "mail.proton.me" };
  }
  if (key === "icloud") {
    return { websiteUrl: "https://www.icloud.com/mail", service: "icloud.com" };
  }
  return { websiteUrl: "", service: "" };
}

function normalizeProviderIdDraft(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqModelIds(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function normalizeOpenAICompatibleBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  let normalized = trimmed;
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `http://${normalized}`;
  }
  normalized = normalized.replace(/\/+$/g, "");
  normalized = normalized.replace(/\/chat\/completions$/i, "");
  normalized = normalized.replace(/\/v1\/chat$/i, "/v1");
  if (!/\/v1$/i.test(normalized)) {
    normalized = `${normalized}/v1`;
  }
  return normalized;
}

function isLikelyHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
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
  host.setupProviderBaseUrl =
    host.setupNewProviderTemplate === "local-openai" ? "http://127.0.0.1:8080/v1" : "";
  host.setupProviderApi =
    host.setupNewProviderTemplate === "local-openai" ? "openai-completions" : "";
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
    const templateId = (host.setupNewProviderTemplate.trim() || providerId).toLowerCase();
    const isLocalProvider = templateId === "local-openai" || providerId === "local-openai";
    const existing = host.setupProviders[providerId];

    // Read text/password inputs from DOM rather than state — state is not
    // updated on every keystroke (to prevent re-renders closing mobile keyboard).
    const models = uniqModelIds(
      splitCsv(readSetupInputValue(host, "setup-provider-models") || host.setupProviderModels)
    );
    if (models.length === 0) {
      setSetupNotice(host, "error", "Add at least one model id before saving this provider.");
      return;
    }

    const rawBaseUrl = readSetupInputValue(host, "setup-provider-base-url") || host.setupProviderBaseUrl;
    let baseUrl = rawBaseUrl;
    if (isLocalProvider) {
      if (!rawBaseUrl.trim()) {
        setSetupNotice(host, "error", "Local model provider requires a server URL (example: http://127.0.0.1:52415/v1).");
        return;
      }
      const normalizedLocalBase = normalizeOpenAICompatibleBaseUrl(rawBaseUrl);
      if (!isLikelyHttpUrl(normalizedLocalBase)) {
        setSetupNotice(host, "error", "Local model server URL is invalid. Use http://host:port/v1.");
        return;
      }
      baseUrl = normalizedLocalBase;
    } else if (baseUrl && !isLikelyHttpUrl(baseUrl)) {
      setSetupNotice(host, "error", "Base URL must be a valid http(s) URL.");
      return;
    }

    let api = readSetupInputValue(host, "setup-provider-api") || host.setupProviderApi;
    if (isLocalProvider && !api.trim()) {
      api = "openai-completions";
    }
    const credential = readSetupInputValue(host, "setup-provider-credential", { trim: false }) || host.setupProviderCredential;
    if (
      !isLocalProvider &&
      host.setupProviderAuthMode !== "oauth" &&
      !existing?.hasCredential &&
      !credential.trim()
    ) {
      setSetupNotice(
        host,
        "error",
        "This provider needs a credential before it can run. Paste the key/token, then save."
      );
      return;
    }

    const payload = await requestJson<{ setup?: unknown }>("/api/setup/provider", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId,
        authMode: host.setupProviderAuthMode,
        models,
        baseUrl,
        api,
        enabled: host.setupProviderEnabled,
        credential,
      }),
    });

    const payloadRecord = asRecord(payload);
    const setupPayload = asRecord(payloadRecord.setup);
    applySetupPayload(host, setupPayload);
    host.setupProviderCredential = "";
    host.setupSelectedProvider = "";
    if (isLocalProvider && rawBaseUrl.trim() && rawBaseUrl.trim() !== baseUrl.trim()) {
      setSetupNotice(
        host,
        "success",
        `Saved provider settings for ${providerId}. URL normalized to ${baseUrl} for OpenAI-compatible routing.`
      );
    } else {
      setSetupNotice(host, "success", `Saved provider settings for ${providerId}.`);
    }
  } catch (error: unknown) {
    setSetupNotice(host, "error", toErrorMessage(error, "Failed to save provider settings."));
  } finally {
    host.setupSaving = false;
  }
}

export async function fetchSetupLocalProviderModels(host: T560App): Promise<void> {
  if (host.setupSaving) {
    return;
  }
  const providerId = host.setupSelectedProvider.trim() || host.setupNewProviderTemplate.trim();
  if (!providerId || providerId !== "local-openai") {
    setSetupNotice(host, "error", "Model fetch is available for local-openai only.");
    return;
  }

  const rawBaseUrl = readSetupInputValue(host, "setup-provider-base-url") || host.setupProviderBaseUrl;
  if (!rawBaseUrl.trim()) {
    setSetupNotice(host, "error", "Enter your local model server URL first.");
    return;
  }
  const baseUrl = normalizeOpenAICompatibleBaseUrl(rawBaseUrl);
  if (!isLikelyHttpUrl(baseUrl)) {
    setSetupNotice(host, "error", "Local model server URL is invalid. Use http://host:port/v1.");
    return;
  }
  const credential =
    readSetupInputValue(host, "setup-provider-credential", { trim: false }) || host.setupProviderCredential;

  host.setupSaving = true;
  clearSetupNotice(host);
  try {
    const payload = await requestJson<SetupProviderModelsResponse>("/api/setup/provider/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: "local-openai",
        baseUrl,
        ...(credential.trim() ? { apiKey: credential.trim() } : {}),
      }),
    });
    const record = asRecord(payload);
    const ok = record.ok !== false;
    const models = Array.isArray(record.models)
      ? record.models.map((entry) => String(entry ?? "").trim()).filter(Boolean)
      : [];
    const normalizedBaseUrl = String(record.normalizedBaseUrl ?? "").trim();
    if (!ok || models.length === 0) {
      const error = String(record.error ?? "Could not fetch models from local server.");
      setSetupNotice(host, "error", error);
      return;
    }
    host.setupProviderBaseUrl = normalizedBaseUrl || baseUrl;
    host.setupProviderModels = models.join(", ");
    setSetupNotice(
      host,
      "success",
      `Fetched ${models.length} model id${models.length === 1 ? "" : "s"} from local server.`
    );
  } catch (error: unknown) {
    setSetupNotice(
      host,
      "error",
      toErrorMessage(error, "Could not fetch models from local server.")
    );
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
    // Read text/password inputs from DOM — not from state — to avoid keyboard-closing re-renders.
    const botToken = readSetupInputValue(host, "setup-telegram-token") || host.setupTelegramToken;
    const allowFrom = splitCsv(readSetupInputValue(host, "setup-telegram-allow-from") || host.setupTelegramAllowFrom);
    const allowedChatIds = splitCsv(readSetupInputValue(host, "setup-telegram-allowed-chat-ids") || host.setupTelegramAllowedChatIds)
      .map((entry) => Number(entry))
      .filter((entry) => Number.isInteger(entry));

    const payload = await requestJson<{ setup?: unknown }>("/api/setup/telegram", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        dmPolicy: host.setupTelegramDmPolicy,
        allowFrom,
        allowedChatIds,
        ...(botToken ? { botToken } : {}),
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
  const accountTypeRaw = readSetupInputValue(host, "setup-vault-account-type");
  host.setupVaultAccountType = accountTypeRaw === "email" ? "email" : "site";
  host.setupVaultEmailProvider =
    readSetupInputValue(host, "setup-vault-email-provider") || host.setupVaultEmailProvider;
  host.setupVaultEmailSecretKind =
    readSetupInputValue(host, "setup-vault-email-secret-kind") === "password"
      ? "password"
      : "app_password";
  host.setupVaultWebsiteUrl =
    readSetupInputValue(host, "setup-vault-website-url") || host.setupVaultWebsiteUrl;
  host.setupVaultService =
    readSetupInputValue(host, "setup-vault-service") || host.setupVaultService;
  host.setupVaultIdentifier =
    readSetupInputValue(host, "setup-vault-identifier") || host.setupVaultIdentifier;
  host.setupVaultAuthMode =
    readSetupInputValue(host, "setup-vault-auth-mode") || host.setupVaultAuthMode;
  host.setupVaultMfaStrategy =
    readSetupInputValue(host, "setup-vault-mfa-strategy") || host.setupVaultMfaStrategy;
  host.setupVaultMfaSourceService =
    readSetupInputValue(host, "setup-vault-mfa-source-service") || host.setupVaultMfaSourceService;
  host.setupVaultSecret = readSetupInputValue(host, "setup-vault-secret", { trim: false });
  host.setupVaultMfaCode = readSetupInputValue(host, "setup-vault-mfa-code");

  let websiteUrl = host.setupVaultWebsiteUrl.trim();
  let service = host.setupVaultService.trim();
  const identifier = host.setupVaultIdentifier.trim();
  let authMode = host.setupVaultAuthMode;
  let mfaStrategy = host.setupVaultMfaStrategy;
  let mfaSourceService = host.setupVaultMfaSourceService.trim();

  if (host.setupVaultAccountType === "email") {
    const defaults = resolveEmailProviderDefaults(host.setupVaultEmailProvider);
    if (!websiteUrl) {
      websiteUrl = defaults.websiteUrl;
    }
    if (!service) {
      service = defaults.service;
    }
    authMode =
      host.setupVaultEmailSecretKind === "password"
        ? "password_with_mfa"
        : "password";
    mfaStrategy = "user_prompt";
    mfaSourceService = "";
  } else {
    if (authMode === "passwordless_mfa_code") {
      mfaStrategy = mfaSourceService ? "email_or_user" : "user_prompt";
    } else {
      mfaStrategy = "user_prompt";
      mfaSourceService = "";
    }
  }

  if (!websiteUrl && !service) {
    setSetupNotice(host, "error", "Website URL is required.");
    return;
  }
  if (
    (authMode === "password" || authMode === "password_with_mfa") &&
    !host.setupVaultSecret
  ) {
    setSetupNotice(host, "error", "Password-based auth mode requires a secret.");
    return;
  }

  host.setupSaving = true;
  clearSetupNotice(host);
  try {
    const payload = await requestJson<VaultResponse>("/api/vault", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        websiteUrl,
        service,
        identifier,
        authMode,
        mfaStrategy,
        mfaSourceService,
        secret: host.setupVaultSecret,
        mfaCode: host.setupVaultMfaCode,
      }),
    });

    const record = asRecord(payload);
    host.setupVaultEntries = normalizeVaultEntries(record.entries);
    const created = record.created === true;
    const identifierReused = record.identifierReused === true;
    const serviceSaved = String(record.service ?? service).trim() || service;
    host.setupVaultSecret = "";
    host.setupVaultMfaCode = "";
    if (created) {
      host.setupVaultIdentifier = "";
    }
    setSetupNotice(
      host,
      "success",
      created
        ? `Saved new vault credentials for ${serviceSaved}.`
        : identifierReused
          ? `Updated ${serviceSaved}; existing identifier was reused.`
          : `Updated vault credentials for ${serviceSaved}.`
    );
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
