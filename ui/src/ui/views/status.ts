import type { T560App } from "../app.js";
import { escapeHtml } from "../markdown.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Render the status view */
export function renderStatusView(host: T560App): string {
  const status = asRecord(host.serverStatus);
  const usage = asRecord(status.usage);
  const usageTotals = asRecord(usage.totals);
  const usageBudget = asRecord(usage.budget);
  const quota = asRecord(usage.quota);

  const modeValue = typeof status.mode === "string" ? status.mode : "—";
  const providerValue = typeof status.provider === "string" ? status.provider : "—";
  const modelValue = typeof status.model === "string" ? status.model : "—";
  const onboardingRequired = status.onboardingRequired === true;
  const missing = Array.isArray(status.missing)
    ? status.missing.map((item) => String(item)).filter(Boolean)
    : [];

  const statCards = [
    { label: "Connection", value: host.connected ? "Online" : "Offline", cls: host.connected ? "ok" : "warn" },
    { label: "Mode", value: modeValue, cls: "" },
    { label: "Provider", value: providerValue, cls: "" },
    { label: "Model", value: modelValue, cls: "" },
  ];

  const statGridHtml = statCards.map((s) =>
    `<div class="stat stat-card">
      <div class="stat-label">${s.label}</div>
      <div class="stat-value ${s.cls}">${s.value}</div>
    </div>`
  ).join("");

  // Config details if available
  const config = asRecord(status.config);
  const configEntries = Object.entries(config);
  const configHtml = configEntries.length > 0
    ? `<div class="card">
        <div class="card-title">Configuration</div>
        <div class="status-list" style="margin-top:12px">
          ${configEntries.map(([k, v]) =>
            `<div><span class="muted">${k}</span><span class="mono">${String(v)}</span></div>`
          ).join("")}
        </div>
      </div>`
    : "";

  const totalTokens = Number(usageTotals.totalTokens ?? 0) || 0;
  const inputTokens = Number(usageTotals.inputTokens ?? 0) || 0;
  const outputTokens = Number(usageTotals.outputTokens ?? 0) || 0;
  const costUsd = Number(usageTotals.costUsd ?? 0) || 0;
  const tokenBudget = usageBudget.tokenBudget == null ? null : Number(usageBudget.tokenBudget);
  const tokensRemaining = usageBudget.tokensRemaining == null ? null : Number(usageBudget.tokensRemaining);
  const costBudgetUsd = usageBudget.costBudgetUsd == null ? null : Number(usageBudget.costBudgetUsd);
  const costRemainingUsd = usageBudget.costRemainingUsd == null ? null : Number(usageBudget.costRemainingUsd);
  const quotaMessage =
    typeof quota.message === "string" && quota.message.trim()
      ? quota.message.trim()
      : "Provider quota remaining is unavailable.";
  const usageNote =
    typeof usage.note === "string" && usage.note.trim()
      ? usage.note.trim()
      : "";

  const usageHtml = `<div class="card" style="margin-top:16px">
    <div class="card-title">Usage (Local Estimate)</div>
    <div class="card-sub">Saved-session token and cost totals from this t560 instance.</div>
    <div class="status-list" style="margin-top:12px">
      <div><span class="muted">Input tokens</span><span class="mono">${inputTokens.toLocaleString()}</span></div>
      <div><span class="muted">Output tokens</span><span class="mono">${outputTokens.toLocaleString()}</span></div>
      <div><span class="muted">Total tokens</span><span class="mono">${totalTokens.toLocaleString()}</span></div>
      <div><span class="muted">Estimated cost (USD)</span><span class="mono">$${costUsd.toFixed(6)}</span></div>
      <div><span class="muted">Token budget</span><span class="mono">${tokenBudget == null ? "not set" : tokenBudget.toLocaleString()}</span></div>
      <div><span class="muted">Tokens remaining</span><span class="mono">${tokensRemaining == null ? "unknown" : tokensRemaining.toLocaleString()}</span></div>
      <div><span class="muted">Cost budget (USD)</span><span class="mono">${costBudgetUsd == null ? "not set" : `$${costBudgetUsd.toFixed(2)}`}</span></div>
      <div><span class="muted">Cost remaining</span><span class="mono">${costRemainingUsd == null ? "unknown" : `$${costRemainingUsd.toFixed(2)}`}</span></div>
    </div>
    <div class="callout info" style="margin-top:12px">${escapeHtml(quotaMessage)}</div>
    ${usageNote ? `<div class="muted" style="margin-top:8px;font-size:12px">${escapeHtml(usageNote)}</div>` : ""}
  </div>`;

  // Onboarding status
  const onboardingHtml = onboardingRequired
    ? `<div class="callout danger" style="margin-top:16px">
        <strong>Onboarding required</strong>
        ${missing.length ? `<div style="margin-top:6px">Missing: ${missing.join(", ")}</div>` : ""}
      </div>`
    : "";

  return `<div class="content">
    <div class="content-header">
      <div>
        <div class="page-title">Status</div>
        <div class="page-sub">System overview and configuration</div>
      </div>
    </div>
    <div class="stat-grid">
      ${statGridHtml}
    </div>
    ${onboardingHtml}
    ${usageHtml}
    ${configHtml}
  </div>`;
}
