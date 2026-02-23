import type { IconName } from "./icons.js";

export interface NavItem {
  id: string;
  label: string;
  subtitle: string;
  path: string;
  icon: IconName;
}

export const NAV_ITEMS: NavItem[] = [
  {
    id: "chat",
    label: "Chat",
    subtitle: "Direct conversation with t560.",
    path: "/chat",
    icon: "messageCircle",
  },
  {
    id: "setup",
    label: "Setup",
    subtitle: "Providers, routing, Telegram, and vault.",
    path: "/setup",
    icon: "checkCircle",
  },
  {
    id: "status",
    label: "Status",
    subtitle: "Runtime health, usage, and active config.",
    path: "/status",
    icon: "activity",
  },
  {
    id: "settings",
    label: "Settings",
    subtitle: "Advanced file and config editing.",
    path: "/settings",
    icon: "settings",
  },
];

export function getNavItem(id: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.id === id);
}

const PATH_TO_TAB = new Map(NAV_ITEMS.map((item) => [item.path.toLowerCase(), item.id]));

export function normalizePath(path: string): string {
  if (!path) {
    return "/";
  }
  let normalized = path.trim();
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function tabFromPath(pathname: string): string | null {
  const normalized = normalizePath(pathname).toLowerCase();
  if (normalized === "/" || normalized === "/index.html") {
    return "chat";
  }
  if (normalized === "/overview") {
    return "status";
  }
  return PATH_TO_TAB.get(normalized) ?? null;
}

export function pathForTab(tabId: string): string {
  const item = getNavItem(tabId);
  return item?.path ?? "/chat";
}
