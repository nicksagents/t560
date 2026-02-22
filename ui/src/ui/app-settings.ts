import type { T560App } from "./app.js";
import { patchSettings } from "./storage.js";
import { applyTheme, type ThemeValue } from "./theme.js";

/** Apply a new theme and persist it */
export function setTheme(host: T560App, theme: ThemeValue, event?: MouseEvent): void {
  host.theme = theme;
  patchSettings({ theme });
  applyTheme(theme, event);
}

/** Toggle nav collapsed state and persist */
export function toggleNav(host: T560App): void {
  host.navCollapsed = !host.navCollapsed;
  patchSettings({ navCollapsed: host.navCollapsed });
}

/** Toggle thinking visibility and persist */
export function toggleThinking(host: T560App): void {
  host.showThinking = !host.showThinking;
  patchSettings({ showThinking: host.showThinking });
}

/** Update session key and persist */
export function setSessionKey(host: T560App, key: string): void {
  host.sessionKey = key;
  patchSettings({ sessionKey: key });
}
