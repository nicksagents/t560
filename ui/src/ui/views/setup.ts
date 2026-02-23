import type { T560App } from "../app.js";
import { icons } from "../icons.js";
import { escapeHtml } from "../markdown.js";

function renderSetupNotice(host: T560App): string {
  if (!host.setupNotice) {
    return "";
  }
  const cls =
    host.setupNotice.kind === "error"
      ? "danger"
      : host.setupNotice.kind === "success"
        ? "success"
        : "info";
  return `<div class="callout ${cls}" style="margin-bottom:12px">${escapeHtml(host.setupNotice.message)}</div>`;
}

function renderSettingsNotice(host: T560App): string {
  if (!host.settingsNotice) {
    return "";
  }
  const cls =
    host.settingsNotice.kind === "error"
      ? "danger"
      : host.settingsNotice.kind === "success"
        ? "success"
        : "info";
  return `<div class="callout ${cls}" style="margin-bottom:12px">${escapeHtml(host.settingsNotice.message)}</div>`;
}


function renderTemplateOptions(host: T560App): string {
  if (host.setupCatalog.length === 0) {
    return `<option value="">No templates</option>`;
  }
  return host.setupCatalog
    .map((entry) => {
      const selected = entry.id === host.setupNewProviderTemplate ? "selected" : "";
      return `<option value="${escapeHtml(entry.id)}" ${selected}>${escapeHtml(entry.label)} (${escapeHtml(entry.id)})</option>`;
    })
    .join("");
}

function renderAuthModeOptions(host: T560App): string {
  const templateId = host.setupNewProviderTemplate || host.setupSelectedProvider;
  const catalogEntry = host.setupCatalog.find((entry) => entry.id === templateId);
  const modes = catalogEntry?.authModes ?? ["api_key"];
  const isAnthropic = templateId === "anthropic";
  return modes
    .map((mode) => {
      let label: string;
      if (mode === "api_key") {
        label = "API Key";
      } else if (mode === "oauth") {
        label = isAnthropic ? "Claude Code OAuth" : "OAuth token";
      } else if (mode === "token") {
        label = isAnthropic ? "Setup Token (claude setup-token)" : "Provider token";
      } else {
        label = mode;
      }
      const isSelected = host.setupProviderAuthMode === mode ? "selected" : "";
      return `<option value="${escapeHtml(mode)}" ${isSelected}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function providerModelChoices(host: T560App): string[] {
  const selectedProvider =
    host.setupSelectedProvider.trim() ||
    host.setupNewProviderTemplate.trim();
  const configured = selectedProvider ? host.setupProviders[selectedProvider] : undefined;
  const catalog = host.setupCatalog.find((entry) => entry.id === selectedProvider);
  const ids = new Set<string>([
    ...splitCsv(host.setupProviderModels),
    ...(configured?.models ?? []),
    ...(catalog?.models ?? []),
    catalog?.defaultModel ?? "",
    catalog?.planningModel ?? "",
    catalog?.codingModel ?? "",
  ]);
  return [...ids].map((entry) => entry.trim()).filter(Boolean);
}

function currentPrimaryModel(host: T560App): string {
  const first = splitCsv(host.setupProviderModels)[0];
  return first || providerModelChoices(host)[0] || "";
}

function renderProviderModelOptions(host: T560App): string {
  const selected = currentPrimaryModel(host);
  const models = providerModelChoices(host);
  if (models.length === 0) {
    return `<option value="">No model options yet</option>`;
  }
  return models
    .map((modelId) => {
      const isSelected = modelId === selected ? "selected" : "";
      return `<option value="${escapeHtml(modelId)}" ${isSelected}>${escapeHtml(modelId)}</option>`;
    })
    .join("");
}


function renderRoleDropdown(host: T560App, slot: "default" | "planning" | "coding", busy: boolean): string {
  const currentProvider =
    slot === "default"
      ? host.setupRoutingDefaultProvider
      : slot === "planning"
        ? host.setupRoutingPlanningProvider
        : host.setupRoutingCodingProvider;
  const currentModel =
    slot === "default"
      ? host.setupRoutingDefaultModel
      : slot === "planning"
        ? host.setupRoutingPlanningModel
        : host.setupRoutingCodingModel;
  const currentValue = currentProvider && currentModel ? `${currentProvider}::${currentModel}` : "";

  const options: string[] = [`<option value="">— not assigned —</option>`];
  for (const [providerId, state] of Object.entries(host.setupProviders).sort(([a], [b]) => a.localeCompare(b))) {
    const catalog = host.setupCatalog.find((e) => e.id === providerId);
    const modelSet = new Set<string>(
      [
        ...(state?.models ?? []),
        ...(catalog?.models ?? []),
        catalog?.defaultModel ?? "",
        catalog?.planningModel ?? "",
        catalog?.codingModel ?? "",
      ]
        .map((m) => m.trim())
        .filter(Boolean)
    );
    for (const model of modelSet) {
      const value = `${providerId}::${model}`;
      const selected = value === currentValue ? "selected" : "";
      options.push(
        `<option value="${escapeHtml(value)}" ${selected}>${escapeHtml(providerId)} · ${escapeHtml(model)}</option>`
      );
    }
  }

  return `<select data-input="setup-role-${slot}" ${busy ? "disabled" : ""}>${options.join("")}</select>`;
}

function formatDateTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "—";
  }
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "—";
  }
}

function renderSectionNav(host: T560App, busy: boolean): string {
  const sections: Array<{ id: T560App["setupSection"]; label: string; icon: string }> = [
    { id: "provider", label: "Providers", icon: icons.checkCircle },
    { id: "telegram", label: "Telegram", icon: icons.messageCircle },
    { id: "vault", label: "Vault", icon: icons.settings },
    { id: "files", label: "Files", icon: icons.tool },
  ];

  return `<div class="setup-sections">
    ${sections
      .map((entry) => {
        const active = host.setupSection === entry.id ? "active" : "";
        return `<button class="setup-section-chip ${active}" data-action="select-setup-section" data-section="${entry.id}" ${busy ? "disabled" : ""}>
          <span class="setup-section-chip__icon">${entry.icon}</span>
          <span>${entry.label}</span>
        </button>`;
      })
      .join("")}
  </div>`;
}

function renderOnboardingCard(host: T560App): string {
  const status = (host.serverStatus ?? {}) as Record<string, unknown>;
  const missing = Array.isArray(status.missing)
    ? status.missing.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const onboarded = status.onboarded === true;

  if (onboarded) {
    return `<div class="callout success" style="margin-bottom:12px">Onboarding complete. Setup can fully manage your current runtime configuration.</div>`;
  }
  if (missing.length === 0) {
    return `<div class="callout info" style="margin-bottom:12px">Loading onboarding status…</div>`;
  }

  return `<div class="callout info" style="margin-bottom:12px">
    <div><strong>Onboarding still has required items:</strong></div>
    <div class="muted" style="margin-top:6px">${missing.map((item) => `<span class="mono">${escapeHtml(item)}</span>`).join(" · ")}</div>
  </div>`;
}

function renderProvidersCard(host: T560App, busy: boolean): string {
  const configuredIds = Object.keys(host.setupProviders).sort((a, b) => a.localeCompare(b));

  const addBtn = `<div class="settings-actions" style="margin-top:12px">
    <button class="btn primary" data-action="add-setup-provider" ${busy ? "disabled" : ""}>+ Add Provider</button>
  </div>`;

  if (configuredIds.length === 0) {
    return `<div class="card">
      <div class="card-title">Providers</div>
      <div class="card-sub">Connect AI services — then assign them roles above.</div>
      <div class="callout info" style="margin-top:12px">No providers yet — click <strong>+ Add Provider</strong> to get started.</div>
      ${addBtn}
    </div>`;
  }

  const rows = configuredIds
    .map((providerId) => {
      const profile = host.setupProviders[providerId];
      const catalog = host.setupCatalog.find((entry) => entry.id === providerId);
      const authLabel =
        profile.authMode === "oauth" ? "OAuth" : profile.authMode === "token" ? "Token" : "API Key";
      const statusChip =
        profile.enabled && profile.hasCredential
          ? `<span class="chip chip-ok" style="font-size:11px;padding:2px 8px">✓</span>`
          : profile.hasCredential
            ? `<span class="chip chip-warn" style="font-size:11px;padding:2px 8px">off</span>`
            : `<span class="chip chip-warn" style="font-size:11px;padding:2px 8px">no key</span>`;

      const models = [
        ...new Set(
          [
            ...(profile.models ?? []),
            ...(catalog?.models ?? []),
          ]
            .map((m) => m.trim())
            .filter(Boolean)
        ),
      ];
      const modelsText = models.length > 0 ? models.join(", ") : "—";

      return `<div style="border-top:1px solid var(--border);padding:10px 0;display:flex;align-items:flex-start;gap:10px;justify-content:space-between">
        <div style="min-width:0;flex:1">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span class="mono" style="font-size:13px;font-weight:600">${escapeHtml(providerId)}</span>
            <span class="muted" style="font-size:11px">${escapeHtml(authLabel)}</span>
            ${statusChip}
          </div>
          <div class="muted" style="font-size:11px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(modelsText)}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn btn--sm" data-action="select-setup-provider" data-provider="${escapeHtml(providerId)}" ${busy ? "disabled" : ""}>Edit</button>
          <button class="btn btn--sm danger" data-action="delete-setup-provider" data-provider="${escapeHtml(providerId)}" ${busy ? "disabled" : ""}>×</button>
        </div>
      </div>`;
    })
    .join("");

  return `<div class="card">
    <div class="card-title">Providers</div>
    <div class="card-sub">Your connected AI services.</div>
    ${rows}
    ${addBtn}
  </div>`;
}


// Embedded OAuth UI — rendered inside the provider form when openai-codex is selected.
function renderCodexOAuthInline(host: T560App, busy: boolean): string {
  const oauthBusy = busy || host.setupOAuthStatus === "starting" || host.setupOAuthStatus === "awaiting_signin";
  const hasCredential = host.setupProviders[host.setupSelectedProvider]?.hasCredential === true;

  if (host.setupOAuthStatus === "done") {
    return `<div class="callout success" style="margin-top:10px">Signed in successfully. The openai-codex provider is now active.</div>
    <div class="settings-actions" style="margin-top:8px">
      <button class="btn" data-action="reset-codex-oauth" ${busy ? "disabled" : ""}>Re-authenticate</button>
    </div>`;
  }

  if (host.setupOAuthStatus === "error") {
    return `<div class="callout danger" style="margin-top:10px">${escapeHtml(host.setupOAuthError || "OAuth sign-in failed.")}</div>
    <div class="settings-actions" style="margin-top:8px">
      <button class="btn primary" data-action="start-codex-oauth" ${busy ? "disabled" : ""}>Try again</button>
    </div>`;
  }

  if (host.setupOAuthStatus === "awaiting_signin") {
    return `<div class="callout info" style="margin-top:10px">
      <div>Open this link in your browser and sign in with your OpenAI account:</div>
      <div style="margin-top:6px;word-break:break-all"><a href="${escapeHtml(host.setupOAuthUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(host.setupOAuthUrl)}</a></div>
    </div>
    <div class="muted" style="margin-top:8px;font-size:12px">After signing in your browser redirects to <span class="mono">localhost:1455</span>. If that page errors, copy the full URL and paste below.</div>
    <label class="field full" style="margin-top:10px">
      <span>Paste redirect URL (if browser redirect failed)</span>
      <input type="text" data-input="setup-oauth-redirect" value="${escapeHtml(host.setupOAuthRedirectDraft)}" placeholder="http://localhost:1455/auth/callback?code=..." ${oauthBusy ? "disabled" : ""} />
    </label>
    <div class="settings-actions" style="margin-top:10px">
      <button class="btn primary" data-action="submit-codex-oauth-code" ${!host.setupOAuthRedirectDraft.trim() ? "disabled" : ""}>Submit URL</button>
    </div>
    <div class="muted" style="margin-top:6px;font-size:12px">Waiting for sign-in to complete…</div>`;
  }

  // Idle — already has a saved credential
  if (hasCredential) {
    return `<div class="callout success" style="margin-top:10px">Connected — OpenAI credential is saved and active.</div>
    <div class="settings-actions" style="margin-top:8px">
      <button class="btn" data-action="start-codex-oauth" ${oauthBusy ? "disabled" : ""}>Re-authenticate</button>
    </div>`;
  }

  // Idle / starting — no credential yet
  return `<div class="callout info" style="margin-top:10px">Use your OpenAI/ChatGPT account (Plus or Pro) — no API key needed.</div>
  <div class="settings-actions" style="margin-top:10px">
    <button class="btn primary" data-action="start-codex-oauth" ${oauthBusy ? "disabled" : ""}>
      ${host.setupOAuthStatus === "starting" ? "Starting…" : "Sign in with OpenAI"}
    </button>
  </div>`;
}

function renderProviderForm(host: T560App, busy: boolean): string {
  const isNew = host.setupSelectedProvider === "__new__" || !host.setupProviders[host.setupSelectedProvider];
  const title = isNew ? "Add Provider" : `Edit: ${host.setupSelectedProvider}`;
  const selectedCatalog = host.setupCatalog.find((entry) => entry.id === host.setupNewProviderTemplate);
  const selectedProviderState = host.setupProviders[host.setupSelectedProvider];
  const isCodexOAuth = host.setupNewProviderTemplate === "openai-codex";
  const isAnthropicOAuth = host.setupNewProviderTemplate === "anthropic" && host.setupProviderAuthMode === "oauth";
  const isAnthropicToken = host.setupNewProviderTemplate === "anthropic" && host.setupProviderAuthMode === "token";
  const credentialLabel = isAnthropicOAuth
    ? "Claude Code OAuth token"
    : isAnthropicToken
      ? "Setup token (from claude setup-token)"
      : host.setupProviderAuthMode === "oauth"
        ? "OAuth token"
        : host.setupProviderAuthMode === "token"
          ? "Provider token"
          : "API key";
  const credentialPlaceholder = isAnthropicOAuth
    ? "Paste token or use 'Load from Claude Code' below…"
    : isAnthropicToken
      ? "sk-ant-oat01-…"
      : host.setupProviderAuthMode === "oauth"
        ? "Paste your OAuth token…"
        : host.setupProviderAuthMode === "token"
          ? "Paste your provider token…"
          : "Paste your API key…";

  const isAnthropic = host.setupNewProviderTemplate === "anthropic";

  const templateOpts = `<option value="" ${!host.setupNewProviderTemplate ? "selected" : ""}>— Select a provider —</option>${renderTemplateOptions(host)}`;

  // Anthropic: show auth method selector + contextual instructions prominently
  const anthropicAuthBlock = isAnthropic ? `
    <label class="field" style="margin-top:12px">
      <span>How do you want to connect?</span>
      <select data-input="setup-provider-auth" ${busy ? "disabled" : ""}>${renderAuthModeOptions(host)}</select>
    </label>
    ${isAnthropicOAuth ? `<div class="callout info" style="margin-top:8px;font-size:13px">
        Uses your <strong>Claude Code CLI</strong> session. Click <strong>Load from Claude Code</strong> to auto-fill your token.<br/>
        <span style="margin-top:4px;display:block">Don't have one? Switch to <strong>API Key</strong> above and get a key at <strong>console.anthropic.com/settings/keys</strong>.</span>
      </div>` : ""}
    ${isAnthropicToken ? `<div class="callout info" style="margin-top:8px;font-size:13px">
        In your terminal, run: <span class="mono" style="user-select:all">claude setup-token</span><br/>
        Copy the token that starts with <span class="mono">sk-ant-oat01-</span> and paste it below.
      </div>` : ""}
    ${!isAnthropicOAuth && !isAnthropicToken ? `<div class="callout info" style="margin-top:8px;font-size:13px">
        Get your API key from <strong>console.anthropic.com/settings/keys</strong>.
      </div>` : ""}` : "";

  const ccStatus = host.setupCcTokenStatus;
  const ccMsg = host.setupCcTokenMessage;
  const loadCcTokenBtn = isAnthropicOAuth
    ? `<div style="margin-top:8px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <button class="btn" data-action="fetch-cc-token" ${busy || ccStatus === "loading" ? "disabled" : ""}>
            ${ccStatus === "loading" ? "Loading…" : "Load from Claude Code"}
          </button>
          ${ccStatus === "ok" ? `<span style="color:var(--ok);font-size:12px">✓ ${escapeHtml(ccMsg)}</span>` : ""}
          ${ccStatus === "error" ? `<span style="color:var(--danger);font-size:12px">${escapeHtml(ccMsg)}</span>` : ""}
        </div>
        ${ccStatus === "error" ? `<div class="callout danger" style="margin-top:8px;font-size:12px">
          <strong>Could not auto-load.</strong> To get your token manually:<br/>
          Open a terminal and run: <span class="mono">claude auth status</span> — or switch to <strong>API Key</strong> mode above and get a key from <strong>console.anthropic.com/settings/keys</strong>.
        </div>` : ""}
      </div>`
    : "";

  const authSection = isCodexOAuth
    ? renderCodexOAuthInline(host, busy)
    : `<label class="field full" style="margin-top:10px">
        <span>${escapeHtml(credentialLabel)}${selectedProviderState?.hasCredential ? ' <em class="muted">(saved — leave blank to keep)</em>' : ""}</span>
        <input type="password" data-input="setup-provider-credential" value="${escapeHtml(host.setupProviderCredential)}" placeholder="${escapeHtml(credentialPlaceholder)}" ${busy ? "disabled" : ""} autocomplete="off" />
      </label>
      ${loadCcTokenBtn}
      <div class="settings-actions" style="margin-top:12px">
        <button class="btn primary" data-action="save-setup-provider" ${busy ? "disabled" : ""}>Save Provider</button>
        <button class="btn" data-action="cancel-setup-provider" ${busy ? "disabled" : ""}>Cancel</button>
      </div>`;

  return `<div class="card">
    <div class="card-title">${escapeHtml(title)}</div>

    <label class="field" style="margin-top:12px">
      <span>Service</span>
      <select data-input="setup-new-provider-template" ${busy ? "disabled" : ""}>${templateOpts}</select>
    </label>

    ${anthropicAuthBlock}

    ${authSection}

    ${isCodexOAuth ? `<div class="settings-actions" style="margin-top:10px">
      <button class="btn" data-action="cancel-setup-provider" ${busy ? "disabled" : ""}>Cancel</button>
    </div>` : ""}

    <details style="margin-top:14px">
      <summary class="muted" style="cursor:pointer;font-size:12px">Advanced: model list, auth type, base URL…</summary>
      <div class="form-grid" style="margin-top:10px">
        <label class="field">
          <span>Model</span>
          <select data-input="setup-provider-model-choice" ${busy ? "disabled" : ""}>${renderProviderModelOptions(host)}</select>
        </label>
        ${!isAnthropic ? `<label class="field">
          <span>Auth type</span>
          <select data-input="setup-provider-auth" ${busy ? "disabled" : ""}>${renderAuthModeOptions(host)}</select>
        </label>` : ""}
        <label class="field">
          <span>Base URL (optional)</span>
          <input type="text" data-input="setup-provider-base-url" value="${escapeHtml(host.setupProviderBaseUrl)}" placeholder="https://api.openai.com/v1" ${busy ? "disabled" : ""} />
        </label>
        <label class="field">
          <span>API mode (optional)</span>
          <input type="text" data-input="setup-provider-api" value="${escapeHtml(host.setupProviderApi)}" placeholder="openai-responses" ${busy ? "disabled" : ""} />
        </label>
        <label class="field">
          <span>Enabled</span>
          <select data-input="setup-provider-enabled" ${busy ? "disabled" : ""}>
            <option value="true" ${host.setupProviderEnabled ? "selected" : ""}>Enabled</option>
            <option value="false" ${!host.setupProviderEnabled ? "selected" : ""}>Disabled</option>
          </select>
        </label>
        <label class="field full">
          <span>Models (comma separated)</span>
          <input type="text" data-input="setup-provider-models" value="${escapeHtml(host.setupProviderModels)}" ${busy ? "disabled" : ""} />
        </label>
      </div>
      ${selectedCatalog?.description ? `<div class="muted" style="margin-top:8px;font-size:12px">${escapeHtml(selectedCatalog.description)}</div>` : ""}
    </details>
  </div>`;
}

function renderProviderSection(host: T560App, busy: boolean): string {
  // Show add/edit form when a provider is selected (or adding new)
  if (host.setupSelectedProvider !== "") {
    return `<div class="settings-grid">
      ${renderProviderForm(host, busy)}
    </div>`;
  }

  // Two-card dashboard: Roles card + Providers card
  return `<div class="settings-grid">
    <div class="card">
      <div class="card-title">Roles</div>
      <div class="card-sub">Pick a model for each task type. Saves automatically.</div>
      <div class="roles-grid">
        <span>Default</span>${renderRoleDropdown(host, "default", busy)}
        <span>Planner</span>${renderRoleDropdown(host, "planning", busy)}
        <span>Coder</span>${renderRoleDropdown(host, "coding", busy)}
      </div>
    </div>
    ${renderProvidersCard(host, busy)}
  </div>`;
}


function renderTelegramSection(host: T560App, busy: boolean): string {
  return `<div class="card">
    <div class="card-title">Telegram</div>
    <div class="card-sub">Set bot token and DM policy for Telegram channel delivery.</div>
    <div class="form-grid" style="margin-top:12px">
      <label class="field full">
        <span>Bot token ${host.setupTelegramHasToken ? "(configured)" : "(not configured)"}</span>
        <input type="password" data-input="setup-telegram-token" value="${escapeHtml(host.setupTelegramToken)}" placeholder="leave blank to keep existing" ${busy ? "disabled" : ""} />
      </label>
      <label class="field">
        <span>DM policy</span>
        <select data-input="setup-telegram-dm-policy" ${busy ? "disabled" : ""}>
          <option value="pairing" ${host.setupTelegramDmPolicy === "pairing" ? "selected" : ""}>Pairing</option>
          <option value="allowlist" ${host.setupTelegramDmPolicy === "allowlist" ? "selected" : ""}>Allowlist</option>
          <option value="open" ${host.setupTelegramDmPolicy === "open" ? "selected" : ""}>Open</option>
          <option value="disabled" ${host.setupTelegramDmPolicy === "disabled" ? "selected" : ""}>Disabled</option>
        </select>
      </label>
      <label class="field">
        <span>Allow From (comma separated)</span>
        <input type="text" data-input="setup-telegram-allow-from" value="${escapeHtml(host.setupTelegramAllowFrom)}" placeholder="12345, 67890" ${busy ? "disabled" : ""} />
      </label>
      <label class="field">
        <span>Allowed Chat IDs (comma separated numbers)</span>
        <input type="text" data-input="setup-telegram-allowed-chat-ids" value="${escapeHtml(host.setupTelegramAllowedChatIds)}" placeholder="12345, 67890" ${busy ? "disabled" : ""} />
      </label>
    </div>
    <div class="settings-actions" style="margin-top:12px">
      <button class="btn primary" data-action="save-setup-telegram" ${busy ? "disabled" : ""}>Save Telegram</button>
    </div>
  </div>`;
}

function renderVaultSection(host: T560App, busy: boolean): string {
  const list = host.setupVaultEntries
    .map((entry) => {
      return `<div class="setup-vault-item">
        <div class="setup-vault-item__meta">
          <div class="mono">${escapeHtml(entry.service)}</div>
          <div class="muted mono">${escapeHtml(entry.identifierMasked)}</div>
        </div>
        <div class="setup-vault-item__meta">
          <div class="muted">${escapeHtml(entry.authMode)} · MFA ${entry.hasMfaCode ? "yes" : "no"}</div>
          <div class="muted">Updated ${escapeHtml(formatDateTime(entry.updatedAt))}</div>
        </div>
        <div class="setup-vault-item__actions">
          <button class="btn btn--sm danger" data-action="delete-vault-credential" data-service="${escapeHtml(entry.service)}" ${busy ? "disabled" : ""}>Delete</button>
        </div>
      </div>`;
    })
    .join("");

  return `<div class="card">
    <div class="card-title">Secure Vault</div>
    <div class="card-sub">Store site credentials securely (encrypted at rest in <span class="mono">.t560-secure</span>).</div>
    <div class="form-grid" style="margin-top:12px">
      <label class="field">
        <span>Service/site</span>
        <input type="text" data-input="setup-vault-service" value="${escapeHtml(host.setupVaultService)}" placeholder="email, x.com, havenvaults2-0" ${busy ? "disabled" : ""} />
      </label>
      <label class="field">
        <span>Identifier</span>
        <input type="text" data-input="setup-vault-identifier" value="${escapeHtml(host.setupVaultIdentifier)}" placeholder="email or username" ${busy ? "disabled" : ""} />
      </label>
      <label class="field">
        <span>Auth mode</span>
        <select data-input="setup-vault-auth-mode" ${busy ? "disabled" : ""}>
          <option value="password" ${host.setupVaultAuthMode === "password" ? "selected" : ""}>Password</option>
          <option value="passwordless_mfa_code" ${host.setupVaultAuthMode === "passwordless_mfa_code" ? "selected" : ""}>Passwordless MFA code</option>
        </select>
      </label>
      <label class="field">
        <span>Secret</span>
        <input type="password" data-input="setup-vault-secret" value="${escapeHtml(host.setupVaultSecret)}" placeholder="password or app password" ${busy ? "disabled" : ""} />
      </label>
      <label class="field">
        <span>MFA code (optional)</span>
        <input type="text" data-input="setup-vault-mfa-code" value="${escapeHtml(host.setupVaultMfaCode)}" placeholder="optional code" ${busy ? "disabled" : ""} />
      </label>
    </div>
    <div class="settings-actions" style="margin-top:12px">
      <button class="btn primary" data-action="save-vault-credential" ${busy ? "disabled" : ""}>Save Vault Credential</button>
      <button class="btn" data-action="refresh-vault" ${busy ? "disabled" : ""}>Refresh Vault</button>
    </div>
    <div class="setup-vault-list" style="margin-top:14px">
      ${list || `<div class="muted">No vault credentials saved yet.</div>`}
    </div>
  </div>`;
}

function renderBootstrapEditor(host: T560App, busy: boolean): string {
  const chips = host.bootstrapFiles
    .map((file) => {
      const classes = [
        "chip",
        host.selectedBootstrapName === file.name ? "active" : "",
        file.missing ? "chip-danger" : file.truncated ? "chip-warn" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<button class="${classes}" data-action="select-bootstrap-file" data-name="${escapeHtml(file.name)}" ${busy ? "disabled" : ""}>${escapeHtml(file.name)}</button>`;
    })
    .join("");

  const selected = host.selectedBootstrapName.trim();
  const draft = selected ? host.bootstrapDrafts[selected] ?? "" : "";

  return `<div class="card">
    <div class="card-title">Bootstrap Context Files</div>
    <div class="card-sub">These files are injected into the runtime prompt during startup.</div>
    <div class="settings-chip-row" style="margin-top:12px">${chips || `<span class="muted">No bootstrap files found.</span>`}</div>
    <label class="field full" style="margin-top:12px">
      <span>${selected ? escapeHtml(selected) : "File content"}</span>
      <textarea class="settings-editor" data-input="bootstrap-draft" ${busy || !selected ? "disabled" : ""}>${escapeHtml(draft)}</textarea>
    </label>
    <div class="settings-actions" style="margin-top:12px">
      <button class="btn primary" data-action="save-bootstrap-file" ${busy || !selected ? "disabled" : ""}>Save workspace file</button>
    </div>
  </div>`;
}

function renderFilesSection(host: T560App, busy: boolean): string {
  const filesBusy = busy || host.settingsLoading || host.settingsSaving;
  return `<div class="settings-grid">
    ${renderSettingsNotice(host)}
    <div class="card">
      <div class="card-title">Profile Files</div>
      <div class="card-sub">Manage <span class="mono">soul.md</span>, <span class="mono">users.md</span>, and runtime config directly from setup.</div>
      <div class="form-grid" style="margin-top:12px">
        <label class="field full">
          <span>soul.md</span>
          <textarea class="settings-editor" data-input="soul-draft" ${filesBusy ? "disabled" : ""}>${escapeHtml(host.soulDraft)}</textarea>
        </label>
        <div class="settings-actions">
          <button class="btn primary" data-action="save-soul" ${filesBusy ? "disabled" : ""}>Save soul.md</button>
        </div>
        <label class="field full">
          <span>users.md</span>
          <textarea class="settings-editor" data-input="users-draft" ${filesBusy ? "disabled" : ""}>${escapeHtml(host.usersDraft)}</textarea>
        </label>
        <div class="settings-actions">
          <button class="btn primary" data-action="save-users" ${filesBusy ? "disabled" : ""}>Save users.md</button>
        </div>
        <label class="field full">
          <span>config.json</span>
          <textarea class="settings-editor settings-editor--config" data-input="config-draft" ${filesBusy ? "disabled" : ""}>${escapeHtml(host.configDraft)}</textarea>
        </label>
      </div>
      <div class="settings-actions" style="margin-top:12px">
        <button class="btn" data-action="format-config" ${filesBusy ? "disabled" : ""}>Format JSON</button>
        <button class="btn primary" data-action="save-config" ${filesBusy ? "disabled" : ""}>Save config.json</button>
      </div>
    </div>

    ${renderBootstrapEditor(host, filesBusy)}
  </div>`;
}

export function renderSetupView(host: T560App): string {
  const busy = host.setupLoading || host.setupSaving;

  let sectionContent = "";
  if (host.setupSection === "provider" || host.setupSection === "routing") {
    sectionContent = renderProviderSection(host, busy);
  } else if (host.setupSection === "telegram") {
    sectionContent = renderTelegramSection(host, busy);
  } else if (host.setupSection === "vault") {
    sectionContent = renderVaultSection(host, busy);
  } else {
    sectionContent = renderFilesSection(host, busy);
  }

  return `<div class="content">
    <div class="content-header">
      <div>
        <div class="page-title">Setup</div>
        <div class="page-sub">Add providers, assign model roles, and configure Telegram, vault, and files.</div>
      </div>
      <div class="settings-actions">
        <button class="btn" data-action="refresh-setup" ${busy ? "disabled" : ""}>${icons.activity} Refresh</button>
      </div>
    </div>

    ${renderOnboardingCard(host)}
    ${renderSetupNotice(host)}
    ${renderSectionNav(host, busy)}

    <div style="margin-top:12px">
      ${sectionContent}
    </div>
  </div>`;
}
