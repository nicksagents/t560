/** Persisted UI settings via localStorage */
export interface UiSettings {
  theme: "dark" | "light" | "system";
  navCollapsed: boolean;
  showThinking: boolean;
  sessionKey: string;
  gatewayUrl: string;
}

const STORAGE_KEY = "t560-ui-settings";

const DEFAULTS: UiSettings = {
  theme: "dark",
  navCollapsed: false,
  showThinking: true,
  sessionKey: "",
  gatewayUrl: "",
};

export function loadSettings(): UiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: UiSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage may be full or disabled
  }
}

export function patchSettings(patch: Partial<UiSettings>): UiSettings {
  const current = loadSettings();
  const next = { ...current, ...patch };
  saveSettings(next);
  return next;
}
