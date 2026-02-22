import type { T560App } from "./app.js";

const NEAR_BOTTOM_THRESHOLD = 100;

/** Check if the chat thread is scrolled near the bottom */
export function isNearBottom(host: T560App): boolean {
  const el = host.renderRoot?.querySelector?.(".chat-thread") as HTMLElement | null;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD;
}

/** Scroll the chat thread to the bottom */
export function scrollToBottom(host: T560App, smooth = false): void {
  const el = host.renderRoot?.querySelector?.(".chat-thread") as HTMLElement | null;
  if (!el) return;
  el.scrollTo({
    top: el.scrollHeight,
    behavior: smooth ? "smooth" : "instant",
  });
}

/** Setup scroll listener to track new messages badge */
export function setupScrollListener(host: T560App): void {
  const el = host.renderRoot?.querySelector?.(".chat-thread") as HTMLElement | null;
  if (!el) return;

  el.addEventListener("scroll", () => {
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD;
    if (near && host.hasNewMessages) {
      host.hasNewMessages = false;
    }
  }, { passive: true });
}

/** Called after new messages arrive — auto-scroll or show badge */
export function handleNewMessage(host: T560App): void {
  if (isNearBottom(host)) {
    requestAnimationFrame(() => scrollToBottom(host));
  } else {
    host.hasNewMessages = true;
  }
}
