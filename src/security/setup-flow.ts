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
    "- /setup <service-or-site>   (examples: /setup email, /setup x.com, /setup havenvaults2-0)",
    "- /setup list",
    "- /setup clear <service-or-site>",
    "- /setup cancel",
    "- /setup mode password|mfa    (only during active setup flow)",
  ].join("\n");
}

function promptForIdentifier(service: SetupService): string {
  if (service === "email") {
    return "Setup email: enter the email address for this account.";
  }
  if (service === "x.com") {
    return "Setup x.com: enter your X username or email.";
  }
  return `Setup ${service}: enter the login identifier (email/username).`;
}

function promptForAuthMode(service: SetupService): string {
  return [
    `Setup ${service}: choose auth mode.`,
    "- Type: password",
    "- Type: mfa (passwordless MFA code)",
    "You can also use: /setup mode password  or  /setup mode mfa",
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
  if (service === "email") {
    return "Setup email: enter the app password (preferred) or account password.";
  }
  if (service === "x.com") {
    return "Setup x.com: enter your password.";
  }
  return `Setup ${service}: enter your password.`;
}

function completionText(service: SetupService, authMode: CredentialAuthMode): string {
  if (authMode === "passwordless_mfa_code") {
    return `Saved secure credentials for ${service}. Auth mode=passwordless MFA code.`;
  }
  if (service === "email") {
    return "Saved secure credentials for email. The browser login action can now use service=email without exposing the password.";
  }
  if (service === "x.com") {
    return "Saved secure credentials for x.com. The browser login action can now use service=x.com without exposing the password.";
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
        message: "Usage: /setup mode password|mfa",
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
        message: "Invalid auth mode. Type password or mfa. (or /setup mode password|mfa)",
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
  const secret = authMode === "password" ? raw : "";

  await setCredential({
    workspaceDir: params.workspaceDir,
    service: pending.service,
    identifier,
    secret,
    authMode,
    ...(mfaCode ? { mfaCode } : {}),
  });
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
