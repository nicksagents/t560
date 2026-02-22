import { icons } from "../icons.js";

/** Render a copy-as-markdown button for a message */
export function renderCopyButton(rawMarkdown: string): string {
  // Encode the markdown as a data attribute for the click handler
  const encoded = btoa(encodeURIComponent(rawMarkdown));

  return `<button class="chat-copy-btn" data-copy="${encoded}" title="Copy as Markdown" aria-label="Copy message as markdown">
    <span class="chat-copy-btn__icon">
      <span class="chat-copy-btn__icon-copy">${icons.copy}</span>
      <span class="chat-copy-btn__icon-check">${icons.check}</span>
    </span>
  </button>`;
}

/** Global click handler for copy buttons — attach once to the app root */
export function setupCopyHandler(root: HTMLElement): void {
  root.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest?.(".chat-copy-btn") as HTMLElement | null;
    if (!btn) return;

    const encoded = btn.getAttribute("data-copy");
    if (!encoded) return;

    try {
      btn.setAttribute("data-copying", "1");
      const text = decodeURIComponent(atob(encoded));
      await navigator.clipboard.writeText(text);
      btn.removeAttribute("data-copying");
      btn.setAttribute("data-copied", "1");

      setTimeout(() => {
        btn.removeAttribute("data-copied");
      }, 2000);
    } catch {
      btn.removeAttribute("data-copying");
      btn.setAttribute("data-error", "1");
      setTimeout(() => {
        btn.removeAttribute("data-error");
      }, 2000);
    }
  });
}
