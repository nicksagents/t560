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

function allProviderIds(host: T560App): string[] {
  const ids = new Set<string>([
    ...Object.keys(host.setupProviders),
    ...host.setupCatalog.map((entry) => entry.id),
    host.setupSelectedProvider.trim(),
    host.setupNewProviderId.trim(),
  ]);
  return [...ids].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function renderProviderOptions(host: T560App): string {
  const ids = allProviderIds(host);
  if (ids.length === 0) {
    return `<option value="">No providers available</option>`;
  }
  return ids
    .map((id) => {
      const catalog = host.setupCatalog.find((entry) => entry.id === id);
      const label = catalog ? `${catalog.label} (${id})` : id;
      const selected = id === host.setupSelectedProvider ? "selected" : "";
      return `<option value="${escapeHtml(id)}" ${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");
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
  const selected = host.setupCatalog.find((entry) => entry.id === host.setupSelectedProvider);
  const modes = selected?.authModes ?? ["api_key", "oauth", "token"];
  return modes
    .map((mode) => {
      const label =
        mode === "api_key"
          ? "API key"
          : mode === "oauth"
            ? "OAuth token"
            : mode === "token"
              ? "Provider token"
              : mode;
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

function renderRoutingProviderOptions(host: T560App, selectedProvider: string): string {
  const list = allProviderIds(host);
  return list
    .map((providerId) => {
      const isSelected = providerId === selectedProvider ? "selected" : "";
      return `<option value="${escapeHtml(providerId)}" ${isSelected}>${escapeHtml(providerId)}</option>`;
    })
    .join("");
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
    { id: "provider", label: "Provider", icon: icons.checkCircle },
    { id: "routing", label: "Routing", icon: icons.activity },
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

function renderProviderCards(host: T560App, busy: boolean): string {
  const configuredIds = Object.keys(host.setupProviders).sort((a, b) => a.localeCompare(b));
  if (configuredIds.length === 0) {
    return `<div class="muted">No configured providers yet. Add one below.</div>`;
  }

  return `<div class="setup-provider-list">
    ${configuredIds
      .map((providerId) => {
        const profile = host.setupProviders[providerId];
        const catalog = host.setupCatalog.find((entry) => entry.id === providerId);
        const selected = host.setupSelectedProvider === providerId ? "selected" : "";
        const routeBadges: string[] = [];
        if (host.setupRoutingDefaultProvider === providerId) routeBadges.push("default");
        if (host.setupRoutingPlanningProvider === providerId) routeBadges.push("planning");
        if (host.setupRoutingCodingProvider === providerId) routeBadges.push("coding");

        return `<div class="setup-provider-item ${selected}">
          <div class="setup-provider-item__head">
            <div>
              <div class="mono">${escapeHtml(providerId)}</div>
              <div class="muted">${escapeHtml(catalog?.label ?? "Custom provider")}</div>
            </div>
            <div class="setup-provider-item__chips">
              <span class="chip ${profile.enabled ? "chip-ok" : "chip-warn"}">${profile.enabled ? "enabled" : "disabled"}</span>
              <span class="chip ${profile.hasCredential ? "chip-ok" : "chip-warn"}">${profile.hasCredential ? "credential" : "no credential"}</span>
              <span class="chip">${profile.models.length} models</span>
              ${routeBadges.map((badge) => `<span class="chip active">${badge}</span>`).join("")}
            </div>
          </div>
          <div class="setup-provider-item__actions">
            <button class="btn btn--sm" data-action="select-setup-provider" data-provider="${escapeHtml(providerId)}" ${busy ? "disabled" : ""}>Edit</button>
            <button class="btn btn--sm" data-action="assign-setup-route-provider" data-slot="default" data-provider="${escapeHtml(providerId)}" ${busy ? "disabled" : ""}>Set Default</button>
            <button class="btn btn--sm" data-action="assign-setup-route-provider" data-slot="planning" data-provider="${escapeHtml(providerId)}" ${busy ? "disabled" : ""}>Set Planner</button>
            <button class="btn btn--sm" data-action="assign-setup-route-provider" data-slot="coding" data-provider="${escapeHtml(providerId)}" ${busy ? "disabled" : ""}>Set Coder</button>
            <button class="btn btn--sm danger" data-action="delete-setup-provider" data-provider="${escapeHtml(providerId)}" ${busy ? "disabled" : ""}>Remove</button>
          </div>
        </div>`;
      })
      .join("")}
  </div>`;
}

function collectAvailableProviderModels(host: T560App): Array<{ provider: string; model: string; enabled: boolean }> {
  const rows: Array<{ provider: string; model: string; enabled: boolean }> = [];
  const seen = new Set<string>();

  for (const providerId of Object.keys(host.setupProviders).sort((a, b) => a.localeCompare(b))) {
    const profile = host.setupProviders[providerId];
    const catalog = host.setupCatalog.find((entry) => entry.id === providerId);
    const models = [
      ...(profile.models ?? []),
      ...(catalog?.models ?? []),
      catalog?.defaultModel ?? "",
      catalog?.planningModel ?? "",
      catalog?.codingModel ?? "",
    ]
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const model of models) {
      const key = `${providerId}::${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ provider: providerId, model, enabled: profile.enabled !== false });
    }
  }

  const selected = host.setupSelectedProvider.trim();
  if (selected) {
    for (const model of splitCsv(host.setupProviderModels)) {
      const key = `${selected}::${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ provider: selected, model, enabled: true });
    }
  }

  return rows.sort((a, b) =>
    a.provider === b.provider
      ? a.model.localeCompare(b.model)
      : a.provider.localeCompare(b.provider)
  );
}

function renderRouteSlot(
  host: T560App,
  slot: "default" | "planning" | "coding",
  label: string,
  busy: boolean
): string {
  const provider =
    slot === "default"
      ? host.setupRoutingDefaultProvider.trim()
      : slot === "planning"
        ? host.setupRoutingPlanningProvider.trim()
        : host.setupRoutingCodingProvider.trim();
  const model =
    slot === "default"
      ? host.setupRoutingDefaultModel.trim()
      : slot === "planning"
        ? host.setupRoutingPlanningModel.trim()
        : host.setupRoutingCodingModel.trim();
  const hasValue = Boolean(provider && model);

  return `<div class="setup-route-slot" data-route-slot="${slot}" ${busy ? "aria-disabled=\"true\"" : ""}>
    <div class="setup-route-slot__label">${label}</div>
    <div class="setup-route-slot__value">
      ${hasValue
        ? `<span class="mono">${escapeHtml(provider)}/${escapeHtml(model)}</span>`
        : `<span class="muted">Drop model here</span>`}
    </div>
  </div>`;
}

function renderRoutingDnDCard(host: T560App, busy: boolean): string {
  const models = collectAvailableProviderModels(host);
  return `<div class="card">
    <div class="card-title">Drag Models to Routes</div>
    <div class="card-sub">Drag any model below onto <span class="mono">Default</span>, <span class="mono">Planner</span>, or <span class="mono">Coder</span>. Dropping saves routing automatically.</div>
    <div class="setup-route-board" style="margin-top:12px">
      ${renderRouteSlot(host, "default", "Default", busy)}
      ${renderRouteSlot(host, "planning", "Planner", busy)}
      ${renderRouteSlot(host, "coding", "Coder", busy)}
    </div>
    <div class="setup-model-pool" style="margin-top:12px">
      ${models.length > 0
        ? models
            .map((entry) => `<div class="setup-model-token ${entry.enabled ? "" : "disabled"}" draggable="${busy ? "false" : "true"}" data-routing-provider="${escapeHtml(entry.provider)}" data-routing-model="${escapeHtml(entry.model)}">
              <div class="setup-model-token__provider mono">${escapeHtml(entry.provider)}</div>
              <div class="setup-model-token__model">${escapeHtml(entry.model)}</div>
              <div class="setup-model-token__meta muted">${entry.enabled ? "enabled" : "disabled"}</div>
            </div>`)
            .join("")
        : `<div class="muted">No provider models found yet. Add a provider first.</div>`}
    </div>
  </div>`;
}

function renderProviderSection(host: T560App, busy: boolean): string {
  const selectedCatalog = host.setupCatalog.find((entry) => entry.id === host.setupSelectedProvider);
  const selectedProviderState = host.setupProviders[host.setupSelectedProvider];

  return `<div class="settings-grid">
    <div class="card">
      <div class="card-title">Quick Setup</div>
      <div class="card-sub">1. Pick provider. 2. Click <span class="mono">Use Provider</span>. 3. Pick model + auth. 4. Add key/token. 5. Save provider. 6. Drag model to Default/Planner/Coder.</div>
    </div>

    ${renderRoutingDnDCard(host, busy)}

    <div class="card">
      <div class="card-title">Add or Update Provider</div>
      <div class="card-sub">Pick provider, pick model, then add auth.</div>
      <div class="form-grid" style="margin-top:12px">
        <label class="field">
          <span>Provider</span>
          <select data-input="setup-new-provider-template" ${busy ? "disabled" : ""}>${renderTemplateOptions(host)}</select>
        </label>
        <label class="field">
          <span>Editing provider</span>
          <select data-input="setup-provider-id" ${busy ? "disabled" : ""}>${renderProviderOptions(host)}</select>
        </label>
      </div>
      <div class="settings-actions" style="margin-top:12px">
        <button class="btn primary" data-action="start-setup-provider-draft" ${busy ? "disabled" : ""}>Use Provider</button>
      </div>
      <div class="form-grid" style="margin-top:12px">
        <label class="field">
          <span>Model</span>
          <select data-input="setup-provider-model-choice" ${busy ? "disabled" : ""}>${renderProviderModelOptions(host)}</select>
        </label>
        <label class="field">
          <span>Auth mode</span>
          <select data-input="setup-provider-auth" ${busy ? "disabled" : ""}>${renderAuthModeOptions(host)}</select>
        </label>
        <label class="field">
          <span>Base URL (optional)</span>
          <input type="text" data-input="setup-provider-base-url" value="${escapeHtml(host.setupProviderBaseUrl)}" placeholder="https://api.openai.com/v1" ${busy ? "disabled" : ""} />
        </label>
        <label class="field">
          <span>API mode (optional)</span>
          <input type="text" data-input="setup-provider-api" value="${escapeHtml(host.setupProviderApi)}" placeholder="openai-responses" ${busy ? "disabled" : ""} />
        </label>
        <label class="field full">
          <span>${host.setupProviderAuthMode === "oauth" ? "OAuth token" : host.setupProviderAuthMode === "token" ? "Provider token" : "API key"} (only when changing)</span>
          <input type="password" data-input="setup-provider-credential" value="${escapeHtml(host.setupProviderCredential)}" placeholder="${host.setupProviderAuthMode === "oauth" ? "paste oauth token" : host.setupProviderAuthMode === "token" ? "paste provider token" : "paste api key"}" ${busy ? "disabled" : ""} />
        </label>
        <label class="field">
          <span>Enabled</span>
          <select data-input="setup-provider-enabled" ${busy ? "disabled" : ""}>
            <option value="true" ${host.setupProviderEnabled ? "selected" : ""}>Enabled</option>
            <option value="false" ${!host.setupProviderEnabled ? "selected" : ""}>Disabled</option>
          </select>
        </label>
      </div>
      <details style="margin-top:10px">
        <summary class="muted" style="cursor:pointer">Advanced: model list</summary>
        <div class="form-grid" style="margin-top:8px">
          <label class="field">
            <span>Base URL (optional)</span>
            <input type="text" data-input="setup-provider-base-url" value="${escapeHtml(host.setupProviderBaseUrl)}" placeholder="https://api.openai.com/v1" ${busy ? "disabled" : ""} />
          </label>
          <label class="field">
            <span>API mode (optional)</span>
            <input type="text" data-input="setup-provider-api" value="${escapeHtml(host.setupProviderApi)}" placeholder="openai-responses" ${busy ? "disabled" : ""} />
          </label>
        </div>
        <label class="field full" style="margin-top:8px">
          <span>Models (comma separated)</span>
          <input type="text" data-input="setup-provider-models" value="${escapeHtml(host.setupProviderModels)}" ${busy ? "disabled" : ""} />
        </label>
      </details>
      <div class="callout info" style="margin-top:12px">
        ${selectedProviderState?.hasCredential ? "Credential is configured for this provider." : "No credential saved for this provider yet."}
        ${selectedCatalog?.description ? ` ${escapeHtml(selectedCatalog.description)}` : ""}
      </div>
      <div class="settings-actions" style="margin-top:12px">
        <button class="btn primary" data-action="save-setup-provider" ${busy ? "disabled" : ""}>Save Provider</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Configured Providers</div>
      <div class="card-sub">Remove providers or quick-assign route slots from provider defaults.</div>
      <div style="margin-top:12px">
        ${renderProviderCards(host, busy)}
      </div>
    </div>
  </div>`;
}

function renderRoutingSection(host: T560App, busy: boolean): string {
  return `<div class="card">
    <div class="card-title">Model Routing</div>
    <div class="card-sub">Set default, planning, and coding routes directly. Provider cards can also assign these in one click.</div>
    <div class="setup-routing-grid" style="margin-top:12px">
      <div class="setup-routing-row">
        <div class="muted">Default</div>
        <select data-input="setup-routing-default-provider" ${busy ? "disabled" : ""}>${renderRoutingProviderOptions(host, host.setupRoutingDefaultProvider)}</select>
        <input type="text" data-input="setup-routing-default-model" value="${escapeHtml(host.setupRoutingDefaultModel)}" placeholder="model id" ${busy ? "disabled" : ""} />
      </div>
      <div class="setup-routing-row">
        <div class="muted">Planning</div>
        <select data-input="setup-routing-planning-provider" ${busy ? "disabled" : ""}>${renderRoutingProviderOptions(host, host.setupRoutingPlanningProvider)}</select>
        <input type="text" data-input="setup-routing-planning-model" value="${escapeHtml(host.setupRoutingPlanningModel)}" placeholder="model id" ${busy ? "disabled" : ""} />
      </div>
      <div class="setup-routing-row">
        <div class="muted">Coding</div>
        <select data-input="setup-routing-coding-provider" ${busy ? "disabled" : ""}>${renderRoutingProviderOptions(host, host.setupRoutingCodingProvider)}</select>
        <input type="text" data-input="setup-routing-coding-model" value="${escapeHtml(host.setupRoutingCodingModel)}" placeholder="model id" ${busy ? "disabled" : ""} />
      </div>
    </div>
    <div class="settings-actions" style="margin-top:12px">
      <button class="btn primary" data-action="save-setup-routing" ${busy ? "disabled" : ""}>Save Routing</button>
    </div>
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
  if (host.setupSection === "provider") {
    sectionContent = renderProviderSection(host, busy);
  } else if (host.setupSection === "routing") {
    sectionContent = renderRoutingSection(host, busy);
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
        <div class="page-title">Setup Wizard</div>
        <div class="page-sub">Manage providers, routing, Telegram, vault, and onboarding files from one place.</div>
      </div>
      <div class="settings-actions">
        <button class="btn" data-action="refresh-setup" ${busy ? "disabled" : ""}>${icons.activity} Refresh</button>
      </div>
    </div>

    ${renderOnboardingCard(host)}
    ${renderSetupNotice(host)}
    ${renderSectionNav(host, busy)}

    <div class="settings-grid" style="margin-top:12px">
      ${sectionContent}
    </div>
  </div>`;
}
