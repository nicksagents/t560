import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { GatewayBrowserClient } from "./gateway.js";
import { loadSettings } from "./storage.js";
import { shortId } from "./uuid.js";
import { applyTheme, type ThemeValue } from "./theme.js";
import { connectGateway, injectAssistantNote, reloadChatHistory } from "./app-gateway.js";
import { sendMessage, abortChat } from "./app-chat.js";
import type { BootstrapContextFile, SettingsNotice } from "./app-config.js";
import {
  formatConfigDraft,
  loadDashboardSettings,
  saveBootstrapDraft,
  saveConfigDraft,
  saveProfileDraft,
  selectBootstrapFile,
  updateSelectedBootstrapDraft,
  updateSettingsDraft,
} from "./app-config.js";
import type { SetupProviderCatalogEntry, SetupProviderState, SetupVaultEntry } from "./app-setup.js";
import {
  assignSetupRouteModel,
  assignSetupRouteFromProvider,
  deleteSetupProvider,
  deleteVaultCredential,
  loadSetupState,
  refreshVault,
  saveSetupProvider,
  saveSetupRouting,
  saveSetupTelegram,
  saveVaultCredential,
  selectSetupProvider,
  startCodexOAuth,
  startSetupProviderDraft,
  submitCodexOAuthCode,
} from "./app-setup.js";
import { setTheme, toggleNav, toggleThinking } from "./app-settings.js";
import { handleNewMessage, scrollToBottom, setupScrollListener } from "./app-scroll.js";
import { setupCopyHandler } from "./chat/copy-as-markdown.js";
import { renderApp } from "./app-render.js";
import { getNavItem, pathForTab, tabFromPath } from "./navigation.js";
import {
  loadChatDraft,
  loadPersistedChatState,
  saveChatDraft,
  savePersistedChatState,
} from "./chat-storage.js";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking: string | null;
  toolCalls: string[];
  timestamp: number;
  provider?: string | null;
  model?: string | null;
}

export interface ChatAttachment {
  dataUrl: string;
  name: string;
}

export interface GatewayEventLogEntry {
  id: string;
  level: "info" | "warn" | "error";
  text: string;
  time: number;
}

@customElement("t560-app")
export class T560App extends LitElement {
  // Light DOM — no shadow boundary, CSS is global
  createRenderRoot() {
    return this;
  }

  // Connection state
  @state() connected = false;
  @state() lastError = "";
  @state() gateway: GatewayBrowserClient | null = null;

  // UI state
  @state() activeTab = tabFromPath(window.location.pathname) ?? "chat";
  @state() navCollapsed = false;
  @state() theme: ThemeValue = "dark";
  @state() showThinking = true;

  // Chat state
  @state() chatMessages: ChatMessage[] = [];
  @state() chatSending = false;
  @state() chatLoading = false;
  @state() chatQueue: string[] = [];
  @state() chatAttachments: ChatAttachment[] = [];
  @state() hasNewMessages = false;
  @state() sessionKey = "";
  @state() chatInjectDraft = "";
  @state() chatLastSyncedAt = 0;
  @state() chatHistoryReloading = false;
  @state() chatHistoryStatus = "";
  @state() chatHistoryStatusKind: "info" | "success" | "warn" = "info";

  // Server state
  @state() serverStatus: any = null;
  @state() gatewayWsUrl = "";
  @state() gatewayEventLog: GatewayEventLogEntry[] = [];
  @state() settingsLoading = false;
  @state() settingsLoaded = false;
  @state() settingsSaving = false;
  @state() settingsNotice: SettingsNotice | null = null;
  @state() soulDraft = "";
  @state() usersDraft = "";
  @state() configDraft = "{\n}\n";
  @state() configPath = "";
  @state() bootstrapFiles: BootstrapContextFile[] = [];
  @state() selectedBootstrapName = "";
  @state() bootstrapDrafts: Record<string, string> = {};

  // Setup wizard state
  @state() setupLoading = false;
  @state() setupLoaded = false;
  @state() setupSaving = false;
  @state() setupNotice: SettingsNotice | null = null;
  @state() setupCatalog: SetupProviderCatalogEntry[] = [];
  @state() setupProviders: Record<string, SetupProviderState> = {};
  @state() setupSection: "provider" | "routing" | "telegram" | "vault" | "files" = "provider";
  @state() setupSelectedProvider = "";
  @state() setupNewProviderId = "";
  @state() setupNewProviderTemplate = "";
  @state() setupProviderAuthMode = "api_key";
  @state() setupProviderModels = "";
  @state() setupProviderBaseUrl = "";
  @state() setupProviderApi = "";
  @state() setupProviderCredential = "";
  @state() setupProviderEnabled = true;
  @state() setupRoutingDefaultProvider = "";
  @state() setupRoutingDefaultModel = "";
  @state() setupRoutingPlanningProvider = "";
  @state() setupRoutingPlanningModel = "";
  @state() setupRoutingCodingProvider = "";
  @state() setupRoutingCodingModel = "";
  @state() setupTelegramToken = "";
  @state() setupTelegramHasToken = false;
  @state() setupTelegramDmPolicy = "pairing";
  @state() setupTelegramAllowFrom = "";
  @state() setupTelegramAllowedChatIds = "";
  @state() setupVaultEntries: SetupVaultEntry[] = [];
  @state() setupVaultService = "";
  @state() setupVaultIdentifier = "";
  @state() setupVaultAuthMode = "password";
  @state() setupVaultSecret = "";
  @state() setupVaultMfaCode = "";

  // Codex OAuth sign-in state
  @state() setupOAuthJobId = "";
  @state() setupOAuthUrl = "";
  @state() setupOAuthStatus: "idle" | "starting" | "awaiting_signin" | "done" | "error" = "idle";
  @state() setupOAuthError = "";
  @state() setupOAuthRedirectDraft = "";

  // Claude Code token load state (inline feedback near the Load button)
  @state() setupCcTokenStatus: "" | "loading" | "ok" | "error" = "";
  @state() setupCcTokenMessage = "";

  // Settings (loaded from localStorage)
  settings = loadSettings();

  private previousMessageCount = 0;
  private _contentScrollSave = 0;
  private _chatScrollSave = 0;
  private _chatScrollToBottom = false;
  private _chatWasNearBottom = false;
  private isComposing = false;
  private chatDraft = "";
  private readonly onPopState = () => {
    const nextTab = tabFromPath(window.location.pathname);
    if (nextTab && nextTab !== this.activeTab) {
      this.activeTab = nextTab;
    }
  };

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("popstate", this.onPopState);

    // Apply saved settings
    this.theme = this.settings.theme;
    this.navCollapsed = this.settings.navCollapsed;
    this.showThinking = this.settings.showThinking;
    this.sessionKey = this.settings.sessionKey || "";
    const persisted = loadPersistedChatState();
    if (persisted.messages.length > 0) {
      this.chatMessages = persisted.messages;
      this.previousMessageCount = persisted.messages.length;
    }
    if (persisted.queue.length > 0) {
      this.chatQueue = persisted.queue;
    }
    if (!this.sessionKey && persisted.sessionKey) {
      this.sessionKey = persisted.sessionKey;
    }
    if (!this.sessionKey) {
      this.sessionKey = shortId();
    }
    this.chatDraft = loadChatDraft();

    // Apply theme immediately
    applyTheme(this.theme);

    // Listen for system theme changes
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      if (this.theme === "system") {
        applyTheme("system");
      }
    });

    // Connect to gateway
    connectGateway(this);
    document.title = `${getNavItem(this.activeTab)?.label ?? "t560"} · t560`;

    if (this.activeTab === "setup") {
      void loadSetupState(this);
      if (this.setupSection === "files") {
        void loadDashboardSettings(this);
      }
    } else if (this.activeTab === "settings") {
      void loadDashboardSettings(this);
    }
  }

  firstUpdated() {
    // Setup event delegation
    this.setupEventHandlers();
    setupCopyHandler(this);
    setupScrollListener(this);

    // Restore in-progress draft and only autofocus on desktop-like devices.
    requestAnimationFrame(() => {
      const textarea = this.querySelector("[data-input='chat']") as HTMLTextAreaElement | null;
      if (!textarea) return;
      if (this.chatDraft) {
        textarea.value = this.chatDraft;
        textarea.style.height = "40px";
        textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
      }
      if (this.shouldAutoFocusChat()) {
        textarea.focus();
      }
    });
  }

  override willUpdate(changed: Map<string | symbol, unknown>): void {
    // Capture chat-thread scroll state BEFORE unsafeHTML replaces the DOM.
    // isNearBottom must be checked here, not in updated(), because the new
    // .chat-thread element starts at scrollTop=0 after each re-render.
    if (this.activeTab === "chat") {
      const thread = this.querySelector(".chat-thread") as HTMLElement | null;
      if (thread) {
        this._chatScrollSave = thread.scrollTop;
      }
      if (changed.has("chatMessages") && this.chatMessages.length > this.previousMessageCount) {
        const nearBottom = !thread ||
          thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
        this._chatWasNearBottom = nearBottom;
        if (nearBottom) this._chatScrollToBottom = true;
      }
    }
  }

  updated(changed: Map<string, unknown>) {
    // Chat scroll restoration — runs after every render while in chat tab.
    // unsafeHTML recreates .chat-thread from scratch (scrollTop=0) on every
    // state change, so we must restore the position here.
    if (this.activeTab === "chat") {
      const thread = this.querySelector(".chat-thread") as HTMLElement | null;
      if (thread) {
        if (this._chatScrollToBottom) {
          thread.scrollTo({ top: thread.scrollHeight, behavior: "instant" });
          this._chatScrollToBottom = false;
        } else {
          thread.scrollTop = this._chatScrollSave;
        }
      }
      // Re-attach scroll listener to the newly created .chat-thread element.
      setupScrollListener(this);
    }

    // Show new-messages badge when user is scrolled up and new messages arrive.
    if (changed.has("chatMessages")) {
      if (this.chatMessages.length > this.previousMessageCount && !this._chatWasNearBottom) {
        this.hasNewMessages = true;
      }
      this._chatWasNearBottom = false;
      this.previousMessageCount = this.chatMessages.length;
    }

    if (changed.has("chatMessages") || changed.has("chatQueue") || changed.has("sessionKey")) {
      savePersistedChatState({
        sessionKey: this.sessionKey,
        messages: this.chatMessages,
        queue: this.chatQueue,
      });
    }

    // Re-focus textarea after render if on chat tab
    if (changed.has("activeTab") && this.activeTab === "chat") {
      this.focusChatTextarea();
    }

    if (changed.has("activeTab")) {
      const title = getNavItem(this.activeTab)?.label ?? "t560";
      document.title = `${title} · t560`;
    }

    // Restore scroll position on setup/settings pages after every re-render.
    // unsafeHTML replaces the entire .content DOM node on each render, resetting
    // scrollTop to 0. We restore from _contentScrollSave which is captured before
    // each action (click or input) that triggers a state change.
    if (this.activeTab === "setup" || this.activeTab === "settings") {
      const content = this.querySelector(".content") as HTMLElement | null;
      if (content) {
        content.scrollTop = this._contentScrollSave;
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("popstate", this.onPopState);
    if (this.gateway) {
      this.gateway.close();
      this.gateway = null;
    }
  }

  render() {
    return html`${unsafeHTML(renderApp(this))}`;
  }

  /** Expose sendMessage for app-chat module */
  sendMessage(text: string) {
    sendMessage(this, text);
  }

  private setActiveTab(tab: string, options?: { pushHistory?: boolean }) {
    this.activeTab = tab;
    if (options?.pushHistory) {
      const nextPath = pathForTab(tab);
      if (window.location.pathname !== nextPath) {
        window.history.pushState({ tab }, "", nextPath);
      }
    }
  }

  private shouldAutoFocusChat(): boolean {
    return window.matchMedia("(pointer: fine) and (min-width: 901px)").matches;
  }

  private focusChatTextarea(): void {
    if (!this.shouldAutoFocusChat()) return;
    requestAnimationFrame(() => {
      const textarea = this.querySelector("[data-input='chat']") as HTMLTextAreaElement | null;
      if (textarea && document.activeElement !== textarea) {
        textarea.focus();
      }
    });
  }

  private setupEventHandlers() {
    // Event delegation for all interactive elements
    this.addEventListener("click", (e: Event) => {
      const target = e.target as HTMLElement;
      const actionEl = target.closest("[data-action]") as HTMLElement | null;
      if (!actionEl) return;

      const action = actionEl.getAttribute("data-action");

      // Save scroll position before any action on pages that re-render fully via unsafeHTML.
      // We restore it in updated() after every render so async actions don't lose position.
      if (this.activeTab === "setup" || this.activeTab === "settings") {
        this._contentScrollSave = (this.querySelector(".content") as HTMLElement | null)?.scrollTop ?? 0;
      }

      switch (action) {
        case "toggle-nav":
          toggleNav(this);
          break;
        case "nav": {
          const tab = actionEl.getAttribute("data-tab");
          if (tab) {
            this._contentScrollSave = 0; // always start new page at top
            this.setActiveTab(tab, { pushHistory: true });
            if (tab === "setup") {
              void loadSetupState(this);
              if (this.setupSection === "files") {
                void loadDashboardSettings(this);
              }
            }
            if (tab === "settings") {
              void loadDashboardSettings(this);
            }
          }
          break;
        }
        case "set-theme": {
          const theme = actionEl.getAttribute("data-theme") as ThemeValue;
          if (theme) setTheme(this, theme, e as MouseEvent);
          break;
        }
        case "send": {
          const textarea = this.querySelector("[data-input='chat']") as HTMLTextAreaElement | null;
          if (textarea?.value.trim()) {
            this.sendMessage(textarea.value);
            textarea.value = "";
            textarea.style.height = "40px";
            saveChatDraft("");
          }
          break;
        }
        case "abort":
          abortChat(this);
          break;
        case "new-chat-session":
          this.sessionKey = shortId();
          this.chatMessages = [];
          this.chatQueue = [];
          this.chatAttachments = [];
          this.hasNewMessages = false;
          break;
        case "clear-chat-view":
          this.chatMessages = [];
          this.chatQueue = [];
          this.chatAttachments = [];
          this.hasNewMessages = false;
          break;
        case "reconnect-gateway":
          connectGateway(this);
          break;
        case "refresh-chat-history":
          void reloadChatHistory(this);
          break;
        case "inject-assistant-note":
          void injectAssistantNote(this, this.chatInjectDraft);
          this.chatInjectDraft = "";
          break;
        case "clear-event-log":
          this.gatewayEventLog = [];
          break;
        case "toggle-thinking":
          toggleThinking(this);
          break;
        case "scroll-bottom":
          // Clear badge and flag scroll-to-bottom; willUpdate/updated() will
          // scroll the newly created .chat-thread after the re-render.
          this.hasNewMessages = false;
          this._chatScrollToBottom = true;
          break;
        case "remove-attachment": {
          const idx = parseInt(actionEl.getAttribute("data-index") ?? "0", 10);
          this.chatAttachments = this.chatAttachments.filter((_, i) => i !== idx);
          break;
        }
        case "remove-queue": {
          const idx = parseInt(actionEl.getAttribute("data-index") ?? "0", 10);
          this.chatQueue = this.chatQueue.filter((_, i) => i !== idx);
          break;
        }
        case "refresh-settings":
          void loadDashboardSettings(this, true);
          break;
        case "save-soul":
          void saveProfileDraft(this, "soul");
          break;
        case "save-users":
          void saveProfileDraft(this, "users");
          break;
        case "format-config":
          formatConfigDraft(this);
          break;
        case "save-config":
          void saveConfigDraft(this);
          break;
        case "select-bootstrap-file": {
          const name = actionEl.getAttribute("data-name");
          if (name) {
            selectBootstrapFile(this, name);
          }
          break;
        }
        case "save-bootstrap-file":
          void saveBootstrapDraft(this);
          break;
        case "refresh-setup":
          void loadSetupState(this, true);
          break;
        case "save-setup-provider":
          void saveSetupProvider(this);
          break;
        case "start-setup-provider-draft":
          startSetupProviderDraft(this);
          break;
        case "delete-setup-provider": {
          const provider = actionEl.getAttribute("data-provider");
          if (provider) {
            void deleteSetupProvider(this, provider);
          }
          break;
        }
        case "assign-setup-route-provider": {
          const provider = actionEl.getAttribute("data-provider");
          const slot = actionEl.getAttribute("data-slot");
          if (
            provider &&
            (slot === "default" || slot === "planning" || slot === "coding")
          ) {
            void assignSetupRouteFromProvider(this, slot, provider);
          }
          break;
        }
        case "tap-assign-route": {
          const slot = actionEl.getAttribute("data-slot");
          const provider = actionEl.getAttribute("data-provider") ?? "";
          const model = actionEl.getAttribute("data-model") ?? "";
          if (provider && model && (slot === "default" || slot === "planning" || slot === "coding")) {
            void assignSetupRouteModel(this, slot, provider, model);
          }
          break;
        }
        case "select-setup-provider": {
          const provider = actionEl.getAttribute("data-provider");
          if (provider) {
            selectSetupProvider(this, provider);
            // Sync the provider-type dropdown so the form reflects what's loaded
            this.setupNewProviderTemplate = provider;
          }
          break;
        }
        case "save-setup-routing":
          void saveSetupRouting(this);
          break;
        case "save-setup-telegram":
          void saveSetupTelegram(this);
          break;
        case "save-vault-credential":
          void saveVaultCredential(this);
          break;
        case "refresh-vault":
          void refreshVault(this);
          break;
        case "start-codex-oauth":
          void startCodexOAuth(this);
          break;
        case "submit-codex-oauth-code":
          void submitCodexOAuthCode(this);
          break;
        case "reset-codex-oauth":
          this.setupOAuthStatus = "idle";
          this.setupOAuthJobId = "";
          this.setupOAuthUrl = "";
          this.setupOAuthError = "";
          this.setupOAuthRedirectDraft = "";
          break;
        case "add-setup-provider":
          this.setupSelectedProvider = "__new__";
          this.setupNewProviderTemplate = "";
          this.setupNewProviderId = "";
          this.setupProviderCredential = "";
          this.setupProviderModels = "";
          this.setupProviderBaseUrl = "";
          this.setupProviderApi = "";
          this.setupProviderEnabled = true;
          this.setupProviderAuthMode = "api_key";
          this.setupOAuthStatus = "idle";
          this.setupOAuthJobId = "";
          this.setupOAuthUrl = "";
          this.setupOAuthError = "";
          this.setupOAuthRedirectDraft = "";
          this.setupCcTokenStatus = "";
          this.setupCcTokenMessage = "";
          break;
        case "cancel-setup-provider":
          this.setupSelectedProvider = "";
          this.setupOAuthStatus = "idle";
          this.setupOAuthJobId = "";
          this.setupOAuthUrl = "";
          this.setupOAuthError = "";
          this.setupCcTokenStatus = "";
          this.setupCcTokenMessage = "";
          break;
        case "fetch-cc-token":
          void (async () => {
            if (this.setupLoading || this.setupSaving) return;
            this.setupCcTokenStatus = "loading";
            this.setupCcTokenMessage = "";
            try {
              const res = await fetch("/api/setup/cc-token");
              const data = await res.json() as { ok: boolean; token?: string; expiresAt?: number; error?: string };
              if (data.ok && data.token) {
                this.setupProviderCredential = data.token;
                const expiry = data.expiresAt && data.expiresAt > 0
                  ? ` Expires ${new Date(data.expiresAt).toLocaleDateString()}.`
                  : "";
                this.setupCcTokenStatus = "ok";
                this.setupCcTokenMessage = `Token loaded.${expiry} Click Save Provider to apply.`;
              } else {
                this.setupCcTokenStatus = "error";
                this.setupCcTokenMessage = data.error ?? "Could not load token.";
              }
            } catch {
              this.setupCcTokenStatus = "error";
              this.setupCcTokenMessage = "Request failed — server may not be running.";
            }
          })();
          break;
        case "select-setup-section": {
          const section = actionEl.getAttribute("data-section");
          if (
            section === "provider" ||
            section === "routing" ||
            section === "telegram" ||
            section === "vault" ||
            section === "files"
          ) {
            this._contentScrollSave = 0; // scroll to top when switching sections
            this.setupSection = section;
            if (section === "files") {
              void loadDashboardSettings(this);
            }
          }
          break;
        }
        case "delete-vault-credential": {
          const service = actionEl.getAttribute("data-service");
          if (service) {
            void deleteVaultCredential(this, service);
          }
          break;
        }
      }

    });

    this.addEventListener("dragstart", (e: Event) => {
      const event = e as DragEvent;
      const target = event.target as HTMLElement | null;
      if (!target || !event.dataTransfer) {
        return;
      }
      const item = target.closest("[data-routing-provider][data-routing-model]") as HTMLElement | null;
      if (!item) {
        return;
      }
      const provider = item.getAttribute("data-routing-provider")?.trim() ?? "";
      const model = item.getAttribute("data-routing-model")?.trim() ?? "";
      if (!provider || !model) {
        return;
      }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", JSON.stringify({ provider, model }));
      item.classList.add("dragging");
    });

    this.addEventListener("dragend", (e: Event) => {
      const target = e.target as HTMLElement | null;
      const item = target?.closest("[data-routing-provider][data-routing-model]") as HTMLElement | null;
      if (item) {
        item.classList.remove("dragging");
      }
      const zones = this.querySelectorAll("[data-route-slot].drag-over");
      zones.forEach((zone) => zone.classList.remove("drag-over"));
    });

    this.addEventListener("dragover", (e: Event) => {
      const event = e as DragEvent;
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }
      const zone = target.closest("[data-route-slot]") as HTMLElement | null;
      if (!zone) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      zone.classList.add("drag-over");
    });

    this.addEventListener("dragleave", (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target) {
        return;
      }
      const zone = target.closest("[data-route-slot]") as HTMLElement | null;
      if (!zone) {
        return;
      }
      zone.classList.remove("drag-over");
    });

    this.addEventListener("drop", (e: Event) => {
      const event = e as DragEvent;
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }
      const zone = target.closest("[data-route-slot]") as HTMLElement | null;
      if (!zone) {
        return;
      }
      event.preventDefault();
      zone.classList.remove("drag-over");

      const slot = zone.getAttribute("data-route-slot");
      if (slot !== "default" && slot !== "planning" && slot !== "coding") {
        return;
      }
      const raw = event.dataTransfer?.getData("text/plain")?.trim() ?? "";
      if (!raw) {
        return;
      }
      try {
        const parsed = JSON.parse(raw) as { provider?: string; model?: string };
        const provider = String(parsed.provider ?? "").trim();
        const model = String(parsed.model ?? "").trim();
        if (!provider || !model) {
          return;
        }
        void assignSetupRouteModel(this, slot, provider, model);
      } catch {
        // ignore malformed drag payload
      }
    });

    // Keyboard handler for textarea
    this.addEventListener("keydown", (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.getAttribute("data-input") !== "chat") return;

      const textarea = target as HTMLTextAreaElement;

      // IME composition handling
      if (e.isComposing || e.keyCode === 229) return;

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (textarea.value.trim()) {
          this.sendMessage(textarea.value);
          textarea.value = "";
          textarea.style.height = "40px";
          saveChatDraft("");
        }
      }

      // Escape to clear
      if (e.key === "Escape") {
        textarea.value = "";
        textarea.style.height = "40px";
        saveChatDraft("");
      }
    });

    // Auto-resize textarea
    this.addEventListener("input", (e: Event) => {
      const target = e.target as HTMLElement;
      const inputName = target.getAttribute("data-input");
      if (!inputName) return;

      // Save scroll position on setup/settings pages so typing in a form field
      // doesn't cause the page to scroll back to top after each re-render.
      if (inputName !== "chat" && (this.activeTab === "setup" || this.activeTab === "settings")) {
        this._contentScrollSave = (this.querySelector(".content") as HTMLElement | null)?.scrollTop ?? this._contentScrollSave;
      }

      const textarea = target as HTMLTextAreaElement;

      if (inputName === "chat") {
        textarea.style.height = "40px";
        textarea.style.height = Math.min(textarea.scrollHeight, 150) + "px";
        saveChatDraft(textarea.value);
        return;
      }

      if (inputName === "soul-draft") {
        updateSettingsDraft(this, "soul", textarea.value);
        return;
      }
      if (inputName === "users-draft") {
        updateSettingsDraft(this, "users", textarea.value);
        return;
      }
      if (inputName === "config-draft") {
        updateSettingsDraft(this, "config", textarea.value);
        return;
      }
      if (inputName === "bootstrap-draft") {
        updateSelectedBootstrapDraft(this, textarea.value);
        return;
      }
      if (inputName === "setup-provider-id") {
        selectSetupProvider(this, textarea.value);
        return;
      }
      if (inputName === "setup-new-provider-id") {
        this.setupNewProviderId = textarea.value;
        return;
      }
      if (inputName === "setup-new-provider-template") {
        this.setupNewProviderTemplate = textarea.value.trim();
        // Auto-apply the template so the model list and auth options update
        // immediately — only when a real template is selected.
        if (this.setupNewProviderTemplate) {
          startSetupProviderDraft(this);
        }
        return;
      }
      if (inputName === "setup-provider-auth") {
        this.setupProviderAuthMode = textarea.value.trim();
        return;
      }
      if (inputName === "setup-provider-models") {
        this.setupProviderModels = textarea.value;
        return;
      }
      if (inputName === "setup-provider-model-choice") {
        this.setupProviderModels = textarea.value.trim();
        return;
      }
      if (inputName === "setup-provider-base-url") {
        this.setupProviderBaseUrl = textarea.value;
        return;
      }
      if (inputName === "setup-provider-api") {
        this.setupProviderApi = textarea.value;
        return;
      }
      if (inputName === "setup-provider-credential") {
        this.setupProviderCredential = textarea.value;
        return;
      }
      if (inputName === "setup-provider-enabled") {
        this.setupProviderEnabled = textarea.value === "true";
        return;
      }
      if (inputName === "setup-role-default") {
        const [provider = "", model = ""] = textarea.value.split("::");
        this.setupRoutingDefaultProvider = provider;
        this.setupRoutingDefaultModel = model;
        if (provider && model) void assignSetupRouteModel(this, "default", provider, model);
        return;
      }
      if (inputName === "setup-role-planning") {
        const [provider = "", model = ""] = textarea.value.split("::");
        this.setupRoutingPlanningProvider = provider;
        this.setupRoutingPlanningModel = model;
        if (provider && model) void assignSetupRouteModel(this, "planning", provider, model);
        return;
      }
      if (inputName === "setup-role-coding") {
        const [provider = "", model = ""] = textarea.value.split("::");
        this.setupRoutingCodingProvider = provider;
        this.setupRoutingCodingModel = model;
        if (provider && model) void assignSetupRouteModel(this, "coding", provider, model);
        return;
      }
      if (inputName === "setup-telegram-token") {
        this.setupTelegramToken = textarea.value;
        return;
      }
      if (inputName === "setup-telegram-dm-policy") {
        this.setupTelegramDmPolicy = textarea.value;
        return;
      }
      if (inputName === "setup-telegram-allow-from") {
        this.setupTelegramAllowFrom = textarea.value;
        return;
      }
      if (inputName === "setup-telegram-allowed-chat-ids") {
        this.setupTelegramAllowedChatIds = textarea.value;
        return;
      }
      if (inputName === "setup-vault-service") {
        this.setupVaultService = textarea.value;
        return;
      }
      if (inputName === "setup-vault-identifier") {
        this.setupVaultIdentifier = textarea.value;
        return;
      }
      if (inputName === "setup-vault-auth-mode") {
        this.setupVaultAuthMode = textarea.value;
        return;
      }
      if (inputName === "setup-vault-secret") {
        this.setupVaultSecret = textarea.value;
        return;
      }
      if (inputName === "setup-vault-mfa-code") {
        this.setupVaultMfaCode = textarea.value;
        return;
      }
      if (inputName === "setup-oauth-redirect") {
        this.setupOAuthRedirectDraft = textarea.value;
        return;
      }
      if (inputName === "chat-inject-draft") {
        this.chatInjectDraft = textarea.value;
      }
    });

    // Image paste support
    this.addEventListener("paste", (e: ClipboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.getAttribute("data-input") !== "chat") return;

      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;

          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            this.chatAttachments = [
              ...this.chatAttachments,
              { dataUrl, name: file.name || "pasted-image" },
            ];
          };
          reader.readAsDataURL(file);
          break;
        }
      }
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "t560-app": T560App;
  }
}
