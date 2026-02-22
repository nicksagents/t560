import os from "node:os";
import path from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VAULT_VERSION = 1;
const VAULT_AAD = Buffer.from("t560-credentials-vault-v1", "utf-8");

export type SetupService = string;
export type CredentialAuthMode = "password" | "passwordless_mfa_code";

type StoredCredentialRecord = {
  service: SetupService;
  identifier: string;
  secret: string;
  authMode: CredentialAuthMode;
  mfaCode?: string | null;
  createdAt: number;
  updatedAt: number;
};

type VaultStore = {
  version: number;
  records: Partial<Record<SetupService, StoredCredentialRecord>>;
};

type EncryptedEnvelope = {
  version: number;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
};

export type CredentialRecord = {
  service: SetupService;
  identifier: string;
  secret: string;
  authMode: CredentialAuthMode;
  mfaCode?: string | null;
  createdAt: number;
  updatedAt: number;
};

export function normalizeSetupService(input: string): SetupService | null {
  const value = String(input ?? "").trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value === "email" || value === "mail") {
    return "email";
  }
  if (value === "x" || value === "x.com" || value === "twitter" || value === "twitter.com") {
    return "x.com";
  }

  // Allow generic site/service setup keys:
  // - bare slugs: havenvaults2-0
  // - domains: amazon.ca
  // - full URLs: https://example.com/login
  let candidate = value;
  if (candidate.includes("://")) {
    try {
      const url = new URL(candidate);
      candidate = url.hostname.toLowerCase();
    } catch {
      // keep raw candidate
    }
  }
  if (candidate.startsWith("www.")) {
    candidate = candidate.slice(4);
  }
  const sanitized = candidate.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized || sanitized.length > 80) {
    return null;
  }
  return sanitized;
}

export function resolveWorkspaceVaultDir(workspaceDir: string = process.cwd()): string {
  return path.join(path.resolve(workspaceDir), ".t560-secure");
}

export function resolveWorkspaceVaultFile(workspaceDir: string = process.cwd()): string {
  return path.join(resolveWorkspaceVaultDir(workspaceDir), "credentials.v1.enc");
}

export function resolveVaultKeyFile(): string {
  return path.join(os.homedir(), ".t560", "secure", "vault.key");
}

function createEmptyStore(): VaultStore {
  return {
    version: VAULT_VERSION,
    records: {},
  };
}

function normalizeStore(raw: unknown): VaultStore {
  if (!raw || typeof raw !== "object") {
    return createEmptyStore();
  }
  const obj = raw as Record<string, unknown>;
  const recordsRaw = obj.records;
  const records: Partial<Record<SetupService, StoredCredentialRecord>> = {};
  if (recordsRaw && typeof recordsRaw === "object") {
    for (const [serviceKey, entryRaw] of Object.entries(recordsRaw as Record<string, unknown>)) {
      if (!entryRaw || typeof entryRaw !== "object") {
        continue;
      }
      const entry = entryRaw as Record<string, unknown>;
      const service = normalizeSetupService(String(entry.service ?? serviceKey));
      const identifier = String(entry.identifier ?? "").trim();
      const secret = String(entry.secret ?? "");
      const authModeRaw = String(entry.authMode ?? "").trim().toLowerCase();
      const authMode: CredentialAuthMode =
        authModeRaw === "passwordless_mfa_code" ? "passwordless_mfa_code" : "password";
      const mfaCodeRaw = entry.mfaCode;
      const mfaCode =
        typeof mfaCodeRaw === "string" && mfaCodeRaw.trim().length > 0 ? mfaCodeRaw.trim() : null;
      const createdAt = Number(entry.createdAt ?? Date.now());
      const updatedAt = Number(entry.updatedAt ?? Date.now());
      const hasSecret = secret.trim().length > 0;
      if (!service || !identifier || (!hasSecret && authMode === "password")) {
        continue;
      }
      records[service] = {
        service,
        identifier,
        secret,
        authMode,
        ...(mfaCode ? { mfaCode } : {}),
        createdAt: Number.isFinite(createdAt) && createdAt > 0 ? Math.floor(createdAt) : Date.now(),
        updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.floor(updatedAt) : Date.now(),
      };
    }
  }
  return {
    version: VAULT_VERSION,
    records,
  };
}

function toEnvelope(raw: unknown): EncryptedEnvelope | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.algorithm !== "aes-256-gcm") {
    return null;
  }
  const version = Number(obj.version ?? 0);
  const iv = String(obj.iv ?? "");
  const tag = String(obj.tag ?? "");
  const ciphertext = String(obj.ciphertext ?? "");
  if (version !== VAULT_VERSION || !iv || !tag || !ciphertext) {
    return null;
  }
  return {
    version,
    algorithm: "aes-256-gcm",
    iv,
    tag,
    ciphertext,
  };
}

function encryptStore(store: VaultStore, key: Buffer): EncryptedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(VAULT_AAD);
  const payload = Buffer.from(JSON.stringify(store), "utf-8");
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: VAULT_VERSION,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };
}

function decryptStore(envelope: EncryptedEnvelope, key: Buffer): VaultStore {
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(VAULT_AAD);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return normalizeStore(JSON.parse(plain.toString("utf-8")));
}

async function chmod600IfPossible(filePath: string): Promise<void> {
  try {
    await chmod(filePath, 0o600);
  } catch {
    // best-effort
  }
}

async function chmod700IfPossible(dirPath: string): Promise<void> {
  try {
    await chmod(dirPath, 0o700);
  } catch {
    // best-effort
  }
}

async function ensureVaultDirs(workspaceDir: string): Promise<void> {
  const vaultDir = resolveWorkspaceVaultDir(workspaceDir);
  const keyDir = path.dirname(resolveVaultKeyFile());
  await mkdir(vaultDir, { recursive: true, mode: 0o700 });
  await mkdir(keyDir, { recursive: true, mode: 0o700 });
  await Promise.all([chmod700IfPossible(vaultDir), chmod700IfPossible(keyDir)]);
}

async function readOrCreateVaultKey(options: {
  workspaceDir: string;
  allowCreate: boolean;
}): Promise<Buffer> {
  const keyPath = resolveVaultKeyFile();
  try {
    const raw = await readFile(keyPath, "utf-8");
    const key = Buffer.from(raw.trim(), "base64");
    if (key.length !== 32) {
      throw new Error("Invalid vault key length.");
    }
    return key;
  } catch (error) {
    if (!options.allowCreate) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Credential key is missing or invalid (${keyPath}): ${msg}`);
    }
    await ensureVaultDirs(options.workspaceDir);
    const key = randomBytes(32);
    await writeFile(keyPath, `${key.toString("base64")}\n`, "utf-8");
    await chmod600IfPossible(keyPath);
    return key;
  }
}

async function readVaultStore(workspaceDir: string): Promise<{ key: Buffer; store: VaultStore }> {
  const vaultPath = resolveWorkspaceVaultFile(workspaceDir);
  let payload: string | null = null;
  try {
    payload = await readFile(vaultPath, "utf-8");
  } catch {
    payload = null;
  }
  const key = await readOrCreateVaultKey({
    workspaceDir,
    allowCreate: payload === null,
  });
  if (!payload) {
    return { key, store: createEmptyStore() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("Credential vault file is invalid JSON.");
  }
  const envelope = toEnvelope(parsed);
  if (!envelope) {
    throw new Error("Credential vault file format is invalid.");
  }
  try {
    return {
      key,
      store: decryptStore(envelope, key),
    };
  } catch {
    throw new Error("Could not decrypt credential vault. Verify key integrity.");
  }
}

async function writeVaultStore(workspaceDir: string, key: Buffer, store: VaultStore): Promise<void> {
  await ensureVaultDirs(workspaceDir);
  const vaultPath = resolveWorkspaceVaultFile(workspaceDir);
  const envelope = encryptStore(store, key);
  await writeFile(vaultPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf-8");
  await chmod600IfPossible(vaultPath);
}

export async function setCredential(params: {
  workspaceDir?: string;
  service: string;
  identifier: string;
  secret: string;
  authMode?: CredentialAuthMode;
  mfaCode?: string | null;
}): Promise<{ service: SetupService; created: boolean }> {
  const workspaceDir = path.resolve(params.workspaceDir ?? process.cwd());
  const service = normalizeSetupService(params.service);
  if (!service) {
    throw new Error("Unsupported setup service.");
  }
  const identifier = String(params.identifier ?? "").trim();
  const authMode: CredentialAuthMode =
    params.authMode === "passwordless_mfa_code" ? "passwordless_mfa_code" : "password";
  const rawSecret = String(params.secret ?? "");
  const secret =
    authMode === "password"
      ? rawSecret
      : rawSecret.trim().length > 0
        ? rawSecret
        : "__PASSWORDLESS_MFA__";
  const mfaCode = typeof params.mfaCode === "string" ? params.mfaCode.trim() : "";
  if (!identifier) {
    throw new Error("Identifier is required.");
  }
  if (authMode === "password" && !secret) {
    throw new Error("Secret is required.");
  }
  const { key, store } = await readVaultStore(workspaceDir);
  const now = Date.now();
  const existing = store.records[service];
  store.records[service] = {
    service,
    identifier,
    secret,
    authMode,
    ...(mfaCode ? { mfaCode } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await writeVaultStore(workspaceDir, key, store);
  return {
    service,
    created: !existing,
  };
}

export async function getCredential(params: {
  workspaceDir?: string;
  service: string;
}): Promise<CredentialRecord | null> {
  const workspaceDir = path.resolve(params.workspaceDir ?? process.cwd());
  const service = normalizeSetupService(params.service);
  if (!service) {
    return null;
  }
  const { store } = await readVaultStore(workspaceDir);
  const record = store.records[service];
  if (!record) {
    return null;
  }
  return {
    service: record.service,
    identifier: record.identifier,
    secret: record.secret,
    authMode: record.authMode,
    ...(record.mfaCode ? { mfaCode: record.mfaCode } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function deleteCredential(params: {
  workspaceDir?: string;
  service: string;
}): Promise<boolean> {
  const workspaceDir = path.resolve(params.workspaceDir ?? process.cwd());
  const service = normalizeSetupService(params.service);
  if (!service) {
    return false;
  }
  const { key, store } = await readVaultStore(workspaceDir);
  if (!store.records[service]) {
    return false;
  }
  delete store.records[service];
  await writeVaultStore(workspaceDir, key, store);
  return true;
}

export async function listConfiguredServices(workspaceDir: string = process.cwd()): Promise<string[]> {
  const { store } = await readVaultStore(path.resolve(workspaceDir));
  return Object.keys(store.records)
    .map((key) => normalizeSetupService(key))
    .filter((value): value is SetupService => Boolean(value))
    .sort();
}

export function isSensitivePath(targetPath: string, workspaceDir: string): boolean {
  const resolved = path.resolve(targetPath);
  const normalized = resolved.split(path.sep).join("/");
  const workspaceRoot = path.resolve(workspaceDir);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative && relative.startsWith("..")) {
    return false;
  }
  if (normalized.includes("/.t560-secure/") || normalized.endsWith("/.t560-secure")) {
    return true;
  }
  const baseName = path.basename(resolved).toLowerCase();
  if (baseName === ".env" || baseName.startsWith(".env.")) {
    return true;
  }
  if (baseName === "credentials.v1.enc") {
    return true;
  }
  return false;
}

export function commandTouchesSensitivePath(command: string): boolean {
  const text = String(command ?? "");
  if (!text.trim()) {
    return false;
  }
  return (
    /(^|[^a-zA-Z0-9_])\.env([.\s"'`/]|$)/i.test(text) ||
    /\.t560-secure\b/i.test(text) ||
    /credentials\.v1\.enc\b/i.test(text) ||
    /vault\.key\b/i.test(text)
  );
}
