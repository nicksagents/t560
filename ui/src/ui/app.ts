import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { GatewayBrowserClient } from "./gateway.js";
import { loadSettings } from "./storage.js";
import { shortId } from "./uuid.js";
import { applyTheme, type ThemeValue } from "./theme.js";
import { connectGateway } from "./app-gateway.js";
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
import { setTheme, toggleNav, toggleThinking } from "./app-settings.js";
import { handleNewMessage, scrollToBottom, setupScrollListener } from "./app-scroll.js";
import { setupCopyHandler } from "./chat/copy-as-markdown.js";
import { renderApp } from "./app-render.js";
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
  @state() activeTab = "chat";
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

  // Server state
  @state() serverStatus: any = null;
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

  // Settings (loaded from localStorage)
  settings = loadSettings();

  private previousMessageCount = 0;
  private isComposing = false;
  private chatDraft = "";

  connectedCallback() {
    super.connectedCallback();

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

  updated(changed: Map<string, unknown>) {
    // Auto-scroll when new messages arrive
    if (changed.has("chatMessages")) {
      if (this.chatMessages.length > this.previousMessageCount) {
        handleNewMessage(this);
      }
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

    // Re-setup scroll listener when switching to chat
    if (changed.has("activeTab")) {
      requestAnimationFrame(() => setupScrollListener(this));
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
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
      switch (action) {
        case "toggle-nav":
          toggleNav(this);
          break;
        case "nav": {
          const tab = actionEl.getAttribute("data-tab");
          if (tab) {
            this.activeTab = tab;
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
        case "toggle-thinking":
          toggleThinking(this);
          break;
        case "scroll-bottom":
          scrollToBottom(this, true);
          this.hasNewMessages = false;
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
