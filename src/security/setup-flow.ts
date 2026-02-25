import {
  type CredentialAuthMode,
  deleteCredential,
  listConfiguredServices,
  normalizeSetupService,
  setCredential,
  type SetupService,
} from "./credentials-vault.js";

type PendingSetupState = {
  service: SetupService;
  step: "identifier" | "authMode" | "secret";
  authMode?: CredentialAuthMode;
  identifier?: string;
};

type SetupFlowHandled = {
  handled: true;
  message: string;
};

type SetupFlowIgnored = {
  handled: false;
};

const pendingBySessionId = new Map<string, PendingSetupState>();

function usageText(): string {
  return [
    "Secure setup commands:",
    "- /setup <service-or-site>   (example: /setup example.com or /setup https://example.com/login)",
    "- /setup list",
    "- /setup clear <service-or-site>",
    "- /setup cancel",
    "- /setup mode password|password+mfa|mfa    (only during active setup flow)",
  ].join("\n");
}

function promptForIdentifier(service: SetupService): string {
  if (service === "email" || service.startsWith("mail.")) {
    return `Setup ${service}: enter the email address for this mailbox account.`;
  }
  return `Setup ${service}: enter the login identifier (email/username).`;
}

function promptForAuthMode(service: SetupService): string {
  return [
    `Setup ${service}: choose auth mode.`,
    "- Type: password",
    "- Type: password+mfa (password plus one-time code)",
    "- Type: mfa (passwordless MFA code)",
    "You can also use: /setup mode password  or  /setup mode password+mfa  or  /setup mode mfa",
  ].join("\n");
}

function promptForSecret(service: SetupService, authMode: CredentialAuthMode): string {
  if (authMode === "passwordless_mfa_code") {
    return [
      `Setup ${service}: enter a default MFA code (optional).`,
      "Type 'skip' to save passwordless mode without a stored code.",
      "You can provide fresh MFA codes later during login flows.",
    ].join("\n");
  }
  if (service === "email" || service.startsWith("mail.")) {
    return `Setup ${service}: enter the app password or mailbox secret. It is stored securely and never echoed back.`;
  }
  return `Setup ${service}: enter your password or secret. It is stored securely and never echoed back.`;
}

function completionText(service: SetupService, authMode: CredentialAuthMode): string {
  if (authMode === "passwordless_mfa_code") {
    return `Saved secure credentials for ${service}. Auth mode=passwordless MFA code.`;
  }
  return `Saved secure credentials for ${service}.`;
}

function serviceLabel(service: SetupService): string {
  return service;
}

function normalizeAuthMode(input: string): CredentialAuthMode | null {
  const value = String(input ?? "").trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value === "password" || value === "pass" || value === "pwd") {
    return "password";
  }
  if (
    value === "password+mfa" ||
    value === "password_with_mfa" ||
    value === "password-and-mfa" ||
    value === "mfa_required"
  ) {
    return "password_with_mfa";
  }
  if (
    value === "mfa" ||
    value === "passwordless" ||
    value === "mfa-code" ||
    value === "passwordless-mfa" ||
    value === "passwordless_mfa_code"
  ) {
    return "passwordless_mfa_code";
  }
  return null;
}

function redactIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return "(empty)";
  }
  const at = trimmed.indexOf("@");
  if (at > 1) {
    return `${trimmed.slice(0, 1)}***${trimmed.slice(at)}`;
  }
  if (trimmed.length <= 3) {
    return `${trimmed[0] ?? "*"}**`;
  }
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-1)}`;
}

async function handleSlashSetupCommand(params: {
  workspaceDir: string;
  sessionId: string;
  text: string;
}): Promise<SetupFlowHandled | SetupFlowIgnored> {
  const trimmed = params.text.trim();
  if (!trimmed.startsWith("/setup")) {
    return { handled: false };
  }

  const parts = trimmed.split(/\s+/g).filter(Boolean);
  if (parts.length === 1) {
    return { handled: true, message: usageText() };
  }

  const sub = String(parts[1] ?? "").trim().toLowerCase();
  if (sub === "list") {
    const services = await listConfiguredServices(params.workspaceDir);
    if (services.length === 0) {
      return { handled: true, message: "No secure credentials stored yet." };
    }
    return {
      handled: true,
      message: [
        "Configured secure services:",
        ...services.map((service) => `- ${service}`),
      ].join("\n"),
    };
  }

  if (sub === "cancel") {
    const hadState = pendingBySessionId.delete(params.sessionId);
    return {
      handled: true,
      message: hadState ? "Cancelled active setup flow." : "No active setup flow for this session.",
    };
  }

  if (sub === "clear") {
    const service = normalizeSetupService(parts[2] ?? "");
    if (!service) {
      return {
        handled: true,
        message: "Usage: /setup clear <service-or-site>",
      };
    }
    const removed = await deleteCredential({
      workspaceDir: params.workspaceDir,
      service,
    });
    pendingBySessionId.delete(params.sessionId);
    return {
      handled: true,
      message: removed
        ? `Removed secure credentials for ${serviceLabel(service)}.`
        : `No stored credentials found for ${serviceLabel(service)}.`,
    };
  }

  if (sub === "mode") {
    const pending = pendingBySessionId.get(params.sessionId);
    if (!pending) {
      return {
        handled: true,
        message: "No active setup flow. Start with /setup <service-or-site>.",
      };
    }
    const authMode = normalizeAuthMode(parts[2] ?? "");
    if (!authMode) {
      return {
        handled: true,
        message: "Usage: /setup mode password|password+mfa|mfa",
      };
    }
    pending.authMode = authMode;
    pending.step = "secret";
    pendingBySessionId.set(params.sessionId, pending);
    return {
      handled: true,
      message: `${promptForSecret(pending.service, authMode)}\nIdentifier saved: ${redactIdentifier(String(pending.identifier ?? ""))}`,
    };
  }

  const service = normalizeSetupService(sub);
  if (!service) {
    return {
      handled: true,
      message: `${usageText()}\nUnsupported setup target: ${sub}`,
    };
  }

  pendingBySessionId.set(params.sessionId, {
    service,
    step: "identifier",
  });
  return {
    handled: true,
    message: `${promptForIdentifier(service)}\nType /setup cancel to abort.`,
  };
}

async function handlePendingSetupInput(params: {
  workspaceDir: string;
  sessionId: string;
  text: string;
}): Promise<SetupFlowHandled | SetupFlowIgnored> {
  const pending = pendingBySessionId.get(params.sessionId);
  if (!pending) {
    return { handled: false };
  }

  const raw = params.text;
  const value = raw.trim();
  if (!value) {
    return { handled: true, message: "Input cannot be empty. Type /setup cancel to abort." };
  }
  if (value.startsWith("/")) {
    if (/^\/setup\s+cancel\b/i.test(value)) {
      pendingBySessionId.delete(params.sessionId);
      return { handled: true, message: "Cancelled active setup flow." };
    }
    return {
      handled: true,
      message: "Setup flow is waiting for a value. Type /setup cancel to abort before using other slash commands.",
    };
  }

  if (pending.step === "identifier") {
    pending.identifier = value;
    pending.step = "authMode";
    pendingBySessionId.set(params.sessionId, pending);
    return {
      handled: true,
      message: `${promptForAuthMode(pending.service)}\nIdentifier saved: ${redactIdentifier(value)}`,
    };
  }

  if (pending.step === "authMode") {
    const authMode = normalizeAuthMode(value);
    if (!authMode) {
      return {
        handled: true,
        message: "Invalid auth mode. Type password, password+mfa, or mfa. (or /setup mode password|password+mfa|mfa)",
      };
    }
    pending.authMode = authMode;
    pending.step = "secret";
    pendingBySessionId.set(params.sessionId, pending);
    return {
      handled: true,
      message: `${promptForSecret(pending.service, authMode)}\nIdentifier saved: ${redactIdentifier(String(pending.identifier ?? ""))}`,
    };
  }

  const identifier = String(pending.identifier ?? "").trim();
  if (!identifier) {
    pendingBySessionId.delete(params.sessionId);
    return {
      handled: true,
      message: "Setup flow reset due to missing identifier. Run /setup <service-or-site> again.",
    };
  }
  const authMode = pending.authMode ?? "password";
  const mfaCode =
    authMode === "passwordless_mfa_code" && value.toLowerCase() !== "skip" ? value : "";
  const secret = authMode === "password" || authMode === "password_with_mfa" ? raw : "";

  try {
    await setCredential({
      workspaceDir: params.workspaceDir,
      service: pending.service,
      identifier,
      secret,
      authMode,
      ...(mfaCode ? { mfaCode } : {}),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      handled: true,
      message: `Could not save secure credentials yet: ${message}`,
    };
  }
  pendingBySessionId.delete(params.sessionId);
  return {
    handled: true,
    message: completionText(pending.service, authMode),
  };
}

export async function handleSecureSetupFlow(params: {
  workspaceDir?: string;
  sessionId: string;
  message: string;
}): Promise<SetupFlowHandled | SetupFlowIgnored> {
  const workspaceDir = params.workspaceDir ?? process.cwd();
  const slash = await handleSlashSetupCommand({
    workspaceDir,
    sessionId: params.sessionId,
    text: params.message,
  });
  if (slash.handled) {
    return slash;
  }
  return handlePendingSetupInput({
    workspaceDir,
    sessionId: params.sessionId,
    text: params.message,
  });
}

export function getSetupFlowState(sessionId: string): {
  service: SetupService;
  step: "identifier" | "authMode" | "secret";
  authMode?: CredentialAuthMode;
  hasIdentifier: boolean;
} | null {
  const pending = pendingBySessionId.get(sessionId);
  if (!pending) {
    return null;
  }
  return {
    service: pending.service,
    step: pending.step,
    ...(pending.authMode ? { authMode: pending.authMode } : {}),
    hasIdentifier: Boolean(String(pending.identifier ?? "").trim()),
  };
}

export function resetSetupFlowState(): void {
  pendingBySessionId.clear();
}
