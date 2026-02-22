import type { T560App } from "../app.js";
import { icons } from "../icons.js";
import { escapeHtml } from "../markdown.js";

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

function renderBootstrapMeta(host: T560App): string {
  const selected = host.bootstrapFiles.find((file) => file.name === host.selectedBootstrapName);
  if (!selected) {
    return `<div class="callout info" style="margin-bottom:12px">No bootstrap files available.</div>`;
  }
  const sourceLabel = selected.source || "missing";
  return `<div class="settings-meta">
    <div><span class="muted">Source:</span> <span class="mono">${escapeHtml(sourceLabel)}</span></div>
    <div><span class="muted">Path:</span> <span class="mono">${escapeHtml(selected.path || "(none)")}</span></div>
    <div><span class="muted">Chars:</span> <span class="mono">${selected.injectedChars.toLocaleString()}</span> <span class="muted">injected</span> / <span class="mono">${selected.rawChars.toLocaleString()}</span> <span class="muted">raw</span></div>
  </div>`;
}

export function renderSettingsView(host: T560App): string {
  const busy = host.settingsLoading || host.settingsSaving;
  const selectedDraft = host.selectedBootstrapName ? host.bootstrapDrafts[host.selectedBootstrapName] ?? "" : "";

  const bootstrapChips = host.bootstrapFiles
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

  return `<div class="content">
    <div class="content-header">
      <div>
        <div class="page-title">Settings</div>
        <div class="page-sub">Edit profile files, runtime config, and workspace bootstrap context.</div>
      </div>
      <div class="settings-actions">
        <button class="btn" data-action="refresh-settings" ${busy ? "disabled" : ""}>
          ${icons.activity} Refresh
        </button>
      </div>
    </div>

    ${renderSettingsNotice(host)}

    <div class="settings-grid">
      <div class="card">
        <div class="card-title">Profile Files</div>
        <div class="card-sub">These files shape agent behavior and user context.</div>
        <div class="form-grid" style="margin-top:12px">
          <label class="field full">
            <span>soul.md</span>
            <textarea class="settings-editor" data-input="soul-draft" ${busy ? "disabled" : ""}>${escapeHtml(host.soulDraft)}</textarea>
          </label>
          <div class="settings-actions">
            <button class="btn primary" data-action="save-soul" ${busy ? "disabled" : ""}>Save soul.md</button>
          </div>
          <label class="field full">
            <span>users.md</span>
            <textarea class="settings-editor" data-input="users-draft" ${busy ? "disabled" : ""}>${escapeHtml(host.usersDraft)}</textarea>
          </label>
          <div class="settings-actions">
            <button class="btn primary" data-action="save-users" ${busy ? "disabled" : ""}>Save users.md</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Runtime Config</div>
        <div class="card-sub">Path: <span class="mono">${escapeHtml(host.configPath || "(unknown)")}</span></div>
        <div class="callout info" style="margin-top:12px">Edit full JSON config directly. Invalid JSON cannot be saved.</div>
        <label class="field full" style="margin-top:12px">
          <span>config.json</span>
          <textarea class="settings-editor settings-editor--config" data-input="config-draft" ${busy ? "disabled" : ""}>${escapeHtml(host.configDraft)}</textarea>
        </label>
        <div class="settings-actions">
          <button class="btn" data-action="format-config" ${busy ? "disabled" : ""}>Format JSON</button>
          <button class="btn primary" data-action="save-config" ${busy ? "disabled" : ""}>Save config.json</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Workspace Bootstrap Files</div>
        <div class="card-sub">These are injected into the system prompt each run.</div>
        <div class="settings-chip-row" style="margin-top:12px">
          ${bootstrapChips || `<span class="muted">No bootstrap files discovered.</span>`}
        </div>
        <div style="margin-top:12px">
          ${renderBootstrapMeta(host)}
        </div>
        <label class="field full">
          <span>${host.selectedBootstrapName ? escapeHtml(host.selectedBootstrapName) : "File content"}</span>
          <textarea class="settings-editor" data-input="bootstrap-draft" ${busy || !host.selectedBootstrapName ? "disabled" : ""}>${escapeHtml(selectedDraft)}</textarea>
        </label>
        <div class="settings-actions">
          <button class="btn primary" data-action="save-bootstrap-file" ${busy || !host.selectedBootstrapName ? "disabled" : ""}>Save workspace file</button>
        </div>
      </div>
    </div>
  </div>`;
}

