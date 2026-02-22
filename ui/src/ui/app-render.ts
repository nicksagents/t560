import type { T560App } from "./app.js";
import { icons } from "./icons.js";
import { NAV_ITEMS } from "./navigation.js";
import { themeIndex } from "./theme.js";
import { renderChatView } from "./views/chat.js";
import { renderSettingsView } from "./views/settings.js";
import { renderStatusView } from "./views/status.js";

/** Render the full application shell */
export function renderApp(host: T560App): string {
  const shellClasses = [
    "shell",
    host.activeTab === "chat" ? "shell--chat" : "",
    host.navCollapsed ? "shell--nav-collapsed" : "",
  ].filter(Boolean).join(" ");

  const tIdx = themeIndex(host.theme);

  return `<div class="${shellClasses}">
    ${renderTopbar(host, tIdx)}
    ${renderNav(host)}
    ${renderContent(host)}
  </div>`;
}

function renderTopbar(host: T560App, tIdx: number): string {
  const statusDotClass = host.connected ? "ok" : "";

  return `<header class="topbar">
    <div class="topbar-left">
      <button class="nav-collapse-toggle" data-action="toggle-nav" title="Toggle sidebar" aria-label="Toggle navigation sidebar">
        <span class="nav-collapse-toggle__icon">${host.navCollapsed ? icons.menu : icons.panelLeft}</span>
      </button>
      <div class="brand">
        <div class="brand-text">
          <div class="brand-title">t560</div>
          <div class="brand-sub">Agent</div>
        </div>
      </div>
    </div>
    <div class="topbar-status">
      <div class="pill">
        <span class="statusDot ${statusDotClass}"></span>
        <span>${host.connected ? "Connected" : "Disconnected"}</span>
        ${host.serverStatus?.mode ? `<span class="mono">${host.serverStatus.mode}</span>` : ""}
      </div>
      <div class="theme-toggle" role="radiogroup" aria-label="Theme">
        <div class="theme-toggle__track" style="--theme-index:${tIdx}">
          <div class="theme-toggle__indicator"></div>
          <button class="theme-toggle__button ${host.theme === "dark" ? "active" : ""}" data-action="set-theme" data-theme="dark" title="Dark theme" aria-label="Dark theme">
            <svg class="theme-icon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          </button>
          <button class="theme-toggle__button ${host.theme === "light" ? "active" : ""}" data-action="set-theme" data-theme="light" title="Light theme" aria-label="Light theme">
            <svg class="theme-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          </button>
          <button class="theme-toggle__button ${host.theme === "system" ? "active" : ""}" data-action="set-theme" data-theme="system" title="System theme" aria-label="System theme">
            <svg class="theme-icon" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </button>
        </div>
      </div>
    </div>
  </header>`;
}

function renderNav(host: T560App): string {
  const navClass = host.navCollapsed ? "nav nav--collapsed" : "nav";

  const items = NAV_ITEMS.map((item) => {
    const active = host.activeTab === item.id ? " active" : "";
    return `<button class="nav-item${active}" data-action="nav" data-tab="${item.id}" aria-label="${item.label}">
      <span class="nav-item__icon">${icons[item.icon]}</span>
      <span class="nav-item__text">${item.label}</span>
    </button>`;
  }).join("");

  return `<nav class="${navClass}" aria-label="Main navigation">
    <div class="nav-group">
      <div class="nav-group__items">
        ${items}
      </div>
    </div>
  </nav>`;
}

function renderContent(host: T560App): string {
  switch (host.activeTab) {
    case "chat":
      return renderChatView(host);
    case "status":
      return renderStatusView(host);
    case "settings":
      return renderSettingsView(host);
    default:
      return renderChatView(host);
  }
}
