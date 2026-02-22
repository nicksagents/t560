import type { IconName } from "./icons.js";

export interface NavItem {
  id: string;
  label: string;
  icon: IconName;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "chat", label: "Chat", icon: "messageCircle" },
  { id: "status", label: "Status", icon: "activity" },
  { id: "settings", label: "Settings", icon: "settings" },
];

export function getNavItem(id: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.id === id);
}
