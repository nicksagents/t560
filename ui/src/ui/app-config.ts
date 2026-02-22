import type { T560App } from "./app.js";

export type SettingsNoticeKind = "success" | "error" | "info";

export type SettingsNotice = {
  kind: SettingsNoticeKind;
  message: string;
};

export type BootstrapContextFile = {
  name: string;
  path: string;
  content: string;
  missing: boolean;
  truncated: boolean;
  source: string;
  rawChars: number;
  injectedChars: number;
};

type ProfileResponse = {
  content?: unknown;
};

type ConfigResponse = {
  config?: unknown;
  configPath?: unknown;
};

type BootstrapResponse = {
  files?: unknown;
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

function normalizeBootstrapFiles(raw: unknown): BootstrapContextFile[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item): BootstrapContextFile | null => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const obj = item as Record<string, unknown>;
      const name = typeof obj.name === "string" ? obj.name.trim() : "";
      if (!name) {
        return null;
      }
      return {
        name,
        path: typeof obj.path === "string" ? obj.path : "",
        content: typeof obj.content === "string" ? obj.content : "",
        missing: obj.missing === true,
        truncated: obj.truncated === true,
        source: typeof obj.source === "string" ? obj.source : "missing",
        rawChars: Number.isFinite(Number(obj.rawChars)) ? Number(obj.rawChars) : 0,
        injectedChars: Number.isFinite(Number(obj.injectedChars)) ? Number(obj.injectedChars) : 0,
      };
    })
    .filter((entry): entry is BootstrapContextFile => entry !== null);
}

function setNotice(host: T560App, kind: SettingsNoticeKind, message: string): void {
  host.settingsNotice = { kind, message };
}

function clearNotice(host: T560App): void {
  host.settingsNotice = null;
}

function normalizeJsonText(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "{\n}\n";
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

function getSelectedBootstrapDraft(host: T560App): string {
  const selected = host.selectedBootstrapName.trim();
  if (!selected) {
    return "";
  }
  return host.bootstrapDrafts[selected] ?? "";
}

function setBootstrapFiles(host: T560App, files: BootstrapContextFile[]): void {
  host.bootstrapFiles = files;
  const nextDrafts: Record<string, string> = {};
  for (const file of files) {
    nextDrafts[file.name] = file.missing ? "" : file.content;
  }
  host.bootstrapDrafts = nextDrafts;
  if (!host.selectedBootstrapName || !files.some((file) => file.name === host.selectedBootstrapName)) {
    host.selectedBootstrapName = files[0]?.name ?? "";
  }
}

async function refreshBootstrapContext(host: T560App): Promise<void> {
  const payload = await requestJson<BootstrapResponse>("/api/context/bootstrap");
  const record = asRecord(payload);
  setBootstrapFiles(host, normalizeBootstrapFiles(record.files));
}

async function refreshStatus(host: T560App): Promise<void> {
  const payload = await requestJson<Record<string, unknown>>("/api/status");
  host.serverStatus = asRecord(payload);
}

export async function loadDashboardSettings(host: T560App, force = false): Promise<void> {
  if (host.settingsLoading) {
    return;
  }
  if (host.settingsLoaded && !force) {
    return;
  }

  host.settingsLoading = true;
  if (force) {
    clearNotice(host);
  }
  try {
    const [soul, users, configPayload, bootstrapPayload, statusPayload] = await Promise.all([
      requestJson<ProfileResponse>("/api/profile/soul"),
      requestJson<ProfileResponse>("/api/profile/users"),
      requestJson<ConfigResponse>("/api/config"),
      requestJson<BootstrapResponse>("/api/context/bootstrap"),
      requestJson<Record<string, unknown>>("/api/status"),
    ]);

    const soulRecord = asRecord(soul);
    const usersRecord = asRecord(users);
    const configRecord = asRecord(configPayload);
    const bootstrapRecord = asRecord(bootstrapPayload);

    host.soulDraft = typeof soulRecord.content === "string" ? soulRecord.content : "";
    host.usersDraft = typeof usersRecord.content === "string" ? usersRecord.content : "";
    host.configDraft = normalizeJsonText(configRecord.config);
    host.configPath = typeof configRecord.configPath === "string" ? configRecord.configPath : "";
    setBootstrapFiles(host, normalizeBootstrapFiles(bootstrapRecord.files));
    host.serverStatus = asRecord(statusPayload);
    host.settingsLoaded = true;
  } catch (error: unknown) {
    setNotice(host, "error", toErrorMessage(error, "Failed to load settings."));
  } finally {
    host.settingsLoading = false;
  }
}

export function updateSettingsDraft(host: T560App, field: "soul" | "users" | "config", value: string): void {
  if (field === "soul") {
    host.soulDraft = value;
    return;
  }
  if (field === "users") {
    host.usersDraft = value;
    return;
  }
  host.configDraft = value;
}

export function updateSelectedBootstrapDraft(host: T560App, value: string): void {
  const name = host.selectedBootstrapName.trim();
  if (!name) {
    return;
  }
  host.bootstrapDrafts = {
    ...host.bootstrapDrafts,
    [name]: value,
  };
}

export function selectBootstrapFile(host: T560App, name: string): void {
  const selected = name.trim();
  if (!selected || !host.bootstrapFiles.some((file) => file.name === selected)) {
    return;
  }
  host.selectedBootstrapName = selected;
}

export function formatConfigDraft(host: T560App): void {
  try {
    const parsed = JSON.parse(host.configDraft) as unknown;
    host.configDraft = normalizeJsonText(parsed);
    setNotice(host, "success", "Config JSON formatted.");
  } catch {
    setNotice(host, "error", "Config JSON is invalid and could not be formatted.");
  }
}

export async function saveProfileDraft(host: T560App, profile: "soul" | "users"): Promise<void> {
  if (host.settingsSaving) {
    return;
  }
  host.settingsSaving = true;
  clearNotice(host);
  try {
    const content = profile === "soul" ? host.soulDraft : host.usersDraft;
    await requestJson<Record<string, unknown>>(`/api/profile/${profile}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    await refreshBootstrapContext(host);
    setNotice(host, "success", `${profile}.md saved.`);
  } catch (error: unknown) {
    setNotice(host, "error", toErrorMessage(error, `Failed to save ${profile}.md.`));
  } finally {
    host.settingsSaving = false;
  }
}

export async function saveConfigDraft(host: T560App): Promise<void> {
  if (host.settingsSaving) {
    return;
  }
  host.settingsSaving = true;
  clearNotice(host);

  let parsed: unknown;
  try {
    parsed = JSON.parse(host.configDraft);
  } catch {
    setNotice(host, "error", "Config JSON is invalid.");
    host.settingsSaving = false;
    return;
  }

  try {
    const payload = await requestJson<ConfigResponse>("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: parsed }),
    });
    const record = asRecord(payload);
    host.configDraft = normalizeJsonText(record.config);
    host.configPath = typeof record.configPath === "string" ? record.configPath : host.configPath;
    await refreshStatus(host);
    setNotice(host, "success", "config.json saved.");
  } catch (error: unknown) {
    setNotice(host, "error", toErrorMessage(error, "Failed to save config.json."));
  } finally {
    host.settingsSaving = false;
  }
}

export async function saveBootstrapDraft(host: T560App): Promise<void> {
  if (host.settingsSaving) {
    return;
  }
  const name = host.selectedBootstrapName.trim();
  if (!name) {
    setNotice(host, "error", "Select a bootstrap file first.");
    return;
  }

  host.settingsSaving = true;
  clearNotice(host);
  try {
    await requestJson<Record<string, unknown>>("/api/context/bootstrap", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        content: getSelectedBootstrapDraft(host),
      }),
    });
    await refreshBootstrapContext(host);
    setNotice(host, "success", `${name} saved to workspace.`);
  } catch (error: unknown) {
    setNotice(host, "error", toErrorMessage(error, `Failed to save ${name}.`));
  } finally {
    host.settingsSaving = false;
  }
}
