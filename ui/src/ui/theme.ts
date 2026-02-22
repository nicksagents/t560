export type ThemeValue = "dark" | "light" | "system";

/** Resolve "system" to actual dark/light based on OS preference */
export function resolveTheme(theme: ThemeValue): "dark" | "light" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  return theme;
}

/** Apply theme to the document root with View Transitions API */
export function applyTheme(theme: ThemeValue, event?: MouseEvent): void {
  const resolved = resolveTheme(theme);

  const apply = () => {
    if (resolved === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  };

  // Use View Transitions API if available and event has coordinates
  if (
    event &&
    "startViewTransition" in document &&
    typeof (document as any).startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    const x = event.clientX;
    const y = event.clientY;
    document.documentElement.style.setProperty("--theme-switch-x", `${x}px`);
    document.documentElement.style.setProperty("--theme-switch-y", `${y}px`);
    document.documentElement.classList.add("theme-transition");

    (document as any).startViewTransition(() => {
      apply();
    }).finished.then(() => {
      document.documentElement.classList.remove("theme-transition");
    });
  } else {
    apply();
  }
}

/** Get the theme index for the sliding indicator (0=dark, 1=light, 2=system) */
export function themeIndex(theme: ThemeValue): number {
  switch (theme) {
    case "dark":
      return 0;
    case "light":
      return 1;
    case "system":
      return 2;
  }
}
