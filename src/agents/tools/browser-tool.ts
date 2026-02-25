import { Type } from "@mariozechner/pi-ai";
import type { AnyAgentTool } from "../pi-tools.types.js";
import { duckDuckGoSearch } from "../../web/duckduckgo_search.js";
import { chooseReadableText, decodeHtmlEntities } from "../../web/fetch.js";
import { extractEcommerceCandidates, pickCheapestCandidate } from "../ecommerce.js";
import { getCredential, listConfiguredServices, normalizeSetupService } from "../../security/credentials-vault.js";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 300_000;
const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_MAX_LINKS = 40;
const DEFAULT_SEARCH_COUNT = 8;
const DEFAULT_SCREENSHOT_WIDTH = 1440;
const DEFAULT_SCREENSHOT_HEIGHT = 900;
const DEFAULT_WAIT_MS = 1200;
const DEFAULT_ACTION_MAX_RETRIES = 1;
const LIVE_ENGINE_VIEWPORT_WIDTH = 1440;
const LIVE_ENGINE_VIEWPORT_HEIGHT = 900;
const LIVE_ENGINE_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) t560-browser-live/1.0 Safari/537.36";
const LIVE_CONSOLE_MAX_ENTRIES = 400;
const LIVE_DIALOG_MAX_EVENTS = 80;
const LIVE_DOWNLOAD_MAX_ENTRIES = 80;

type BrowserEngineMode = "fetch" | "live";

type LivePageMeta = {
  status: number;
  ok: boolean;
  contentType: string;
};

type LiveConsoleEntry = {
  time: number;
  type: string;
  text: string;
  location: string;
};

type LiveDialogPlan = {
  mode: "accept" | "dismiss";
  promptText?: string;
  once: boolean;
  armedAt: number;
};

type LiveDialogEvent = {
  time: number;
  type: string;
  message: string;
  defaultValue: string;
  handled: string;
};

type LiveDownloadEntry = {
  time: number;
  url: string;
  suggestedFilename: string;
  path: string;
  bytes: number;
  mimeType: string;
  status: "saved" | "failed";
  error?: string;
};

type ExternalLaunchResult = {
  command: string[];
};

type BrowserLink = {
  index: number;
  text: string;
  url: string;
};

type BrowserFormField = {
  name: string;
  type: string;
  value: string;
  required: boolean;
};

type BrowserForm = {
  index: number;
  method: "get" | "post";
  action: string;
  fields: BrowserFormField[];
};

type BrowserSnapshot = {
  capturedAt: number;
  url: string;
  title: string;
  status: number;
  ok: boolean;
  contentType: string;
  truncated: boolean;
  bytes: number;
  text: string;
  links: BrowserLink[];
  refs: BrowserElementRef[];
};

type BrowserElementRef = {
  ref: string;
  kind: "link" | "form" | "field" | "submit" | "button";
  role: string;
  name: string;
  url?: string;
  formIndex?: number;
  fieldName?: string;
  method?: "get" | "post";
  selector?: string;
};

type BrowserFetchResult = {
  snapshot: BrowserSnapshot;
  html: string;
  setCookies: string[];
};

type BrowserTab = {
  id: string;
  url: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  history: string[];
  historyIndex: number;
  lastSnapshot: BrowserSnapshot | null;
  lastHtml: string;
  forms: BrowserForm[];
  formValues: Record<number, Record<string, string>>;
  cookies: Record<string, string>;
  /** Snapshot of the page's localStorage at last sync. */
  localStorage: Record<string, string>;
  /** Snapshot of the page's sessionStorage at last sync. */
  sessionStorage: Record<string, string>;
};

type BrowserState = {
  createdAt: number;
  nextTabIndex: number;
  activeTabId: string | null;
  tabs: BrowserTab[];
};

const browserState: BrowserState = {
  createdAt: Date.now(),
  nextTabIndex: 1,
  activeTabId: null,
  tabs: [],
};

let playwrightModulePromise: Promise<any | null> | null = null;
let liveBrowser: any | null = null;
let liveContext: any | null = null;
const livePagesByTabId = new Map<string, any>();
const liveMetaByTabId = new Map<string, LivePageMeta>();
const liveConsoleByTabId = new Map<string, LiveConsoleEntry[]>();
const liveDialogPlansByTabId = new Map<string, LiveDialogPlan>();
const liveDialogEventsByTabId = new Map<string, LiveDialogEvent[]>();
const liveDownloadsByTabId = new Map<string, LiveDownloadEntry[]>();

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function loadPlaywrightModule(): Promise<any | null> {
  if (!playwrightModulePromise) {
    playwrightModulePromise = (async () => {
      try {
        const mod = await import("playwright");
        if (mod?.chromium) {
          return mod;
        }
        return null;
      } catch {
        return null;
      }
    })();
  }
  return playwrightModulePromise;
}

async function ensureLiveRuntime(): Promise<{ playwright: any; browser: any; context: any }> {
  const playwright = await loadPlaywrightModule();
  if (!playwright?.chromium) {
    throw new Error(
      "live browser engine unavailable: Playwright is not installed. Install with: npm install playwright && npx playwright install chromium",
    );
  }

  if (!liveBrowser) {
    liveBrowser = await playwright.chromium.launch({
      headless: true,
    });
  }
  if (!liveContext) {
    liveContext = await liveBrowser.newContext({
      viewport: {
        width: LIVE_ENGINE_VIEWPORT_WIDTH,
        height: LIVE_ENGINE_VIEWPORT_HEIGHT,
      },
      userAgent: LIVE_ENGINE_USER_AGENT,
    });
  }
  return { playwright, browser: liveBrowser, context: liveContext };
}

function getLivePage(tabId: string): any | null {
  return livePagesByTabId.get(tabId) ?? null;
}

function boundedPush<T>(rows: T[], value: T, maxEntries: number): T[] {
  const next = [...rows, value];
  if (next.length <= maxEntries) {
    return next;
  }
  return next.slice(next.length - maxEntries);
}

async function evalPageExpression<T>(page: any, expression: string): Promise<T> {
  return (await page.evaluate(expression)) as T;
}

async function evalPageScript<T>(page: any, scriptBody: string, args?: unknown): Promise<T> {
  const wrapped = `(() => {
    const __t560Script = ${JSON.stringify(scriptBody)};
    const __t560Args = ${JSON.stringify(args ?? null)};
    const __t560Fn = new Function("args", __t560Script);
    return __t560Fn(__t560Args);
  })()`;
  return await evalPageExpression<T>(page, wrapped);
}

function pushLiveConsole(tabId: string, entry: LiveConsoleEntry): void {
  const rows = liveConsoleByTabId.get(tabId) ?? [];
  liveConsoleByTabId.set(tabId, boundedPush(rows, entry, LIVE_CONSOLE_MAX_ENTRIES));
}

function pushLiveDialogEvent(tabId: string, entry: LiveDialogEvent): void {
  const rows = liveDialogEventsByTabId.get(tabId) ?? [];
  liveDialogEventsByTabId.set(tabId, boundedPush(rows, entry, LIVE_DIALOG_MAX_EVENTS));
}

function sanitizeDownloadFilename(value: string): string {
  const raw = String(value ?? "").trim();
  const fallback = `download-${Date.now()}`;
  const candidate = raw || fallback;
  const base = path.basename(candidate).replace(/[^\w.\-]+/g, "_");
  return base || fallback;
}

function pushLiveDownload(tabId: string, entry: LiveDownloadEntry): void {
  const rows = liveDownloadsByTabId.get(tabId) ?? [];
  liveDownloadsByTabId.set(tabId, boundedPush(rows, entry, LIVE_DOWNLOAD_MAX_ENTRIES));
}

function serializeDownloadEntry(entry: LiveDownloadEntry): Record<string, unknown> {
  return {
    time: entry.time,
    url: entry.url,
    suggestedFilename: entry.suggestedFilename,
    path: entry.path,
    bytes: entry.bytes,
    mimeType: entry.mimeType,
    status: entry.status,
    error: entry.error ?? "",
  };
}

async function waitForNewDownloadEntries(params: {
  tabId: string;
  beforeCount: number;
  timeoutMs: number;
}): Promise<LiveDownloadEntry[]> {
  const deadline = Date.now() + Math.max(0, params.timeoutMs);
  while (Date.now() <= deadline) {
    const rows = liveDownloadsByTabId.get(params.tabId) ?? [];
    if (rows.length > params.beforeCount) {
      return rows.slice(params.beforeCount);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return [];
}

function attachLivePage(tabId: string, page: any): void {
  livePagesByTabId.set(tabId, page);
  if (!liveConsoleByTabId.has(tabId)) {
    liveConsoleByTabId.set(tabId, []);
  }
  if (!liveDialogEventsByTabId.has(tabId)) {
    liveDialogEventsByTabId.set(tabId, []);
  }
  if (!liveDownloadsByTabId.has(tabId)) {
    liveDownloadsByTabId.set(tabId, []);
  }
  if (typeof page?.on === "function") {
    page.on("console", (msg: any) => {
      let location = "";
      try {
        const raw = msg.location?.() ?? {};
        const file = String(raw.url ?? "").trim();
        const line = Number(raw.lineNumber ?? -1);
        location = file ? `${file}${line >= 0 ? `:${line}` : ""}` : "";
      } catch {
        location = "";
      }
      pushLiveConsole(tabId, {
        time: Date.now(),
        type: String(msg?.type?.() ?? "log"),
        text: String(msg?.text?.() ?? ""),
        location,
      });
    });
    page.on("pageerror", (error: any) => {
      pushLiveConsole(tabId, {
        time: Date.now(),
        type: "pageerror",
        text: String(error?.message ?? error ?? ""),
        location: "",
      });
    });
    page.on("dialog", async (dialog: any) => {
      const plan = liveDialogPlansByTabId.get(tabId);
      const defaultValue = String(dialog?.defaultValue?.() ?? "");
      let handled = "auto-dismiss";
      try {
        if (plan?.mode === "accept") {
          await dialog.accept(plan.promptText ?? defaultValue);
          handled = "accept";
        } else if (plan?.mode === "dismiss") {
          await dialog.dismiss();
          handled = "dismiss";
        } else {
          await dialog.dismiss();
          handled = "auto-dismiss";
        }
      } catch (error) {
        handled = `error:${error instanceof Error ? error.message : String(error)}`;
      } finally {
        if (plan?.once) {
          liveDialogPlansByTabId.delete(tabId);
        }
        pushLiveDialogEvent(tabId, {
          time: Date.now(),
          type: String(dialog?.type?.() ?? "dialog"),
          message: String(dialog?.message?.() ?? ""),
          defaultValue,
          handled,
        });
      }
    });
    page.on("download", async (download: any) => {
      const suggestedFilename = sanitizeDownloadFilename(String(download?.suggestedFilename?.() ?? ""));
      const downloadUrl = String(download?.url?.() ?? "");
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "t560-browser-download-")).catch(() => null);
      if (!tempDir) {
        pushLiveDownload(tabId, {
          time: Date.now(),
          url: downloadUrl,
          suggestedFilename,
          path: "",
          bytes: 0,
          mimeType: "",
          status: "failed",
          error: "could not create temp directory for download",
        });
        return;
      }
      const targetPath = path.join(tempDir, suggestedFilename);
      try {
        await download.saveAs(targetPath);
        const info = await stat(targetPath).catch(() => ({ size: 0 }));
        pushLiveDownload(tabId, {
          time: Date.now(),
          url: downloadUrl,
          suggestedFilename,
          path: targetPath,
          bytes: Number(info?.size ?? 0) || 0,
          mimeType: "",
          status: "saved",
        });
      } catch (error) {
        pushLiveDownload(tabId, {
          time: Date.now(),
          url: downloadUrl,
          suggestedFilename,
          path: targetPath,
          bytes: 0,
          mimeType: "",
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    page.on("close", () => {
      if (livePagesByTabId.get(tabId) === page) {
        livePagesByTabId.delete(tabId);
      }
      liveMetaByTabId.delete(tabId);
      liveConsoleByTabId.delete(tabId);
      liveDialogPlansByTabId.delete(tabId);
      liveDialogEventsByTabId.delete(tabId);
      liveDownloadsByTabId.delete(tabId);
    });
  }
}

function setLiveMeta(tabId: string, response: any | null | undefined): void {
  if (!response) {
    return;
  }
  const status = Number(response.status?.() ?? response.status ?? 0);
  const contentType = String(response.headers?.()?.["content-type"] ?? "");
  liveMetaByTabId.set(tabId, {
    status,
    ok: status >= 200 && status < 400,
    contentType,
  });
}

async function closeLiveTab(tabId: string): Promise<void> {
  const page = livePagesByTabId.get(tabId);
  livePagesByTabId.delete(tabId);
  liveMetaByTabId.delete(tabId);
  liveConsoleByTabId.delete(tabId);
  liveDialogPlansByTabId.delete(tabId);
  liveDialogEventsByTabId.delete(tabId);
  liveDownloadsByTabId.delete(tabId);
  if (!page) {
    return;
  }
  try {
    await page.close({ runBeforeUnload: false });
  } catch {
    // no-op
  }
}

async function launchExternalBrowser(url: string, timeoutMs: number): Promise<ExternalLaunchResult> {
  const platform = process.platform;
  let command = "";
  let args: string[] = [];
  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  let stderrText = "";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`external browser launch timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stderr?.on("data", (chunk) => {
      stderrText += String(chunk ?? "");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const details = stderrText.trim();
      const suffix = details ? ` ${details.split("\n").slice(-2).join(" ").trim()}` : "";
      reject(new Error(`external browser launch failed (exit ${code ?? "unknown"}).${suffix}`));
    });
  });

  return {
    command: [command, ...args],
  };
}

async function resetLiveRuntime(): Promise<void> {
  const pageIds = Array.from(livePagesByTabId.keys());
  for (const tabId of pageIds) {
    await closeLiveTab(tabId);
  }
  if (liveContext) {
    try {
      await liveContext.close();
    } catch {
      // no-op
    }
    liveContext = null;
  }
  if (liveBrowser) {
    try {
      await liveBrowser.close();
    } catch {
      // no-op
    }
    liveBrowser = null;
  }
}

async function hasLiveEngine(): Promise<boolean> {
  const mod = await loadPlaywrightModule();
  return Boolean(mod?.chromium);
}

function normalizeEngineParam(value: unknown): "auto" | BrowserEngineMode {
  const raw = String(value ?? "auto")
    .trim()
    .toLowerCase();
  if (!raw || raw === "auto") {
    return "auto";
  }
  if (raw === "fetch" || raw === "live") {
    return raw;
  }
  throw new Error("engine must be one of: auto|fetch|live");
}

function shouldAllowEngineFallback(params: Record<string, unknown>): boolean {
  return params.allowEngineFallback !== false;
}

function formatToolError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizeBrowserActionParams(input: Record<string, unknown>): Record<string, unknown> {
  const params = { ...input };

  const targetId = String(params.targetId ?? "").trim();
  if (targetId && params.tabId === undefined) {
    params.tabId = targetId;
  }

  const targetUrl = String(params.targetUrl ?? "").trim();
  if (targetUrl && params.url === undefined) {
    params.url = targetUrl;
  }

  const elementSelector = String(params.element ?? "").trim();
  if (elementSelector && params.selector === undefined) {
    params.selector = elementSelector;
  }

  const inputRef = String(params.inputRef ?? "").trim();
  if (inputRef && params.ref === undefined) {
    params.ref = inputRef;
  }

  if (params.networkIdle === undefined && params.network_idle !== undefined) {
    params.networkIdle = params.network_idle;
  }
  if (params.networkIdleTimeoutMs === undefined && params.network_idle_timeout_ms !== undefined) {
    params.networkIdleTimeoutMs = params.network_idle_timeout_ms;
  }
  if (params.networkIdleTimeoutMs === undefined && params.networkIdleTimeout !== undefined) {
    params.networkIdleTimeoutMs = params.networkIdleTimeout;
  }
  if (params.networkIdleTimeoutMs === undefined && params.network_idle_timeout !== undefined) {
    params.networkIdleTimeoutMs = params.network_idle_timeout;
  }

  const request = params.request;
  if (request && typeof request === "object" && !Array.isArray(request)) {
    const req = request as Record<string, unknown>;
    if (params.target === undefined && req.target !== undefined) {
      params.target = req.target;
    }
    if (params.node === undefined && req.node !== undefined) {
      params.node = req.node;
    }
    if (params.profile === undefined && req.profile !== undefined) {
      params.profile = req.profile;
    }
    if (params.kind === undefined && req.kind !== undefined) {
      params.kind = req.kind;
    }
    if (params.tabId === undefined && req.targetId !== undefined) {
      params.tabId = req.targetId;
    }
    if (params.url === undefined && req.targetUrl !== undefined) {
      params.url = req.targetUrl;
    }
    if (params.ref === undefined && req.ref !== undefined) {
      params.ref = req.ref;
    }
    if (params.ref === undefined && req.inputRef !== undefined) {
      params.ref = req.inputRef;
    }
    if (params.selector === undefined && req.selector !== undefined) {
      params.selector = req.selector;
    }
    if (params.selector === undefined && req.element !== undefined) {
      params.selector = req.element;
    }
    if (params.button === undefined && req.button !== undefined) {
      params.button = req.button;
    }
    if (params.doubleClick === undefined && req.doubleClick !== undefined) {
      params.doubleClick = req.doubleClick;
    }
    if (params.modifiers === undefined && req.modifiers !== undefined) {
      params.modifiers = req.modifiers;
    }
    if (params.value === undefined && req.text !== undefined) {
      params.value = req.text;
    }
    if (params.submit === undefined && req.submit !== undefined) {
      params.submit = req.submit;
    }
    if (params.slowly === undefined && req.slowly !== undefined) {
      params.slowly = req.slowly;
    }
    if (params.key === undefined && req.key !== undefined) {
      params.key = req.key;
    }
    if (params.startRef === undefined && req.startRef !== undefined) {
      params.startRef = req.startRef;
    }
    if (params.endRef === undefined && req.endRef !== undefined) {
      params.endRef = req.endRef;
    }
    if (params.values === undefined && req.values !== undefined) {
      params.values = req.values;
    }
    if (params.fields === undefined && req.fields !== undefined) {
      params.fields = req.fields;
    }
    if (params.formIndex === undefined && req.formIndex !== undefined) {
      params.formIndex = req.formIndex;
    }
    if (params.fieldName === undefined && req.fieldName !== undefined) {
      params.fieldName = req.fieldName;
    }
    if (params.value === undefined && req.value !== undefined) {
      params.value = req.value;
    }
    if (params.path === undefined && req.path !== undefined) {
      params.path = req.path;
    }
    if (params.paths === undefined && req.paths !== undefined) {
      params.paths = req.paths;
    }
    if (params.linkIndex === undefined && req.linkIndex !== undefined) {
      params.linkIndex = req.linkIndex;
    }
    if (params.width === undefined && req.width !== undefined) {
      params.width = req.width;
    }
    if (params.height === undefined && req.height !== undefined) {
      params.height = req.height;
    }
    if (params.timeMs === undefined && req.timeMs !== undefined) {
      params.timeMs = req.timeMs;
    }
    if (params.allowEngineFallback === undefined && req.allowEngineFallback !== undefined) {
      params.allowEngineFallback = req.allowEngineFallback;
    }
    if (params.maxRetries === undefined && req.maxRetries !== undefined) {
      params.maxRetries = req.maxRetries;
    }
    if (params.expression === undefined && req.fn !== undefined) {
      params.expression = req.fn;
    }
    if (params.accept === undefined && req.accept !== undefined) {
      params.accept = req.accept;
    }
    if (params.once === undefined && req.once !== undefined) {
      params.once = req.once;
    }
    if (params.promptText === undefined && req.promptText !== undefined) {
      params.promptText = req.promptText;
    }
    if (params.format === undefined && req.format !== undefined) {
      params.format = req.format;
    }
    if (params.printBackground === undefined && req.printBackground !== undefined) {
      params.printBackground = req.printBackground;
    }
    if (params.deltaX === undefined && req.deltaX !== undefined) {
      params.deltaX = req.deltaX;
    }
    if (params.deltaY === undefined && req.deltaY !== undefined) {
      params.deltaY = req.deltaY;
    }
    if (params.toTop === undefined && req.toTop !== undefined) {
      params.toTop = req.toTop;
    }
    if (params.toBottom === undefined && req.toBottom !== undefined) {
      params.toBottom = req.toBottom;
    }
    if (params.waitForSelector === undefined && req.waitForSelector !== undefined) {
      params.waitForSelector = req.waitForSelector;
    }
    if (params.networkIdle === undefined && req.networkIdle !== undefined) {
      params.networkIdle = req.networkIdle;
    }
    if (params.networkIdle === undefined && req.network_idle !== undefined) {
      params.networkIdle = req.network_idle;
    }
    if (params.networkIdleTimeoutMs === undefined && req.networkIdleTimeoutMs !== undefined) {
      params.networkIdleTimeoutMs = req.networkIdleTimeoutMs;
    }
    if (params.networkIdleTimeoutMs === undefined && req.network_idle_timeout_ms !== undefined) {
      params.networkIdleTimeoutMs = req.network_idle_timeout_ms;
    }
    if (params.networkIdleTimeoutMs === undefined && req.networkIdleTimeout !== undefined) {
      params.networkIdleTimeoutMs = req.networkIdleTimeout;
    }
    if (params.networkIdleTimeoutMs === undefined && req.network_idle_timeout !== undefined) {
      params.networkIdleTimeoutMs = req.network_idle_timeout;
    }
    if (params.waitForRequestUrl === undefined && req.waitForRequestUrl !== undefined) {
      params.waitForRequestUrl = req.waitForRequestUrl;
    }
    if (params.waitForRequestMethod === undefined && req.waitForRequestMethod !== undefined) {
      params.waitForRequestMethod = req.waitForRequestMethod;
    }
    if (params.waitForStatus === undefined && req.waitForStatus !== undefined) {
      params.waitForStatus = req.waitForStatus;
    }
    if (params.waitForRequestBodyIncludes === undefined && req.waitForRequestBodyIncludes !== undefined) {
      params.waitForRequestBodyIncludes = req.waitForRequestBodyIncludes;
    }
    if (params.waitForResponseBodyIncludes === undefined && req.waitForResponseBodyIncludes !== undefined) {
      params.waitForResponseBodyIncludes = req.waitForResponseBodyIncludes;
    }
    if (params.urlContains === undefined && req.urlContains !== undefined) {
      params.urlContains = req.urlContains;
    }
    if (params.state === undefined && req.state !== undefined) {
      params.state = req.state;
    }
    if (params.clear === undefined && req.clear !== undefined) {
      params.clear = req.clear;
    }
    if (params.level === undefined && req.level !== undefined) {
      params.level = req.level;
    }
    if (params.limit === undefined && req.limit !== undefined) {
      params.limit = req.limit;
    }
    if (
      params.waitForText === undefined &&
      req.text !== undefined &&
      String(req.kind ?? "")
        .trim()
        .toLowerCase() === "wait"
    ) {
      params.waitForText = req.text;
    }
    if (params.textGone === undefined && req.textGone !== undefined) {
      params.textGone = req.textGone;
    }
  }

  return params;
}

function normalizeHttpUrl(value: unknown, baseUrl?: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error("url is required.");
  }
  let parsed: URL;
  try {
    parsed = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
  } catch {
    throw new Error("invalid url.");
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error("only http(s) URLs are supported.");
  }
  return parsed.toString();
}

function summarizeTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url;
  }
}

function normalizeHttpUrlOrFallback(value: unknown, fallback: string): string {
  try {
    return normalizeHttpUrl(value);
  } catch {
    return fallback;
  }
}

function extractHtmlTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match?.[1]) {
    return "";
  }
  return decodeHtmlEntities(match[1]).replace(/\s+/g, " ").trim();
}

function trimText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n[truncated for model context]`;
}

function extractLinks(html: string, pageUrl: string, maxLinks: number): BrowserLink[] {
  const out: BrowserLink[] = [];
  const seen = new Set<string>();
  const pattern = /<a\b([^>]*?)href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'<>`]+))([^>]*)>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = pattern.exec(html)) && out.length < maxLinks) {
    const href = String(match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (!href) {
      continue;
    }
    let resolved = "";
    try {
      resolved = normalizeHttpUrl(href, pageUrl);
    } catch {
      continue;
    }
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);

    const rawText = String(match[6] ?? "");
    const text = decodeHtmlEntities(rawText.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (!text || text.length < 2) {
      continue;
    }

    out.push({
      index: out.length + 1,
      text,
      url: resolved,
    });
  }

  return out;
}

function parseHtmlAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(raw))) {
    const key = String(match[1] ?? "").trim().toLowerCase();
    if (!key) {
      continue;
    }
    const value = String(match[2] ?? match[3] ?? match[4] ?? "");
    attrs[key] = value;
  }
  return attrs;
}

function parseSelectValue(selectHtml: string): string {
  const optionPattern = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let fallback = "";
  let match;
  while ((match = optionPattern.exec(selectHtml))) {
    const attrs = parseHtmlAttributes(String(match[1] ?? ""));
    const textValue = decodeHtmlEntities(String(match[2] ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    const value = attrs.value ?? textValue;
    if (!fallback) {
      fallback = value;
    }
    if ("selected" in attrs) {
      return value;
    }
  }
  return fallback;
}

function parseFormFields(formHtml: string): BrowserFormField[] {
  const fields: BrowserFormField[] = [];

  const inputPattern = /<input\b([^>]*)\/?>/gi;
  let inputMatch;
  while ((inputMatch = inputPattern.exec(formHtml))) {
    const attrs = parseHtmlAttributes(String(inputMatch[1] ?? ""));
    const name = String(attrs.name ?? "").trim();
    if (!name) {
      continue;
    }
    const type = String(attrs.type ?? "text").trim().toLowerCase() || "text";
    if (type === "submit" || type === "button" || type === "image" || type === "reset" || type === "file") {
      continue;
    }
    const value = String(attrs.value ?? "");
    fields.push({
      name,
      type,
      value,
      required: "required" in attrs,
    });
  }

  const textareaPattern = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  let textareaMatch;
  while ((textareaMatch = textareaPattern.exec(formHtml))) {
    const attrs = parseHtmlAttributes(String(textareaMatch[1] ?? ""));
    const name = String(attrs.name ?? "").trim();
    if (!name) {
      continue;
    }
    const value = decodeHtmlEntities(String(textareaMatch[2] ?? ""));
    fields.push({
      name,
      type: "textarea",
      value,
      required: "required" in attrs,
    });
  }

  const selectPattern = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let selectMatch;
  while ((selectMatch = selectPattern.exec(formHtml))) {
    const attrs = parseHtmlAttributes(String(selectMatch[1] ?? ""));
    const name = String(attrs.name ?? "").trim();
    if (!name) {
      continue;
    }
    fields.push({
      name,
      type: "select",
      value: parseSelectValue(String(selectMatch[2] ?? "")),
      required: "required" in attrs,
    });
  }

  return fields;
}

function parseForms(html: string, pageUrl: string): BrowserForm[] {
  const forms: BrowserForm[] = [];
  const pattern = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const attrs = parseHtmlAttributes(String(match[1] ?? ""));
    const methodRaw = String(attrs.method ?? "get").trim().toLowerCase();
    const method: "get" | "post" = methodRaw === "post" ? "post" : "get";
    let action = pageUrl;
    try {
      action = normalizeHttpUrl(attrs.action || pageUrl, pageUrl);
    } catch {
      action = pageUrl;
    }
    forms.push({
      index: forms.length + 1,
      method,
      action,
      fields: parseFormFields(String(match[2] ?? "")),
    });
  }
  return forms;
}

function buildDefaultFormValues(forms: BrowserForm[]): Record<number, Record<string, string>> {
  const values: Record<number, Record<string, string>> = {};
  for (const form of forms) {
    const row: Record<string, string> = {};
    for (const field of form.fields) {
      row[field.name] = field.value;
    }
    values[form.index] = row;
  }
  return values;
}

function splitSetCookieHeader(header: string): string[] {
  const input = String(header ?? "").trim();
  if (!input) {
    return [];
  }
  const out: string[] = [];
  let start = 0;
  let inExpires = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (!inExpires && input.slice(i, i + 8).toLowerCase() === "expires=") {
      inExpires = true;
      i += 7;
      continue;
    }
    if (inExpires && char === ";") {
      inExpires = false;
    }
    if (!inExpires && char === ",") {
      const part = input.slice(start, i).trim();
      if (part) {
        out.push(part);
      }
      start = i + 1;
    }
  }
  const tail = input.slice(start).trim();
  if (tail) {
    out.push(tail);
  }
  return out;
}

function readSetCookieHeaders(headers: Headers): string[] {
  const maybeHeaders = headers as Headers & { getSetCookie?: () => string[]; raw?: () => Record<string, string[]> };
  if (typeof maybeHeaders.getSetCookie === "function") {
    return maybeHeaders.getSetCookie().filter((value) => String(value ?? "").trim().length > 0);
  }
  if (typeof maybeHeaders.raw === "function") {
    const raw = maybeHeaders.raw();
    const values = raw["set-cookie"];
    if (Array.isArray(values)) {
      return values.filter((value) => String(value ?? "").trim().length > 0);
    }
  }
  const combined = headers.get("set-cookie");
  return combined ? splitSetCookieHeader(combined) : [];
}

function upsertTabCookies(tab: BrowserTab, setCookies: string[]): void {
  for (const raw of setCookies) {
    const pair = String(raw ?? "").split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) {
      continue;
    }

    const attrs = String(raw ?? "")
      .split(";")
      .slice(1)
      .map((part) => part.trim());
    let shouldDelete = false;
    for (const attr of attrs) {
      const [rawKey, rawValue = ""] = attr.split("=");
      const key = String(rawKey ?? "").trim().toLowerCase();
      const valuePart = String(rawValue ?? "").trim();
      if (key === "max-age") {
        const maxAge = Number(valuePart);
        if (Number.isFinite(maxAge) && maxAge <= 0) {
          shouldDelete = true;
        }
      }
      if (key === "expires") {
        const expiresAt = Date.parse(valuePart);
        if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
          shouldDelete = true;
        }
      }
    }

    if (shouldDelete) {
      delete tab.cookies[name];
      continue;
    }
    tab.cookies[name] = value;
  }
}

function buildCookieHeader(tab: BrowserTab): string {
  return Object.entries(tab.cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function fetchSnapshot(params: {
  url: string;
  timeoutMs: number;
  maxBytes: number;
  maxChars: number;
  maxLinks: number;
  method?: "GET" | "POST";
  body?: string;
  cookieHeader?: string;
}): Promise<BrowserFetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), params.timeoutMs);
  try {
    const headers: Record<string, string> = {
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) t560-browser/1.0 Safari/537.36",
    };
    if (params.cookieHeader) {
      headers.Cookie = params.cookieHeader;
    }
    const method = params.method ?? "GET";
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const res = await fetch(params.url, {
      method,
      redirect: "follow",
      headers,
      body: method === "POST" ? params.body ?? "" : undefined,
      signal: ctrl.signal,
    });
    const contentType = String(res.headers.get("content-type") ?? "");
    const setCookies = readSetCookieHeaders(res.headers);
    const buf = new Uint8Array(await res.arrayBuffer());
    const truncated = buf.byteLength > params.maxBytes;
    const slice = truncated ? buf.slice(0, params.maxBytes) : buf;
    const decoded = new TextDecoder().decode(slice);
    const finalUrl = normalizeHttpUrl(res.url || params.url);
    const readable = chooseReadableText(contentType, decoded);
    const text = trimText(readable, params.maxChars);
    const title = extractHtmlTitle(decoded) || summarizeTitleFromUrl(finalUrl);
    const links = /html|xml/i.test(contentType) ? extractLinks(decoded, finalUrl, params.maxLinks) : [];

    return {
      html: decoded,
      setCookies,
      snapshot: {
        capturedAt: Date.now(),
        url: finalUrl,
        title,
        status: res.status,
        ok: res.ok,
        contentType,
        truncated,
        bytes: slice.byteLength,
        text,
        links,
        refs: [],
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function captureFirefoxScreenshot(params: {
  url: string;
  timeoutMs: number;
  width: number;
  height: number;
}): Promise<{
  path: string;
  bytes: number;
  width: number;
  height: number;
  url: string;
  type: "png";
}> {
  const filePath = path.join(
    os.tmpdir(),
    `t560-browser-shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
  );
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "t560-firefox-profile-"));

  const args = [
    "--no-remote",
    "--profile",
    profileDir,
    "--headless",
    "--screenshot",
    filePath,
    `--window-size=${params.width},${params.height}`,
    params.url,
  ];

  let stderrText = "";
  await new Promise<void>((resolve, reject) => {
    const child = spawn("firefox", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (chunk) => {
      stderrText += String(chunk ?? "");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("firefox screenshot timed out."));
    }, params.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const details = stderrText.trim();
      const suffix = details ? ` ${details.split("\n").slice(-2).join(" ").trim()}` : "";
      reject(new Error(`firefox screenshot failed (exit ${code ?? "unknown"}).${suffix}`));
    });
  });

  let info;
  try {
    info = await stat(filePath);
  } catch {
    const details = stderrText.trim();
    const suffix = details ? ` ${details.split("\n").slice(-2).join(" ").trim()}` : "";
    throw new Error(
      `firefox completed without producing a screenshot file.${suffix} Headless screenshots may be unavailable in this environment.`,
    );
  }
  return {
    path: filePath,
    bytes: info.size,
    width: params.width,
    height: params.height,
    url: params.url,
    type: "png",
  };
}

function buildTabRecord(url: string): BrowserTab {
  const id = `tab-${browserState.nextTabIndex++}`;
  const now = Date.now();
  return {
    id,
    url,
    title: summarizeTitleFromUrl(url),
    createdAt: now,
    updatedAt: now,
    history: [url],
    historyIndex: 0,
    lastSnapshot: null,
    lastHtml: "",
    forms: [],
    formValues: {},
    cookies: {},
    localStorage: {},
    sessionStorage: {},
  };
}

function createTab(url: string): BrowserTab {
  const tab = buildTabRecord(url);
  browserState.tabs.push(tab);
  browserState.activeTabId = tab.id;
  return tab;
}

function createBackgroundTab(url: string): BrowserTab {
  const tab = buildTabRecord(url);
  browserState.tabs.push(tab);
  return tab;
}

function findTabById(tabId: string): BrowserTab | null {
  const wanted = String(tabId ?? "").trim();
  if (!wanted) {
    return null;
  }
  return browserState.tabs.find((tab) => tab.id === wanted) ?? null;
}

function getActiveTab(): BrowserTab | null {
  if (!browserState.activeTabId) {
    return null;
  }
  return findTabById(browserState.activeTabId);
}

function resolveTab(tabId: unknown): BrowserTab {
  const wanted = String(tabId ?? "").trim();
  if (wanted) {
    const found = findTabById(wanted);
    if (!found) {
      throw new Error(`unknown tab id: ${wanted}`);
    }
    return found;
  }
  const active = getActiveTab();
  if (!active) {
    throw new Error("no active tab.");
  }
  return active;
}

function setActiveTab(tab: BrowserTab): void {
  browserState.activeTabId = tab.id;
  tab.updatedAt = Date.now();
}

function clearTabTransient(tab: BrowserTab): void {
  tab.lastSnapshot = null;
  tab.lastHtml = "";
  tab.forms = [];
  tab.formValues = {};
}

function navigateTab(tab: BrowserTab, nextUrl: string): void {
  const normalized = normalizeHttpUrl(nextUrl);
  if (tab.historyIndex < tab.history.length - 1) {
    tab.history = tab.history.slice(0, tab.historyIndex + 1);
  }
  tab.history.push(normalized);
  tab.historyIndex = tab.history.length - 1;
  tab.url = normalized;
  tab.title = summarizeTitleFromUrl(normalized);
  tab.updatedAt = Date.now();
  clearTabTransient(tab);
}

function appendHistoryEntry(tab: BrowserTab, url: string): void {
  const normalized = normalizeHttpUrl(url);
  const current = tab.history[tab.historyIndex];
  if (current === normalized) {
    return;
  }
  if (tab.historyIndex < tab.history.length - 1) {
    tab.history = tab.history.slice(0, tab.historyIndex + 1);
  }
  tab.history.push(normalized);
  tab.historyIndex = tab.history.length - 1;
}

function closeTab(tab: BrowserTab): void {
  browserState.tabs = browserState.tabs.filter((entry) => entry.id !== tab.id);
  if (browserState.activeTabId === tab.id) {
    browserState.activeTabId = browserState.tabs.length > 0 ? browserState.tabs[browserState.tabs.length - 1].id : null;
  }
}

function serializeTab(tab: BrowserTab): Record<string, unknown> {
  return {
    id: tab.id,
    engine: getLivePage(tab.id) ? "live" : "fetch",
    url: tab.url,
    title: tab.title,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
    historyLength: tab.history.length,
    historyIndex: tab.historyIndex,
    hasSnapshot: Boolean(tab.lastSnapshot),
    formsCount: tab.forms.length,
    cookieCount: Object.keys(tab.cookies).length,
    consoleCount: (liveConsoleByTabId.get(tab.id) ?? []).length,
    downloadCount: (liveDownloadsByTabId.get(tab.id) ?? []).length,
    dialogArmed: liveDialogPlansByTabId.has(tab.id),
  };
}

async function captureTabSnapshot(
  tab: BrowserTab,
  params: Record<string, unknown>,
  request?: { method?: "GET" | "POST"; url?: string; body?: string },
): Promise<BrowserSnapshot> {
  const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
  const maxBytes = clampInt(params.maxBytes, 10_000, 500_000, DEFAULT_MAX_BYTES);
  const maxChars = clampInt(params.maxChars, 500, 80_000, DEFAULT_MAX_CHARS);
  const maxLinks = clampInt(params.maxLinks, 1, 200, DEFAULT_MAX_LINKS);
  const cookieHeader = buildCookieHeader(tab);
  const fetched = await fetchSnapshot({
    url: request?.url ?? tab.url,
    timeoutMs,
    maxBytes,
    maxChars,
    maxLinks,
    method: request?.method,
    body: request?.body,
    cookieHeader,
  });
  const snapshot = fetched.snapshot;
  upsertTabCookies(tab, fetched.setCookies);
  tab.lastHtml = fetched.html;
  tab.forms = parseForms(fetched.html, snapshot.url);
  tab.formValues = buildDefaultFormValues(tab.forms);
  snapshot.refs = buildSnapshotRefs(snapshot, tab.forms);
  tab.url = snapshot.url;
  if (tab.history.length > 0) {
    tab.history[tab.historyIndex] = snapshot.url;
  }
  tab.title = snapshot.title || tab.title;
  tab.lastSnapshot = snapshot;
  tab.updatedAt = Date.now();
  return snapshot;
}

async function captureTabSnapshotWithRetries(
  tab: BrowserTab,
  params: Record<string, unknown>,
  request?: { method?: "GET" | "POST"; url?: string; body?: string },
): Promise<{ snapshot: BrowserSnapshot; attempts: number }> {
  const retries = clampInt(params.maxRetries, 0, 4, DEFAULT_ACTION_MAX_RETRIES);
  let attempts = 0;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    attempts = attempt + 1;
    try {
      const snapshot = await captureTabSnapshot(tab, params, request);
      return {
        snapshot,
        attempts,
      };
    } catch (error) {
      lastError = error;
      if (attempt >= retries) {
        break;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("snapshot capture failed.");
}

function resolveForm(tab: BrowserTab, formIndexRaw: unknown, refRaw?: unknown): BrowserForm {
  if (tab.forms.length === 0) {
    throw new Error("no forms available. run snapshot on a page containing a form.");
  }
  const byRef = resolveSnapshotRef(tab, refRaw);
  const fromRef = byRef?.formIndex;
  const formIndex = fromRef ?? (formIndexRaw == null ? 1 : clampInt(formIndexRaw, 1, 1_000_000, 1));
  const form = tab.forms.find((entry) => entry.index === formIndex);
  if (!form) {
    throw new Error(`form index ${formIndex} not found.`);
  }
  return form;
}

function resolveFormField(tab: BrowserTab, form: BrowserForm, fieldNameRaw: unknown, refRaw?: unknown): BrowserFormField {
  const byRef = resolveSnapshotRef(tab, refRaw);
  if (byRef) {
    if (byRef.kind !== "field") {
      throw new Error(`ref ${byRef.ref} is not an input field.`);
    }
    if (!byRef.fieldName || byRef.formIndex !== form.index) {
      throw new Error(`ref ${byRef.ref} does not belong to form ${form.index}.`);
    }
    const fieldByRef = form.fields.find((entry) => entry.name === byRef.fieldName);
    if (!fieldByRef) {
      throw new Error(`field from ref ${byRef.ref} is no longer available.`);
    }
    return fieldByRef;
  }

  const fieldName = String(fieldNameRaw ?? "").trim();
  if (!fieldName) {
    throw new Error("fieldName is required (or provide a field ref).");
  }
  const field =
    form.fields.find((entry) => entry.name === fieldName) ??
    form.fields.find((entry) => entry.name.toLowerCase() === fieldName.toLowerCase());
  if (!field) {
    throw new Error(`field "${fieldName}" not found on form ${form.index}.`);
  }
  return field;
}

function collectFormPayload(tab: BrowserTab, form: BrowserForm): URLSearchParams {
  const payload = new URLSearchParams();
  const overrides = tab.formValues[form.index] ?? {};
  for (const field of form.fields) {
    if (!field.name) {
      continue;
    }
    const value = overrides[field.name] ?? field.value ?? "";
    payload.append(field.name, value);
  }
  return payload;
}

function fieldRole(field: BrowserFormField): string {
  const type = String(field.type ?? "").toLowerCase();
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  if (type === "select") return "combobox";
  if (type === "textarea") return "textbox";
  return "textbox";
}

function fieldDisplayName(formIndex: number, field: BrowserFormField): string {
  const label = field.name || `${field.type} field`;
  return `form ${formIndex}: ${label}`;
}

function buildSnapshotRefs(snapshot: BrowserSnapshot, forms: BrowserForm[]): BrowserElementRef[] {
  const refs: BrowserElementRef[] = [];
  let index = 1;
  const nextRef = () => `e${index++}`;

  for (const link of snapshot.links) {
    refs.push({
      ref: nextRef(),
      kind: "link",
      role: "link",
      name: link.text,
      url: link.url,
    });
  }

  for (const form of forms) {
    refs.push({
      ref: nextRef(),
      kind: "form",
      role: "form",
      name: `form ${form.index} (${form.method.toUpperCase()} ${form.action})`,
      formIndex: form.index,
      method: form.method,
      url: form.action,
    });
    for (const field of form.fields) {
      refs.push({
        ref: nextRef(),
        kind: "field",
        role: fieldRole(field),
        name: fieldDisplayName(form.index, field),
        formIndex: form.index,
        fieldName: field.name,
      });
    }
    refs.push({
      ref: nextRef(),
      kind: "submit",
      role: "button",
      name: `submit form ${form.index}`,
      formIndex: form.index,
      method: form.method,
      url: form.action,
    });
  }

  return refs;
}

async function buildLiveActionRefs(page: any): Promise<Array<{
  kind: "link" | "field" | "submit" | "button";
  role: string;
  name: string;
  selector: string;
  url?: string;
  formIndex?: number;
  fieldName?: string;
  method?: "get" | "post";
}>> {
  const script = `
    const cssEscape = (value) => {
      const raw = String(value ?? "");
      if (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function") {
        return CSS.escape(raw);
      }
      return raw.replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
    };
    const refAttr = "data-t560-ref-id";
    const sessionPrefix = "t560-" + Date.now().toString(36);
    let refCounter = 1;
    const ensureStableSelector = (element) => {
      let refId = String(element.getAttribute(refAttr) || "").trim();
      if (!refId) {
        refId = sessionPrefix + "-" + String(refCounter++);
        element.setAttribute(refAttr, refId);
      }
      return "[" + refAttr + '="' + cssEscape(refId) + '"]';
    };
    const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
    const bySelector = new Set();
    const forms = Array.from(document.querySelectorAll("form"));
    const formMeta = new Map();
    for (const [idx, formEl] of forms.entries()) {
      const methodRaw = String(formEl.method || "get").toLowerCase();
      const method = methodRaw === "post" ? "post" : "get";
      let action = location.href;
      try {
        action = new URL(formEl.getAttribute("action") || location.href, location.href).toString();
      } catch {
        action = location.href;
      }
      formMeta.set(formEl, { formIndex: idx + 1, method, action });
    }

    const rows = [];
    const seenElements = new Set();
    const candidateSelector =
      'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="textbox"],[role="combobox"],[contenteditable="true"]';
    const roots = [document];
    const seenRoots = new Set([document]);
    const candidates = [];
    while (roots.length > 0) {
      const root = roots.shift();
      if (!root || typeof root.querySelectorAll !== "function") {
        continue;
      }
      const found = Array.from(root.querySelectorAll(candidateSelector));
      for (const node of found) {
        if (!node || seenElements.has(node)) {
          continue;
        }
        seenElements.add(node);
        candidates.push(node);
        const shadow = node.shadowRoot;
        if (shadow && !seenRoots.has(shadow)) {
          seenRoots.add(shadow);
          roots.push(shadow);
        }
      }
    }

    for (const element of candidates) {
      const htmlEl = element;
      const rect = htmlEl.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      if (!visible) {
        continue;
      }

      const selector = ensureStableSelector(element);
      if (!selector || bySelector.has(selector)) {
        continue;
      }
      bySelector.add(selector);

      const tag = String(element.tagName || "").toLowerCase();
      const inputType = tag === "input" ? String(element.type || "text").toLowerCase() : "";
      const explicitRole = String(element.getAttribute("role") || "").toLowerCase();
      const inForm = element.closest("form");
      let meta = inForm ? formMeta.get(inForm) : null;
      if (!meta && inForm) {
        const methodRaw = String(inForm.method || "get").toLowerCase();
        const method = methodRaw === "post" ? "post" : "get";
        let action = location.href;
        try {
          action = new URL(inForm.getAttribute("action") || location.href, location.href).toString();
        } catch {
          action = location.href;
        }
        meta = { formIndex: formMeta.size + 1, method, action };
        formMeta.set(inForm, meta);
      }
      const name = normalize(
        element.getAttribute("aria-label") ||
          (tag === "input" ? element.value : "") ||
          (tag === "textarea" ? element.value : "") ||
          htmlEl.innerText ||
          element.textContent ||
          element.getAttribute("placeholder") ||
          element.getAttribute("name") ||
          element.getAttribute("id") ||
          "",
      );

      let kind = null;
      let role = explicitRole || "";
      if (tag === "a" || explicitRole === "link") {
        kind = "link";
        role = role || "link";
      } else if (tag === "select") {
        kind = "field";
        role = role || "combobox";
      } else if (tag === "textarea") {
        kind = "field";
        role = role || "textbox";
      } else if (tag === "input") {
        if (["submit", "image"].includes(inputType)) {
          kind = "submit";
          role = role || "button";
        } else if (["button", "reset"].includes(inputType)) {
          kind = "button";
          role = role || "button";
        } else {
          kind = "field";
          role = role || "textbox";
        }
      } else if (tag === "button" || explicitRole === "button") {
        const nativeType = tag === "button" ? String(element.type || "submit").toLowerCase() : "button";
        kind = nativeType === "submit" && inForm ? "submit" : "button";
        role = role || "button";
      } else if (element.getAttribute("contenteditable") === "true") {
        kind = "field";
        role = role || "textbox";
      }

      if (!kind) {
        continue;
      }

      const row = {
        kind,
        role,
        name: name || selector,
        selector,
      };
      if (kind === "link") {
        try {
          row.url = new URL(element.href || "", location.href).toString();
        } catch {}
      }
      if ((kind === "field" || kind === "submit") && meta) {
        row.formIndex = meta.formIndex;
        row.method = meta.method;
        row.url = meta.action;
      }
      if (kind === "field") {
        const fieldName = String(element.getAttribute("name") || "").trim();
        if (fieldName) {
          row.fieldName = fieldName;
        }
      }
      rows.push(row);
    }

    return rows;
  `;
  return await evalPageScript<Array<{
    kind: "link" | "field" | "submit" | "button";
    role: string;
    name: string;
    selector: string;
    url?: string;
    formIndex?: number;
    fieldName?: string;
    method?: "get" | "post";
  }>>(page, script);
}

/**
 * Parses a selector that may be prefixed with a frame index ("frame:N:realSelector").
 * Returns the appropriate Playwright context (page or a specific child frame) and the actual selector.
 * When no prefix is present, the original page and selector are returned unchanged.
 */
function resolveFrameSelector(page: any, selector: string): { context: any; selector: string } {
  const m = /^frame:(\d+):(.+)$/.exec(selector);
  if (m) {
    const idx = parseInt(m[1], 10);
    const frames: any[] = (page.frames?.() as any[]) ?? [];
    if (idx >= 0 && idx < frames.length) {
      return { context: frames[idx], selector: m[2] };
    }
  }
  return { context: page, selector };
}

function resolveSnapshotRef(tab: BrowserTab, refRaw: unknown): BrowserElementRef | null {
  const wanted = String(refRaw ?? "").trim().toLowerCase();
  if (!wanted) {
    return null;
  }
  if (!tab.lastSnapshot) {
    throw new Error("no snapshot available for ref lookup. run snapshot first.");
  }
  const found = tab.lastSnapshot.refs.find((entry) => entry.ref.toLowerCase() === wanted);
  if (!found) {
    throw new Error(`ref not found: ${wanted}`);
  }
  return found;
}

async function syncTabCookiesFromLiveContext(tab: BrowserTab, pageUrl: string): Promise<void> {
  const page = getLivePage(tab.id);
  if (!page) {
    return;
  }
  let cookies: Array<{ name?: string; value?: string }> = [];
  try {
    cookies = await page.context().cookies([pageUrl]);
  } catch {
    return;
  }
  tab.cookies = {};
  for (const cookie of cookies) {
    const name = String(cookie?.name ?? "").trim();
    if (!name) {
      continue;
    }
    tab.cookies[name] = String(cookie?.value ?? "");
  }
}

async function syncTabStorageFromLiveContext(tab: BrowserTab): Promise<void> {
  const page = getLivePage(tab.id);
  if (!page) return;
  try {
    const storage = await evalPageScript<{ local: Record<string, string>; session: Record<string, string> }>(
      page,
      `
        const snap = (store) => {
          const out = {};
          try {
            for (let i = 0; i < store.length; i++) {
              const k = store.key(i);
              if (k !== null) out[k] = store.getItem(k) ?? "";
            }
          } catch {}
          return out;
        };
        return { local: snap(localStorage), session: snap(sessionStorage) };
      `,
    );
    tab.localStorage = storage.local ?? {};
    tab.sessionStorage = storage.session ?? {};
  } catch {
    // Best-effort — some pages restrict storage access (e.g. sandboxed iframes).
  }
}

async function captureLiveTabSnapshot(tab: BrowserTab, params: Record<string, unknown>): Promise<BrowserSnapshot> {
  const page = getLivePage(tab.id);
  if (!page) {
    throw new Error(`live browser page missing for tab ${tab.id}.`);
  }

  const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
  const maxBytes = clampInt(params.maxBytes, 10_000, 500_000, DEFAULT_MAX_BYTES);
  const maxChars = clampInt(params.maxChars, 500, 80_000, DEFAULT_MAX_CHARS);
  const maxLinks = clampInt(params.maxLinks, 1, 200, DEFAULT_MAX_LINKS);

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
  } catch {
    // Continue with best-effort page state for SPA pages that never reach a stable network state.
  }
  // If networkIdle is requested (useful for SPAs that fetch data after domcontentloaded),
  // additionally wait until there are no in-flight network requests for 500 ms.
  if (params.networkIdle === true) {
    try {
      await page.waitForLoadState("networkidle", { timeout: Math.min(Number(params.networkIdleTimeoutMs ?? 0) || 8000, 20000) });
    } catch {
      // Best-effort — long-polling or websocket sites never reach networkidle.
    }
  }

  const finalUrl = normalizeHttpUrl(page.url() || tab.url);
  const htmlRaw = String(await page.content());
  const rawBytes = new TextEncoder().encode(htmlRaw);
  const truncated = rawBytes.byteLength > maxBytes;
  const slice = truncated ? rawBytes.slice(0, maxBytes) : rawBytes;
  const html = new TextDecoder().decode(slice);
  const readable = chooseReadableText("text/html", html);
  const text = trimText(readable, maxChars);
  const links = extractLinks(html, finalUrl, maxLinks);
  const forms = parseForms(html, finalUrl);
  const titleRaw = String((await page.title()) ?? "");
  const title = titleRaw.trim() || extractHtmlTitle(html) || summarizeTitleFromUrl(finalUrl);
  const meta = liveMetaByTabId.get(tab.id) ?? {
    status: 200,
    ok: true,
    contentType: "text/html; charset=utf-8",
  };

  const snapshot: BrowserSnapshot = {
    capturedAt: Date.now(),
    url: finalUrl,
    title,
    status: meta.status,
    ok: meta.ok,
    contentType: meta.contentType || "text/html; charset=utf-8",
    truncated,
    bytes: slice.byteLength,
    text,
    links,
    refs: [],
  };
  const fallbackRefs = buildSnapshotRefs(snapshot, forms);
  const liveRowsRaw = await buildLiveActionRefs(page);
  // Strip social/OAuth auth buttons from refs so agents cannot accidentally click them.
  // Only buttons and links are filtered; form fields and submit inputs are kept.
  const liveRows = liveRowsRaw.filter(
    (row) => !(row.kind === "button" && isSocialAuthLabel(row.name)),
  );
  if (liveRows.length > 0) {
    snapshot.refs = liveRows.map((row, idx) => ({
      ref: `e${idx + 1}`,
      kind: row.kind,
      role: row.role,
      name: row.name,
      selector: row.selector,
      url: row.url,
      formIndex: row.formIndex,
      fieldName: row.fieldName,
      method: row.method,
    }));
  } else {
    snapshot.refs = fallbackRefs;
  }

  // Detect auth-related iframes (e.g. Privy, Auth0, Clerk) and include their content.
  // This prevents agents from URL-guessing when the login form lives inside an embedded frame.
  try {
    const allFrames = (page.frames?.() as any[]) ?? [];
    let frameRefBase = snapshot.refs.length;
    for (let fi = 0; fi < allFrames.length; fi++) {
      const frame = allFrames[fi];
      if (!frame || frame === page.mainFrame?.()) continue;
      const frameUrl = String(frame.url?.() ?? "");
      if (!frameUrl || frameUrl === "about:blank" || frameUrl.startsWith("data:")) continue;
      try {
        const hasAuthInputs = await evalPageScript<boolean>(
          frame,
          `
            const inputs = document.querySelectorAll(
              'input[type="email"],input[type="password"],input[autocomplete="one-time-code"],' +
              'input[name*="identifier" i],input[name*="email" i],input[name*="otp" i],input[name*="code" i]'
            );
            return inputs.length > 0;
          `,
        ).catch(() => false);
        if (!hasAuthInputs) continue;
        const frameHtml = String(await frame.content().catch(() => ""));
        if (!frameHtml) continue;
        const frameText = trimText(chooseReadableText("text/html", frameHtml), 3000);
        const frameRows = await buildLiveActionRefs(frame).catch(() => []);
        const frameRefs = frameRows.map((row, idx) => ({
          ref: `e${frameRefBase + idx + 1}`,
          kind: row.kind,
          role: row.role,
          name: row.name,
          selector: `frame:${fi}:${row.selector}`,
          url: row.url,
          formIndex: row.formIndex,
          fieldName: row.fieldName,
          method: row.method,
        }));
        snapshot.text += `\n\n## Embedded Auth Frame (${frameUrl})\n${frameText}`;
        snapshot.refs = [...snapshot.refs, ...frameRefs];
        frameRefBase += frameRefs.length;
      } catch {
        // Skip inaccessible or broken frames.
      }
    }
  } catch {
    // page.frames() unavailable — skip iframe detection.
  }

  tab.lastHtml = html;
  tab.forms = forms;
  tab.formValues = buildDefaultFormValues(forms);
  tab.url = finalUrl;
  if (tab.history.length > 0) {
    tab.history[tab.historyIndex] = finalUrl;
  }
  tab.title = title;
  tab.lastSnapshot = snapshot;
  tab.updatedAt = Date.now();
  await syncTabCookiesFromLiveContext(tab, finalUrl);
  await syncTabStorageFromLiveContext(tab);
  return snapshot;
}

async function captureLiveScreenshot(tab: BrowserTab, params: Record<string, unknown>): Promise<{
  path: string;
  bytes: number;
  width: number;
  height: number;
  url: string;
  type: "png" | "jpeg";
}> {
  const page = getLivePage(tab.id);
  if (!page) {
    throw new Error(`live browser page missing for tab ${tab.id}.`);
  }
  const width = clampInt(params.width, 320, 4096, DEFAULT_SCREENSHOT_WIDTH);
  const height = clampInt(params.height, 240, 4096, DEFAULT_SCREENSHOT_HEIGHT);
  const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
  const requestedType = String(params.type ?? "").trim().toLowerCase();
  const shotType: "png" | "jpeg" = requestedType === "jpeg" || requestedType === "jpg" ? "jpeg" : "png";
  const ext = shotType === "jpeg" ? "jpg" : "png";
  const filePath = path.join(
    os.tmpdir(),
    `t560-browser-live-shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`,
  );

  await page.setViewportSize({ width, height });
  await page.screenshot({
    path: filePath,
    type: shotType,
    timeout: timeoutMs,
    fullPage: params.fullPage === true,
  });
  const info = await stat(filePath);
  return {
    path: filePath,
    bytes: info.size,
    width,
    height,
    url: normalizeHttpUrl(page.url() || tab.url),
    type: shotType,
  };
}

function escapeCssAttributeValue(value: string): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function normalizeDateInputValue(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    return raw;
  }
  const yyyy = String(parsed.getUTCFullYear()).padStart(4, "0");
  const mm = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(parsed.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function fillLiveLocatorWithDateFallback(params: {
  locator: any;
  value: string;
  timeoutMs: number;
  typeMode: "type" | "fill";
  slowly: boolean;
  submit: boolean;
}): Promise<void> {
  const normalized = normalizeDateInputValue(params.value);
  if (params.typeMode === "type") {
    try {
      await params.locator.fill("", { timeout: params.timeoutMs });
    } catch {
      // continue to fallback typing path
    }
  }
  try {
    await params.locator.fill(normalized, { timeout: params.timeoutMs });
    if (params.typeMode === "type" && params.submit) {
      const submitted = await submitNearestFormFromInput(params.locator, params.timeoutMs);
      if (!submitted) {
        throw new Error(
          "Unable to submit typed form without triggering social/OAuth controls. Use browser action=submit or browser action=login.",
        );
      }
    }
    return;
  } catch {
    // Continue to keyboard and script-based fallback.
  }

  try {
    await params.locator.click({ timeout: Math.min(params.timeoutMs, 4000) });
  } catch {
    // no-op
  }
  try {
    await params.locator.press("Control+A", { timeout: Math.min(params.timeoutMs, 3000) });
    await params.locator.type(normalized, {
      timeout: params.timeoutMs,
      ...(params.slowly ? { delay: 35 } : {}),
    });
    await params.locator.press("Enter", { timeout: Math.min(params.timeoutMs, 3000) });
  } catch {
    // Fall through to DOM-level value assignment.
  }
  await params.locator.evaluate(
    (el: any, args: { value: string }) => {
      const node = el as any;
      if (!node) {
        return;
      }
      const asInput = node as any;
      const asDate = String(args.value ?? "");
      if (typeof asInput.showPicker === "function") {
        try {
          asInput.showPicker();
        } catch {
          // Some browsers block picker open without user gesture.
        }
      }
      try {
        asInput.value = asDate;
      } catch {
        // Keep best effort behavior.
      }
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      node.dispatchEvent(new Event("blur", { bubbles: true }));
    },
    { value: normalized },
  );
  if (params.typeMode === "type" && params.submit) {
    const submitted = await submitNearestFormFromInput(params.locator, params.timeoutMs);
    if (!submitted) {
      throw new Error(
        "Unable to submit typed form without triggering social/OAuth controls. Use browser action=submit or browser action=login.",
      );
    }
  }
}

async function liveFillFormField(tab: BrowserTab, form: BrowserForm, field: BrowserFormField, value: string): Promise<void> {
  const page = getLivePage(tab.id);
  if (!page) {
    return;
  }
  const selector = `form:nth-of-type(${form.index}) [name="${escapeCssAttributeValue(field.name)}"]`;
  if (String(field.type ?? "").toLowerCase() === "date") {
    try {
      await fillLiveLocatorWithDateFallback({
        locator: page.locator(selector).first(),
        value,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        typeMode: "fill",
        slowly: false,
        submit: false,
      });
      return;
    } catch {
      // Fall through to generic fill path.
    }
  }
  try {
    await page.locator(selector).first().fill(value);
    return;
  } catch {
    // Fall through to DOM eval fallback.
  }
  try {
    await evalPageScript(
      page,
      `
        const forms = Array.from(document.querySelectorAll("form"));
        const formEl = forms[args.formIndex - 1];
        if (!formEl) {
          return;
        }
        const escapedFieldName = String(args.fieldName).replace(/["\\\\]/g, "\\\\$&");
        const target = formEl.querySelector('[name="' + escapedFieldName + '"]');
        if (!target) {
          return;
        }
        target.value = String(args.value ?? "");
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
      `,
      {
        formIndex: form.index,
        fieldName: field.name,
        value,
      },
    );
  } catch {
    // Keep internal form state even if browser-side fill fails.
  }
}

async function liveSubmitForm(tab: BrowserTab, form: BrowserForm, timeoutMs: number): Promise<void> {
  const page = getLivePage(tab.id);
  if (!page) {
    throw new Error(`live browser page missing for tab ${tab.id}.`);
  }
  assertNotSocialAuthTarget({
    label: "",
    href: form.action,
    context: "",
    action: "form submission",
  });
  const values = tab.formValues[form.index] ?? {};
  const outcome = await evalPageScript<{ submitted: boolean; blockedBySocialSubmit: boolean }>(
    page,
    `
      const forms = Array.from(document.querySelectorAll("form"));
      const formEl = forms[args.formIndex - 1];
      if (!formEl) {
        return { submitted: false, blockedBySocialSubmit: false };
      }
      const entries = Object.entries(args.values || {});
      for (const [name, value] of entries) {
        const escapedName = String(name).replace(/["\\\\]/g, "\\\\$&");
        const target = formEl.querySelector('[name="' + escapedName + '"]');
        if (!target) {
          continue;
        }
        target.value = String(value ?? "");
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const controls = Array.from(formEl.querySelectorAll("button, input[type='submit'], input[type='image']"));
      let sawSubmitControl = false;
      for (const control of controls) {
        if (!control || typeof control !== "object") {
          continue;
        }
        const tagName = String(control.tagName ?? "").trim().toLowerCase();
        const rawType = String(control.getAttribute?.("type") ?? "").trim().toLowerCase();
        if (tagName === "button" && rawType && rawType !== "submit") {
          continue;
        }
        sawSubmitControl = true;
        const label = String(
          control.getAttribute?.("aria-label") ??
            control.getAttribute?.("title") ??
            control.getAttribute?.("name") ??
            (typeof control.value === "string" ? control.value : "") ??
            control.textContent ??
            "",
        )
          .replace(/\\s+/g, " ")
          .trim()
          .toLowerCase();
        const href = String(
          control.getAttribute?.("formaction") ??
            (typeof control.href === "string" ? control.href : "") ??
            "",
        )
          .trim()
          .toLowerCase();
        const context = String(
          \`\${control.getAttribute?.("id") ?? ""} \${control.getAttribute?.("class") ?? ""} \${control.getAttribute?.("data-testid") ?? ""} \${control.getAttribute?.("data-provider") ?? ""}\`,
        )
          .replace(/\\s+/g, " ")
          .trim()
          .toLowerCase();
        const providerSignal = /\\b(google|apple|microsoft|github|facebook|linkedin|twitter|x)\\b/.test(
          \`\${label} \${context} \${href}\`,
        );
        const authSignal = /\\b(sign in|log in|login|oauth|sso|single sign[-\\s]?on|auth)\\b/.test(
          \`\${label} \${context} \${href}\`,
        );
        const social =
          /\\b(continue|sign in|log in)\\s+with\\b/.test(label) ||
          /\\b(accounts\\.google\\.com|appleid\\.apple\\.com|microsoftonline\\.com|oauth|sso)\\b/.test(href) ||
          /\\/auth\\/(google|apple|microsoft|github|facebook|linkedin|twitter|x)\\b/.test(href) ||
          (providerSignal && authSignal);
        if (social) {
          continue;
        }
        control.click();
        return { submitted: true, blockedBySocialSubmit: false };
      }
      if (sawSubmitControl) {
        return { submitted: false, blockedBySocialSubmit: true };
      }
      if (typeof formEl.requestSubmit === "function") {
        formEl.requestSubmit();
        return { submitted: true, blockedBySocialSubmit: false };
      }
      if (typeof formEl.submit === "function") {
        formEl.submit();
        return { submitted: true, blockedBySocialSubmit: false };
      }
      return {
        submitted: formEl.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
        blockedBySocialSubmit: false,
      };
    `,
    {
      formIndex: form.index,
      values,
    },
  );
  if (outcome?.blockedBySocialSubmit) {
    throw new Error(
      "Blocked form submission because only social/OAuth submit controls were detected. Use browser action=login with vault credentials.",
    );
  }
  if (!outcome?.submitted) {
    throw new Error("Failed to submit live form.");
  }
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeoutMs, 5000) });
  } catch {
    // SPA submits often do not trigger a full navigation.
  }
  try {
    await page.waitForTimeout(250);
  } catch {
    // no-op
  }
}

function findClickTarget(tab: BrowserTab, params: Record<string, unknown>): BrowserLink {
  const snapshot = tab.lastSnapshot;
  if (!snapshot) {
    throw new Error("no snapshot available for click. run snapshot first.");
  }

  const byRef = resolveSnapshotRef(tab, params.ref);
  if (byRef) {
    if (byRef.kind !== "link" || !byRef.url) {
      throw new Error(`ref ${byRef.ref} is not a clickable link.`);
    }
    return {
      index: -1,
      text: byRef.name,
      url: byRef.url,
    };
  }

  const links = snapshot.links ?? [];
  if (links.length === 0) {
    throw new Error("snapshot has no clickable links.");
  }

  const byIndexRaw = params.linkIndex;
  if (byIndexRaw !== undefined && byIndexRaw !== null) {
    const index = clampInt(byIndexRaw, 1, 1_000_000, 1);
    const found = links.find((link) => link.index === index);
    if (!found) {
      throw new Error(`link index ${index} not found in snapshot.`);
    }
    return found;
  }

  const byText = String(params.linkText ?? "").trim().toLowerCase();
  if (byText) {
    const found = links.find((link) => link.text.toLowerCase().includes(byText));
    if (found) {
      return found;
    }
  }

  const byHref = String(params.hrefContains ?? "").trim().toLowerCase();
  if (byHref) {
    const found = links.find((link) => link.url.toLowerCase().includes(byHref));
    if (found) {
      return found;
    }
  }

  throw new Error("click requires ref, linkIndex, linkText, or hrefContains.");
}

function selectorForRef(ref: BrowserElementRef): string | null {
  if (ref.selector) {
    return ref.selector;
  }
  if (ref.kind === "field" && ref.formIndex && ref.fieldName) {
    return `form:nth-of-type(${ref.formIndex}) [name="${escapeCssAttributeValue(ref.fieldName)}"]`;
  }
  if (ref.kind === "submit" && ref.formIndex) {
    return `form:nth-of-type(${ref.formIndex}) button[type="submit"], form:nth-of-type(${ref.formIndex}) input[type="submit"], form:nth-of-type(${ref.formIndex}) button, form:nth-of-type(${ref.formIndex}) [role="button"]`;
  }
  if (ref.kind === "link") {
    if (ref.url) {
      return `a[href="${escapeCssAttributeValue(ref.url)}"]`;
    }
    if (ref.name) {
      return `a:has-text("${escapeCssAttributeValue(ref.name)}")`;
    }
  }
  if (ref.kind === "form" && ref.formIndex) {
    return `form:nth-of-type(${ref.formIndex})`;
  }
  if (ref.kind === "button" && ref.name) {
    return `button:has-text("${escapeCssAttributeValue(ref.name)}"), [role="button"]:has-text("${escapeCssAttributeValue(ref.name)}")`;
  }
  return null;
}

function requireLivePage(tab: BrowserTab): any {
  const page = getLivePage(tab.id);
  if (!page) {
    throw new Error(`tab ${tab.id} is not backed by a live browser page.`);
  }
  return page;
}

function getExplicitSelector(params: Record<string, unknown>, key = "selector"): string {
  return String(params[key] ?? "").trim();
}

function resolveActionSelector(tab: BrowserTab, params: Record<string, unknown>, options?: {
  allowKinds?: Array<BrowserElementRef["kind"]>;
  selectorKey?: string;
}): { selector: string; ref: BrowserElementRef | null } {
  const selectorKey = options?.selectorKey ?? "selector";
  const explicitSelector = getExplicitSelector(params, selectorKey);
  if (explicitSelector) {
    return { selector: explicitSelector, ref: null };
  }
  const ref = resolveSnapshotRef(tab, params.ref);
  if (!ref) {
    throw new Error(`${selectorKey} or ref is required.`);
  }
  if (options?.allowKinds && !options.allowKinds.includes(ref.kind)) {
    throw new Error(`ref ${ref.ref} has unsupported kind ${ref.kind} for this action.`);
  }
  const selector = selectorForRef(ref);
  if (!selector) {
    throw new Error(`could not resolve selector for ref ${ref.ref}.`);
  }
  return { selector, ref };
}

function normalizeClickButton(value: unknown): "left" | "right" | "middle" {
  const raw = String(value ?? "left").trim().toLowerCase();
  if (raw === "right" || raw === "middle") {
    return raw;
  }
  return "left";
}

function normalizeClickModifiers(value: unknown): Array<"Alt" | "Control" | "Meta" | "Shift"> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const allowed = new Set(["Alt", "Control", "Meta", "Shift"]);
  const out: Array<"Alt" | "Control" | "Meta" | "Shift"> = [];
  for (const item of value) {
    const raw = String(item ?? "").trim().toLowerCase();
    const normalized =
      raw === "alt"
        ? "Alt"
        : raw === "control" || raw === "ctrl"
          ? "Control"
          : raw === "meta" || raw === "cmd" || raw === "command"
            ? "Meta"
            : raw === "shift"
              ? "Shift"
              : "";
    if (!normalized || !allowed.has(normalized) || out.includes(normalized as any)) {
      continue;
    }
    out.push(normalized as "Alt" | "Control" | "Meta" | "Shift");
  }
  return out.length > 0 ? out : undefined;
}

function findLiveLinkRefForClick(tab: BrowserTab, params: Record<string, unknown>): BrowserElementRef | null {
  const snapshot = tab.lastSnapshot;
  if (!snapshot) {
    return null;
  }
  const refs = snapshot.refs ?? [];
  const linkRefs = refs.filter((entry) => entry.kind === "link");
  if (linkRefs.length === 0) {
    return null;
  }

  const linkIndexRaw = params.linkIndex;
  if (linkIndexRaw !== undefined && linkIndexRaw !== null) {
    const index = clampInt(linkIndexRaw, 1, 1_000_000, 1);
    const byIndex = snapshot.links.find((entry) => entry.index === index);
    if (!byIndex) {
      throw new Error(`link index ${index} not found in snapshot.`);
    }
    return (
      linkRefs.find((entry) => String(entry.url ?? "") === byIndex.url) ??
      linkRefs.find((entry) => entry.name === byIndex.text) ??
      null
    );
  }

  const linkText = String(params.linkText ?? "").trim().toLowerCase();
  if (linkText) {
    const byText = linkRefs.find((entry) => String(entry.name ?? "").toLowerCase().includes(linkText));
    if (byText) {
      return byText;
    }
  }

  const hrefContains = String(params.hrefContains ?? "").trim().toLowerCase();
  if (hrefContains) {
    const byHref = linkRefs.find((entry) => String(entry.url ?? "").toLowerCase().includes(hrefContains));
    if (byHref) {
      return byHref;
    }
  }

  return null;
}

async function registerPopupTabFromLivePage(
  parentTab: BrowserTab,
  popup: any,
  params: Record<string, unknown>,
): Promise<{ tab: BrowserTab; snapshot: BrowserSnapshot | null }> {
  const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
  const fallbackUrl = normalizeHttpUrlOrFallback(parentTab.url, "https://duckduckgo.com/");
  const initialUrl = normalizeHttpUrlOrFallback(String(popup?.url?.() ?? ""), fallbackUrl);
  const popupTab = createBackgroundTab(initialUrl);
  attachLivePage(popupTab.id, popup);

  try {
    await popup.waitForLoadState("domcontentloaded", { timeout: Math.min(timeoutMs, 10_000) });
  } catch {
    // popup can remain on about:blank until async navigation; continue best-effort.
  }

  const snapshotAfter = params.snapshotAfter !== false;
  if (snapshotAfter) {
    try {
      const snapshot = await captureLiveTabSnapshot(popupTab, params);
      return { tab: popupTab, snapshot };
    } catch {
      // Continue with basic metadata if snapshot capture fails (cross-origin timing/transient popup state).
    }
  }

  const liveUrl = normalizeHttpUrlOrFallback(String(popup?.url?.() ?? ""), popupTab.url);
  popupTab.url = liveUrl;
  if (popupTab.history.length > 0) {
    popupTab.history[popupTab.historyIndex] = liveUrl;
  }
  popupTab.title = String((await popup?.title?.()) ?? "").trim() || summarizeTitleFromUrl(liveUrl);
  popupTab.updatedAt = Date.now();
  return { tab: popupTab, snapshot: null };
}

function resolveSetupServiceFromBrowserInput(serviceRaw: unknown, currentUrl: string): string | null {
  const explicit = normalizeSetupService(String(serviceRaw ?? ""));
  if (explicit) {
    return explicit;
  }
  const url = String(currentUrl ?? "").trim().toLowerCase();
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return normalizeSetupService(parsed.hostname) ?? null;
  } catch {
    return null;
  }
}

function deriveServiceCandidates(params: {
  explicitServiceRaw: unknown;
  currentUrl: string;
}): string[] {
  const candidates: string[] = [];
  const push = (value: string | null) => {
    const normalized = normalizeSetupService(String(value ?? ""));
    if (!normalized) {
      return;
    }
    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  const explicit = normalizeSetupService(String(params.explicitServiceRaw ?? ""));
  if (explicit) {
    push(explicit);
  }

  const liveService = resolveSetupServiceFromBrowserInput("", params.currentUrl);
  if (liveService) {
    // Host-specific service is more precise than short alias.
    candidates.unshift(liveService);
    if (liveService.includes(".")) {
      push(liveService.split(".")[0] ?? "");
    }
  }

  if (explicit && explicit.includes(".")) {
    push(explicit.split(".")[0] ?? "");
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

function normalizeHostFromValue(value: string): string | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (raw.includes("://")) {
    try {
      const host = new URL(raw).hostname.trim().toLowerCase().replace(/^www\./, "");
      return host || null;
    } catch {
      // fallback to normalized service parser below
    }
  }
  return normalizeSetupService(raw);
}

function hostsLikelyMatch(a: string | null, b: string | null): boolean {
  const left = String(a ?? "").trim().toLowerCase().replace(/^www\./, "");
  const right = String(b ?? "").trim().toLowerCase().replace(/^www\./, "");
  if (!left || !right) {
    return false;
  }
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

async function resolveCredentialForCandidates(params: {
  workspaceDir: string;
  serviceCandidates: string[];
  currentUrl: string;
}): Promise<{ service: string; credential: NonNullable<Awaited<ReturnType<typeof getCredential>>> } | null> {
  for (const candidate of params.serviceCandidates) {
    const found = await getCredential({
      workspaceDir: params.workspaceDir,
      service: candidate,
    });
    if (found) {
      return {
        service: candidate,
        credential: found,
      };
    }
  }

  const currentHost = normalizeHostFromValue(params.currentUrl);
  if (!currentHost) {
    return null;
  }
  const configured = await listConfiguredServices(params.workspaceDir);
  for (const service of configured) {
    const credential = await getCredential({
      workspaceDir: params.workspaceDir,
      service,
    });
    if (!credential) {
      continue;
    }
    const websiteHost = normalizeHostFromValue(String(credential.websiteUrl ?? ""));
    if (hostsLikelyMatch(currentHost, service) || hostsLikelyMatch(currentHost, websiteHost)) {
      return {
        service,
        credential,
      };
    }
  }
  return null;
}

function maskCredentialIdentifier(identifier: string): string {
  const value = String(identifier ?? "").trim();
  if (!value) {
    return "(empty)";
  }
  const atIndex = value.indexOf("@");
  if (atIndex > 1) {
    return `${value.slice(0, 1)}***${value.slice(atIndex)}`;
  }
  if (value.length <= 4) {
    return `${value[0] ?? "*"}***`;
  }
  return `${value.slice(0, 2)}***${value.slice(-1)}`;
}

function isSocialAuthUrl(value: string): boolean {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) {
    return false;
  }
  return (
    /\b(accounts\.google\.com|appleid\.apple\.com|microsoftonline\.com|oauth|sso)\b/.test(text) ||
    /\/auth\/(google|apple|microsoft|github|facebook|linkedin|twitter|x)\b/.test(text)
  );
}

function isSocialAuthLabel(value: string): boolean {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) {
    return false;
  }
  return (
    /\b(google|apple|microsoft|github|facebook|linkedin|twitter|x|oauth|sso|single sign[-\s]?on)\b/.test(
      text,
    ) ||
    /\b(continue|sign in|log in)\s+with\b/.test(text)
  );
}

function isLikelySocialAuthTarget(params: {
  label?: string;
  href?: string;
  context?: string;
}): boolean {
  const label = String(params.label ?? "").trim().toLowerCase();
  const href = String(params.href ?? "").trim().toLowerCase();
  const context = String(params.context ?? "").trim().toLowerCase();
  if (isSocialAuthUrl(href)) {
    return true;
  }
  if (/\b(continue|sign in|log in)\s+with\b/.test(label)) {
    return true;
  }
  const providerSignal = /\b(google|apple|microsoft|github|facebook|linkedin|twitter|x)\b/.test(
    `${label} ${context} ${href}`,
  );
  const authSignal = /\b(sign in|log in|login|oauth|sso|single sign[-\s]?on|auth)\b/.test(
    `${label} ${context} ${href}`,
  );
  return providerSignal && authSignal;
}

function assertNotSocialAuthTarget(params: {
  label?: string;
  href?: string;
  context?: string;
  action: string;
}): void {
  if (!isLikelySocialAuthTarget(params)) {
    return;
  }
  throw new Error(
    `Blocked ${params.action} because the target appears to be social/OAuth sign-in. Use browser action=login with vault credentials.`,
  );
}

async function readLocatorAuthMetadata(locator: any): Promise<{
  label: string;
  href: string;
  context: string;
}> {
  try {
    const meta = await locator.evaluate((el: any) => {
      const node = el && typeof el === "object" ? el : null;
      const attr = (name: string) =>
        String((node && typeof node.getAttribute === "function" ? node.getAttribute(name) : "") ?? "");
      const textParts = [
        attr("aria-label"),
        attr("title"),
        attr("name"),
        typeof node?.value === "string" ? node.value : "",
        typeof node?.innerText === "string" ? node.innerText : "",
        typeof node?.textContent === "string" ? node.textContent : "",
      ]
        .map((part) => String(part ?? "").trim())
        .filter(Boolean);
      const anchor = node?.closest?.("a");
      const href =
        String(
          (typeof node?.href === "string" ? node.href : "") ||
            (typeof anchor?.href === "string" ? anchor.href : "") ||
            attr("formaction"),
        ) || "";
      const contextParts = [
        attr("id"),
        attr("class"),
        attr("data-testid"),
        attr("data-test"),
        attr("data-provider"),
        attr("role"),
        attr("type"),
      ]
        .map((part) => String(part ?? "").trim())
        .filter(Boolean);
      return {
        label: textParts.join(" ").slice(0, 600),
        href: href.slice(0, 600),
        context: contextParts.join(" ").slice(0, 600),
      };
    });
    return {
      label: String(meta?.label ?? ""),
      href: String(meta?.href ?? ""),
      context: String(meta?.context ?? ""),
    };
  } catch {
    return { label: "", href: "", context: "" };
  }
}

async function assertLocatorNotSocialAuth(locator: any, action: string): Promise<void> {
  const metadata = await readLocatorAuthMetadata(locator);
  assertNotSocialAuthTarget({
    ...metadata,
    action,
  });
}

async function submitNearestFormFromInput(inputLocator: any, timeoutMs: number): Promise<boolean> {
  let blockedBySocialSubmit = false;
  try {
    const outcome = await inputLocator.evaluate((el: any) => {
      const input = el;
      const form = input?.form ?? input?.closest?.("form");
      if (!form) {
        return { submitted: false, blockedBySocialSubmit: false };
      }

      const controls = Array.from(form.querySelectorAll("button, input[type='submit'], input[type='image']"));
      let sawSubmitControl = false;
      for (const control of controls) {
        if (!control || typeof control !== "object") {
          continue;
        }
        const element = control as any;
        const tagName = String(element.tagName ?? "").trim().toLowerCase();
        const rawType = String(element.getAttribute?.("type") ?? "").trim().toLowerCase();
        if (tagName === "button" && rawType && rawType !== "submit") {
          continue;
        }
        sawSubmitControl = true;
        const label = String(
          element.getAttribute?.("aria-label") ??
            element.getAttribute?.("title") ??
            element.getAttribute?.("name") ??
            (typeof element.value === "string" ? element.value : "") ??
            element.textContent ??
            "",
        )
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        const href = String(
          element.getAttribute?.("formaction") ??
            (typeof element.href === "string" ? element.href : "") ??
            "",
        )
          .trim()
          .toLowerCase();
        const context = String(
          `${element.getAttribute?.("id") ?? ""} ${element.getAttribute?.("class") ?? ""} ${
            element.getAttribute?.("data-testid") ?? ""
          } ${element.getAttribute?.("data-provider") ?? ""}`,
        )
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        const providerSignal = /\b(google|apple|microsoft|github|facebook|linkedin|twitter|x)\b/.test(
          `${label} ${context} ${href}`,
        );
        const authSignal = /\b(sign in|log in|login|oauth|sso|single sign[-\s]?on|auth)\b/.test(
          `${label} ${context} ${href}`,
        );
        const social =
          /\b(continue|sign in|log in)\s+with\b/.test(label) ||
          /\b(accounts\.google\.com|appleid\.apple\.com|microsoftonline\.com|oauth|sso)\b/.test(href) ||
          /\/auth\/(google|apple|microsoft|github|facebook|linkedin|twitter|x)\b/.test(href) ||
          (providerSignal && authSignal);
        if (social) {
          continue;
        }
        element.click();
        return { submitted: true, blockedBySocialSubmit: false };
      }
      if (sawSubmitControl) {
        return { submitted: false, blockedBySocialSubmit: true };
      }
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
        return { submitted: true, blockedBySocialSubmit: false };
      }
      return {
        submitted: form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
        blockedBySocialSubmit: false,
      };
    });
    if (outcome?.submitted) {
      return true;
    }
    blockedBySocialSubmit = Boolean(outcome?.blockedBySocialSubmit);
  } catch {
    // no-op
  }
  if (blockedBySocialSubmit) {
    return false;
  }
  try {
    await inputLocator.press("Enter", { timeout: Math.min(timeoutMs, 5000) });
    return true;
  } catch {
    return false;
  }
}

async function clickRoleButtonExcludingSocial(params: {
  page: any;
  namePattern: RegExp;
  timeoutMs: number;
}): Promise<boolean> {
  const locator = params.page.getByRole("button", { name: params.namePattern });
  const count = Number(await locator.count().catch(() => 0));
  if (!Number.isFinite(count) || count < 1) {
    return false;
  }
  const limit = Math.min(count, 10);
  for (let index = 0; index < limit; index += 1) {
    const button = locator.nth(index);
    const label = String(
      (await button.getAttribute("aria-label").catch(() => "")) ||
        (await button.innerText().catch(() => "")) ||
        (await button.textContent().catch(() => "")),
    )
      .trim()
      .toLowerCase();
    if (isSocialAuthLabel(label)) {
      continue;
    }
    try {
      await button.click({ timeout: Math.min(params.timeoutMs, 5000) });
      return true;
    } catch {
      // try next candidate
    }
  }
  return false;
}

async function clickFirstNonSocialSelector(params: {
  page: any;
  selectors: string[];
  timeoutMs: number;
}): Promise<boolean> {
  for (const selector of params.selectors) {
    const target = await selectFirstUsableLocator(params.page, [selector], Math.min(params.timeoutMs, 5000));
    if (!target) {
      continue;
    }
    const metadata = await readLocatorAuthMetadata(target.locator);
    if (isLikelySocialAuthTarget(metadata)) {
      continue;
    }
    try {
      await target.locator.click({ timeout: Math.min(params.timeoutMs, 5000) });
      return true;
    } catch {
      // try next selector
    }
  }
  return false;
}

async function loginPageLooksStuckPreparing(page: any): Promise<boolean> {
  try {
    return await evalPageScript<boolean>(
      page,
      `
        const bodyText = String((document && document.body && document.body.innerText) || "").toLowerCase();
        const preparing =
          bodyText.includes("preparing your account") && bodyText.includes("please wait");
        if (!preparing) {
          return false;
        }
        const hasCredentialSurface = Boolean(
          document.querySelector(
            'input[type="email"],input[name="identifier"],input[autocomplete="username"],input[type="password"],input[autocomplete="one-time-code"],input[name*="otp" i],input[id*="otp" i],input[name*="code" i],input[id*="code" i],button[type="submit"],input[type="submit"]',
          ),
        );
        return !hasCredentialSurface;
      `,
    );
  } catch {
    return false;
  }
}

function classifyChallengeSignals(params: {
  text: string;
  url: string;
  hasRecaptcha: boolean;
  hasHcaptcha: boolean;
  hasTurnstile: boolean;
  hasCaptchaSelector: boolean;
}): {
  detected: boolean;
  provider: string | null;
  confidence: "none" | "low" | "medium" | "high";
  signals: string[];
} {
  const text = String(params.text ?? "").toLowerCase();
  const url = String(params.url ?? "").toLowerCase();
  const signals: string[] = [];
  let provider: string | null = null;

  if (params.hasRecaptcha || /recaptcha/.test(text) || /google\.com\/recaptcha/.test(url)) {
    provider = "recaptcha";
    signals.push("recaptcha");
  }
  if (!provider && (params.hasHcaptcha || /\bhcaptcha\b/.test(text) || /hcaptcha\.com/.test(url))) {
    provider = "hcaptcha";
    signals.push("hcaptcha");
  }
  if (
    !provider &&
    (params.hasTurnstile || /\bturnstile\b/.test(text) || /challenges\.cloudflare\.com/.test(url))
  ) {
    provider = "cloudflare-turnstile";
    signals.push("turnstile");
  }
  if (!provider && /\barkose\b|\bfuncaptcha\b/.test(text)) {
    provider = "arkose";
    signals.push("arkose");
  }

  if (params.hasCaptchaSelector) {
    signals.push("captcha-selector");
  }
  if (/\b(verify you are human|are you human|i['’]?m not a robot|security check|prove you are human)\b/.test(text)) {
    signals.push("human-verification-copy");
  }
  if (/\b(checking your browser|just a moment|ddos protection)\b/.test(text) || /cdn-cgi\/challenge/.test(url)) {
    signals.push("challenge-page-copy");
  }

  const detected = signals.length > 0;
  let confidence: "none" | "low" | "medium" | "high" = "none";
  if (detected) {
    const hardSignals =
      params.hasRecaptcha ||
      params.hasHcaptcha ||
      params.hasTurnstile ||
      /cdn-cgi\/challenge/.test(url) ||
      /google\.com\/recaptcha|hcaptcha\.com|challenges\.cloudflare\.com/.test(url);
    confidence = hardSignals ? "high" : signals.length >= 2 ? "medium" : "low";
  }
  return {
    detected,
    provider,
    confidence,
    signals,
  };
}

async function detectInteractiveChallengeLive(page: any): Promise<{
  detected: boolean;
  provider: string | null;
  confidence: "none" | "low" | "medium" | "high";
  signals: string[];
  url: string;
}> {
  try {
    const probe = await evalPageScript<{
      text: string;
      url: string;
      hasRecaptcha: boolean;
      hasHcaptcha: boolean;
      hasTurnstile: boolean;
      hasCaptchaSelector: boolean;
    }>(
      page,
      `
        const bodyText = String((document && document.body && document.body.innerText) || "");
        const hasRecaptcha = Boolean(
          document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey][class*="recaptcha" i]'),
        );
        const hasHcaptcha = Boolean(
          document.querySelector('iframe[src*="hcaptcha"], [data-sitekey][class*="hcaptcha" i]'),
        );
        const hasTurnstile = Boolean(
          document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile, [data-sitekey][class*="turnstile" i]'),
        );
        const hasCaptchaSelector = Boolean(
          document.querySelector('[id*="captcha" i],[class*="captcha" i],[name*="captcha" i]'),
        );
        return {
          text: bodyText.slice(0, 12000),
          url: String(location?.href ?? ""),
          hasRecaptcha,
          hasHcaptcha,
          hasTurnstile,
          hasCaptchaSelector,
        };
      `,
    );
    const classified = classifyChallengeSignals({
      text: probe.text,
      url: probe.url,
      hasRecaptcha: probe.hasRecaptcha,
      hasHcaptcha: probe.hasHcaptcha,
      hasTurnstile: probe.hasTurnstile,
      hasCaptchaSelector: probe.hasCaptchaSelector,
    });
    return {
      ...classified,
      url: String(probe.url ?? ""),
    };
  } catch {
    return {
      detected: false,
      provider: null,
      confidence: "none",
      signals: [],
      url: "",
    };
  }
}

function detectInteractiveChallengeFromFetchSnapshot(tab: BrowserTab): {
  detected: boolean;
  provider: string | null;
  confidence: "none" | "low" | "medium" | "high";
  signals: string[];
  url: string;
} {
  const text = [String(tab.lastSnapshot?.text ?? ""), String(tab.lastHtml ?? "")]
    .filter(Boolean)
    .join("\n")
    .slice(0, 20000);
  const url = String(tab.lastSnapshot?.url ?? tab.url ?? "");
  const hasRecaptcha = /g-recaptcha|recaptcha/i.test(text);
  const hasHcaptcha = /\bhcaptcha\b/i.test(text);
  const hasTurnstile = /\bturnstile\b|challenges\.cloudflare\.com/i.test(text);
  const hasCaptchaSelector = /\bcaptcha\b/i.test(text);
  return {
    ...classifyChallengeSignals({
      text,
      url,
      hasRecaptcha,
      hasHcaptcha,
      hasTurnstile,
      hasCaptchaSelector,
    }),
    url,
  };
}

async function selectFirstUsableLocator(page: any, selectors: string[], timeoutMs: number): Promise<{
  selector: string;
  locator: any;
} | null> {
  for (const selector of selectors) {
    const normalized = String(selector ?? "").trim();
    if (!normalized) {
      continue;
    }
    try {
      const locator = page.locator(normalized);
      const count = Number(await locator.count());
      if (!Number.isFinite(count) || count < 1) {
        continue;
      }
      const limit = Math.min(count, 12);
      let fallbackCandidate: any = null;
      for (let index = 0; index < limit; index += 1) {
        const candidate = locator.nth(index);
        if (!fallbackCandidate) {
          fallbackCandidate = candidate;
        }
        const visible = await candidate.isVisible().catch(() => false);
        if (!visible) {
          continue;
        }
        const enabled = await candidate
          .evaluate((el: any) => {
            const node = el as any;
            if (!node || typeof node !== "object") {
              return true;
            }
            if (Boolean(node.disabled)) {
              return false;
            }
            const ariaDisabled = String(node.getAttribute?.("aria-disabled") ?? "")
              .trim()
              .toLowerCase();
            if (ariaDisabled === "true") {
              return false;
            }
            return true;
          })
          .catch(() => true);
        if (!enabled) {
          continue;
        }
        try {
          await candidate.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 700) });
        } catch {
          // best effort; candidate may still be actionable
        }
        return { selector: normalized, locator: candidate };
      }
      if (fallbackCandidate) {
        return { selector: normalized, locator: fallbackCandidate };
      }
    } catch {
      // Keep trying next selector.
    }
  }
  return null;
}

async function performLiveCredentialLogin(params: {
  tab: BrowserTab;
  service: string;
  identifier: string;
  secret: string;
  authMode: "password" | "password_with_mfa" | "passwordless_mfa_code";
  timeoutMs: number;
}): Promise<{
  service: string;
  identifier: string;
  identifierMasked: string;
  identifierSelector: string;
  passwordSelector: string | null;
  submitted: boolean;
  requiresMfa: boolean;
  mfaExpected: boolean;
  authMode: "password" | "password_with_mfa" | "passwordless_mfa_code";
}> {
  const page = requireLivePage(params.tab);
  const timeoutMs = Math.max(1000, params.timeoutMs);
  const isPasswordless = params.authMode === "passwordless_mfa_code";

  const identifierSelectors =
    params.service === "x.com"
      ? [
          'input[name="text"]',
          'input[autocomplete="username"]',
          'input[name="session[username_or_email]"]',
          'input[type="email"]',
          'input[type="text"]',
        ]
      : [
          'input[type="email"]',
          'input[name="identifier"]',
          'input[name="username"]',
          'input[autocomplete="username"]',
          'input[type="text"]',
        ];
  const passwordSelectors =
    params.service === "x.com"
      ? ['input[name="password"]', 'input[type="password"]']
      : ['input[type="password"]', 'input[name="password"]'];
  const mfaInputSelectors = [
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[name*="mfa" i]',
    'input[id*="mfa" i]',
    'input[name*="twofactor" i]',
    'input[id*="twofactor" i]',
    'input[name*="verification" i]',
    'input[id*="verification" i]',
    'input[name*="code" i]',
    'input[id*="code" i]',
  ];
  // Avoid false positives from pre-submit labels like "Send one-time code".
  const mfaHintRegex =
    /\b(enter (?:the )?(?:verification|one[-\s]?time|authentication|security) code|code (?:sent|was sent)|we sent (?:you )?(?:a )?code|check (?:your )?(?:email|inbox)|two[-\s]?factor|2fa|authenticator app|passcode)\b/i;

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeoutMs, 5000) });
  } catch {
    // Continue even if SPA lifecycle does not emit a full load signal.
  }

  // activePage tracks where the login form actually lives — either the main page or a child frame
  // (e.g. an embedded Privy / Auth0 / Clerk iframe). All selector-based interactions after the
  // identifier is found use activePage so that cross-origin auth iframes work correctly.
  let activePage: any = page;

  let identifierTarget = await selectFirstUsableLocator(page, identifierSelectors, Math.min(timeoutMs, 4000));
  if (!identifierTarget) {
    const deadline = Date.now() + Math.min(timeoutMs, 12000);
    while (!identifierTarget && Date.now() < deadline) {
      const stuckPreparing = await loginPageLooksStuckPreparing(page);
      try {
        await page.waitForTimeout(stuckPreparing ? 700 : 300);
      } catch {
        // no-op
      }
      identifierTarget = await selectFirstUsableLocator(page, identifierSelectors, Math.min(timeoutMs, 2500));
      if (identifierTarget) {
        break;
      }
    }
  }
  // If identifier still not found, some sites (e.g. Clerk-based) hide the form behind an
  // entry button like "Get started" or "Sign in". Try clicking one to reveal the form.
  if (!identifierTarget) {
    const entryClicked = await clickRoleButtonExcludingSocial({
      page,
      namePattern: /\b(get started|sign in|log in|login|continue(?: with email)?|use email|enter)\b/i,
      timeoutMs: Math.min(timeoutMs, 4000),
    });
    if (entryClicked) {
      // Give the SPA a moment to render the form after the click.
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeoutMs, 4000) });
      } catch {
        // no-op
      }
      identifierTarget = await selectFirstUsableLocator(page, identifierSelectors, Math.min(timeoutMs, 5000));
    }
  }
  // Last resort: check child frames. Auth providers like Privy, Auth0, and Clerk often
  // embed their sign-in form in a cross-origin iframe rather than the main document.
  if (!identifierTarget) {
    try {
      const allFrames = (page.frames?.() as any[]) ?? [];
      for (let fi = 0; fi < allFrames.length; fi++) {
        const frame = allFrames[fi];
        if (!frame || frame === page.mainFrame?.()) continue;
        const frameUrl = String(frame.url?.() ?? "");
        if (!frameUrl || frameUrl === "about:blank" || frameUrl.startsWith("data:")) continue;
        const found = await selectFirstUsableLocator(frame, identifierSelectors, Math.min(timeoutMs, 3000));
        if (found) {
          identifierTarget = found;
          activePage = frame;
          break;
        }
      }
    } catch {
      // Frame access failed — continue without iframe support.
    }
  }
  if (!identifierTarget) {
    const stuckPreparing = await loginPageLooksStuckPreparing(page);
    if (stuckPreparing) {
      throw new Error(
        "Login page is stuck on 'Preparing your account' and did not render credential fields yet.",
      );
    }
    const challenge = await detectInteractiveChallengeLive(page);
    if (challenge.detected) {
      const provider = challenge.provider ? `${challenge.provider}` : "interactive challenge";
      const signalText = challenge.signals.slice(0, 3).join(", ");
      throw new Error(
        `Login is blocked by ${provider}; human verification is required before credentials can be entered.` +
          (signalText ? ` Signals: ${signalText}.` : ""),
      );
    }
    throw new Error(`No login identifier input was found for service=${params.service}.`);
  }
  await identifierTarget.locator.fill(params.identifier, { timeout: timeoutMs });

  let passwordTarget: { selector: string; locator: any } | null = null;
  if (!isPasswordless) {
    passwordTarget = await selectFirstUsableLocator(activePage, passwordSelectors, timeoutMs);
    if (!passwordTarget && params.service === "x.com") {
      try {
        await activePage.getByRole("button", { name: /next/i }).first().click({ timeout: Math.min(timeoutMs, 5000) });
      } catch {
        // no-op
      }
      passwordTarget = await selectFirstUsableLocator(activePage, passwordSelectors, timeoutMs);
    }
    if (!passwordTarget) {
      throw new Error(`No password input was found for service=${params.service}.`);
    }
    await passwordTarget.locator.fill(params.secret, { timeout: timeoutMs });
  } else {
    // Passwordless submission is handled in the unified submit block below.
  }

  let submitted = false;
  const submitSelectors =
    params.service === "x.com"
      ? [
          'button[data-testid="LoginForm_Login_Button"]',
          'div[role="button"][data-testid="LoginForm_Login_Button"]',
          'button[type="submit"]',
        ]
      : ['button[type="submit"]', 'input[type="submit"]'];
  if (!isPasswordless) {
    if (passwordTarget) {
      submitted = await submitNearestFormFromInput(passwordTarget.locator, timeoutMs);
    }
    if (!submitted) {
      const submitTarget = await selectFirstUsableLocator(activePage, submitSelectors, timeoutMs);
      if (submitTarget) {
        const submitLabel = String(
          (await submitTarget.locator.getAttribute("aria-label").catch(() => "")) ||
            (await submitTarget.locator.innerText().catch(() => "")) ||
            (await submitTarget.locator.textContent().catch(() => "")),
        )
          .trim()
          .toLowerCase();
        if (!isSocialAuthLabel(submitLabel)) {
          try {
            await submitTarget.locator.click({ timeout: timeoutMs });
            submitted = true;
          } catch {
            submitted = false;
          }
        }
      }
    }
  } else {
    submitted = await submitNearestFormFromInput(identifierTarget.locator, timeoutMs);
    if (!submitted) {
      submitted = await clickRoleButtonExcludingSocial({
        page: activePage,
        namePattern: /\b(next|continue|send code|get one[-\s]?time code|verify|sign in|log in)\b/i,
        timeoutMs,
      });
    }
    if (!submitted) {
      submitted = await clickFirstNonSocialSelector({
        page: activePage,
        selectors: [
          'button:has-text("Send one-time code")',
          'button:has-text("Send one time code")',
          'button:has-text("Send code")',
          'button:has-text("Get one-time code")',
          'button:has-text("Get one time code")',
          'button:has-text("Email me a code")',
          'button:has-text("Continue with email")',
          'button:has-text("Continue")',
          'input[type="submit"][value*="code" i]',
          'input[type="submit"][value*="continue" i]',
        ],
        timeoutMs,
      });
    }
  }

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeoutMs, 7000) });
  } catch {
    // SPA auth flows frequently avoid a full load event.
  }

  const detectMfaChallenge = async (probeTimeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + Math.max(0, probeTimeoutMs);
    while (true) {
      // Search in activePage (may be a frame) so that iframe-hosted OTP inputs are detected.
      const mfaInput = await selectFirstUsableLocator(activePage, mfaInputSelectors, Math.min(timeoutMs, 1400));
      if (mfaInput) {
        return true;
      }
      try {
        const hasMfaPrompt = await evalPageScript<boolean>(
          activePage,
          `
            const bodyText = String(
              (typeof document !== "undefined" && document && document.body && document.body.innerText) || ""
            );
            const re = new RegExp(String(args?.regexSource ?? ""), "i");
            return re.test(bodyText);
          `,
          { regexSource: mfaHintRegex.source },
        );
        if (hasMfaPrompt) {
          return true;
        }
      } catch {
        // ignore and continue probing within timeout
      }
      if (Date.now() >= deadline) {
        return false;
      }
      try {
        await page.waitForTimeout(350);
      } catch {
        return false;
      }
    }
  };

  const mfaProbeTimeoutMs = isPasswordless ? Math.min(timeoutMs, 8000) : Math.min(timeoutMs, 3000);
  let detectedMfaChallenge = await detectMfaChallenge(mfaProbeTimeoutMs);
  if (isPasswordless && submitted && !detectedMfaChallenge) {
    // Passwordless submit click happened, but challenge never appeared; treat as unconfirmed.
    submitted = false;
    detectedMfaChallenge = await detectMfaChallenge(Math.min(timeoutMs, 1500));
  }
  const mfaExpected = params.authMode === "password_with_mfa" || params.authMode === "passwordless_mfa_code";
  const requiresMfa =
    detectedMfaChallenge || (params.authMode === "passwordless_mfa_code" && submitted);

  params.tab.updatedAt = Date.now();
  return {
    service: params.service,
    identifier: params.identifier,
    identifierMasked: maskCredentialIdentifier(params.identifier),
    identifierSelector: identifierTarget.selector,
    passwordSelector: passwordTarget?.selector ?? null,
    submitted,
    requiresMfa,
    mfaExpected,
    authMode: params.authMode,
  };
}

async function submitMfaCode(params: {
  tab: BrowserTab;
  code: string;
  timeoutMs: number;
}): Promise<{
  submitted: boolean;
  selector: string;
  multiField: boolean;
  submissionError?: string;
}> {
  const page = requireLivePage(params.tab);
  const timeoutMs = Math.max(1000, params.timeoutMs);
  const code = String(params.code ?? "").trim();
  if (!code) {
    throw new Error("MFA code is required.");
  }

  // Detect the page context where the OTP form lives: main page or an embedded auth iframe.
  let mfaPage: any = page;
  try {
    const allFrames = (page.frames?.() as any[]) ?? [];
    for (let fi = 0; fi < allFrames.length; fi++) {
      const frame = allFrames[fi];
      if (!frame || frame === page.mainFrame?.()) continue;
      const frameUrl = String(frame.url?.() ?? "");
      if (!frameUrl || frameUrl === "about:blank" || frameUrl.startsWith("data:")) continue;
      const hasOtp = await evalPageScript<boolean>(
        frame,
        `
          const inputs = document.querySelectorAll(
            'input[autocomplete="one-time-code"],input[name*="otp" i],input[id*="otp" i],' +
            'input[name*="code" i],input[id*="code" i],input[name*="mfa" i],input[maxlength="1"]'
          );
          return inputs.length > 0;
        `,
      ).catch(() => false);
      if (hasOtp) {
        mfaPage = frame;
        break;
      }
    }
  } catch {
    // Frame access failed — use main page.
  }

  const singleDigitSelectors = [
    'input[maxlength="1"][inputmode="numeric"]',
    'input[maxlength="1"][autocomplete="one-time-code"]',
    'input[maxlength="1"][name*="code" i]',
    'input[maxlength="1"][id*="code" i]',
  ];
  for (const selector of singleDigitSelectors) {
    const locator = mfaPage.locator(selector);
    const count = Number(await locator.count().catch(() => 0));
    if (!Number.isFinite(count) || count < 4) {
      continue;
    }
    const maxDigits = Math.min(count, code.length);
    let wrote = 0;
    for (let i = 0; i < maxDigits; i += 1) {
      const ch = code[i] ?? "";
      if (!ch) {
        continue;
      }
      try {
        const field = locator.nth(i);
        await field.fill(ch, { timeout: Math.min(timeoutMs, 2500) });
        wrote += 1;
      } catch {
        // ignore sparse/hidden field failures
      }
    }
    if (wrote > 0) {
      try {
        await locator.nth(Math.max(0, wrote - 1)).press("Enter", { timeout: Math.min(timeoutMs, 2500) });
      } catch {
        // no-op
      }
      // Wait for navigation/SPA state change after submission.
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeoutMs, 8000) });
      } catch {
        // SPA auth flows may not emit a full load event — continue.
      }
      let multiFieldError = "";
      try {
        multiFieldError = await evalPageScript<string>(
          mfaPage,
          `
            const selectors = ['[class*="error" i]','[role="alert"]','[aria-live="polite"]','[aria-live="assertive"]','[data-error]'];
            for (const sel of selectors) {
              for (const el of document.querySelectorAll(sel)) {
                const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
                if (text && text.length > 3) return text.slice(0, 400);
              }
            }
            return "";
          `,
        );
      } catch {
        multiFieldError = "";
      }
      return {
        submitted: true,
        selector,
        multiField: true,
        ...(multiFieldError ? { submissionError: multiFieldError } : {}),
      };
    }
  }

  const mfaInputSelectors = [
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[name*="mfa" i]',
    'input[id*="mfa" i]',
    'input[name*="verification" i]',
    'input[id*="verification" i]',
    'input[name*="code" i]',
    'input[id*="code" i]',
    'input[inputmode="numeric"]',
  ];
  const target = await selectFirstUsableLocator(mfaPage, mfaInputSelectors, timeoutMs);
  if (!target) {
    throw new Error(
      "Could not find an OTP/MFA code input on the current page — the session likely expired while waiting for the code. " +
        "Do NOT use the user's previous code. Re-do action=login to trigger a fresh code send, then ask the user for the new code.",
    );
  }

  await target.locator.fill(code, { timeout: timeoutMs });
  let submitted = false;
  const submitTarget = await selectFirstUsableLocator(
    mfaPage,
    [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Verify")',
      'button:has-text("Continue")',
      'button:has-text("Sign in")',
      'button:has-text("Confirm")',
      'button:has-text("Submit")',
      'button:has-text("Next")',
    ],
    Math.min(timeoutMs, 3000),
  );
  if (submitTarget) {
    try {
      await submitTarget.locator.click({ timeout: Math.min(timeoutMs, 3000) });
      submitted = true;
    } catch {
      submitted = false;
    }
  }
  if (!submitted) {
    try {
      await target.locator.press("Enter", { timeout: Math.min(timeoutMs, 3000) });
      submitted = true;
    } catch {
      submitted = false;
    }
  }

  // Wait for navigation/SPA state change after submission.
  if (submitted) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeoutMs, 8000) });
    } catch {
      // SPA auth flows may not emit a full load event — continue.
    }
  }

  // Probe for visible error messages so the caller can surface them.
  let submissionError = "";
  try {
    submissionError = await evalPageScript<string>(
      mfaPage,
      `
        const selectors = [
          '[class*="error" i]', '[class*="alert" i]', '[role="alert"]',
          '[aria-live="polite"]', '[aria-live="assertive"]',
          '[data-error]', '[class*="invalid" i]',
        ];
        for (const sel of selectors) {
          for (const el of document.querySelectorAll(sel)) {
            const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
            if (text && text.length > 3) return text.slice(0, 400);
          }
        }
        return "";
      `,
    );
  } catch {
    submissionError = "";
  }

  return {
    submitted,
    selector: target.selector,
    multiField: false,
    ...(submissionError ? { submissionError } : {}),
  };
}

export function createBrowserTool(_opts?: {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  allowLiveEngine?: boolean;
  externalLauncher?: (url: string, timeoutMs: number) => Promise<ExternalLaunchResult>;
}): AnyAgentTool {
  const sandboxBridgeUrl = String(_opts?.sandboxBridgeUrl ?? "").trim();
  const allowHostControl = _opts?.allowHostControl !== false;
  const allowLiveEngine = _opts?.allowLiveEngine !== false;
  const externalLauncher = _opts?.externalLauncher ?? launchExternalBrowser;
  const defaultTarget: "host" | "sandbox" = sandboxBridgeUrl ? "sandbox" : "host";
  const tool: AnyAgentTool = {
    name: "browser",
    description:
      "Stateful web browser tool with t560-compatible actions/aliases (status/diagnostics/start/stop/profiles/tabs/open/focus/close/snapshot/screenshot/navigate/console/downloads/pdf/upload/dialog/login/mfa/challenge/act/products/launch/wait_for_request). For secure auth, call open -> login -> mfa: login pulls identifier/secret from vault and injects secret without exposing it in outputs. Social/OAuth provider sign-ins are blocked. `open` manages internal tool tabs; `launch` opens the OS-visible default browser. Supports engine=live (Playwright) with resilient fetch fallback. Snapshot returns refs (e1,e2,...) for follow-up actions.",
    parameters: Type.Object({
      action: Type.String({
        description:
          "status|diagnostics|start|stop|profiles|tabs|open|navigate|focus|close|snapshot|search|forms|products|launch|login|mfa|challenge|click|type|fill|submit|hover|press|select|drag|evaluate|upload|dialog|console|downloads|pdf|scroll|resize|wait|wait_for_request|act|back|forward|reload|screenshot|reset",
      }),
      target: Type.Optional(Type.String({ description: "Compatibility target hint (host|sandbox|node)." })),
      node: Type.Optional(Type.String({ description: "Compatibility node id/name hint." })),
      profile: Type.Optional(Type.String({ description: "Compatibility profile hint." })),
      engine: Type.Optional(
        Type.String({
          description: "Browser engine: auto|fetch|live (auto prefers live when available).",
        }),
      ),
      tabId: Type.Optional(Type.String({ description: "Target tab id (for tab-specific actions)." })),
      targetId: Type.Optional(Type.String({ description: "t560 compatibility alias for tabId." })),
      url: Type.Optional(Type.String({ description: "HTTP/HTTPS URL." })),
      targetUrl: Type.Optional(Type.String({ description: "t560 compatibility alias for url." })),
      query: Type.Optional(Type.String({ description: "Search query (for action=search)." })),
      service: Type.Optional(
        Type.String({
          description:
            "Credential service key for action=login (typically normalized host, e.g. example.com). login reads identifier/secret from vault; do not pass passwords in browser tool args.",
        }),
      ),
      region: Type.Optional(Type.String({ description: "DuckDuckGo region code (for action=search)." })),
      count: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
      openFirstResult: Type.Optional(Type.Boolean({ description: "When true, open first search result in a tab." })),
      mode: Type.Optional(Type.String({ description: "Compatibility snapshot mode hint." })),
      snapshotFormat: Type.Optional(Type.String({ description: "Compatibility snapshot format hint (aria|ai)." })),
      refs: Type.Optional(Type.String({ description: "Compatibility refs hint (role|aria)." })),
      interactive: Type.Optional(Type.Boolean({ description: "Compatibility interaction hint." })),
      compact: Type.Optional(Type.Boolean({ description: "Compatibility compact snapshot hint." })),
      depth: Type.Optional(Type.Number({ minimum: 0, maximum: 8 })),
      ref: Type.Optional(Type.String({ description: "Snapshot reference id (e.g., e7) for click/fill/submit/hover/select/press actions." })),
      inputRef: Type.Optional(Type.String({ description: "t560 compatibility alias for ref (upload/click/fill)." })),
      selector: Type.Optional(
        Type.String({ description: "CSS selector for live actions (click/hover/press/select/drag/upload/scroll)." }),
      ),
      element: Type.Optional(Type.String({ description: "t560 compatibility alias for selector." })),
      frame: Type.Optional(Type.String({ description: "Compatibility frame selector hint." })),
      labels: Type.Optional(Type.Boolean({ description: "Compatibility label hint." })),
      fullPage: Type.Optional(Type.Boolean({ description: "Capture full-page screenshot when true." })),
      type: Type.Optional(Type.String({ description: "Image output type for screenshot (png|jpeg)." })),
      button: Type.Optional(Type.String({ description: "Mouse button for click: left|right|middle." })),
      doubleClick: Type.Optional(Type.Boolean({ description: "When true, perform a double-click." })),
      clickCount: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
      modifiers: Type.Optional(Type.Array(Type.String({ description: "Key modifiers for click: Alt|Control|Meta|Shift." }))),
      focusPopup: Type.Optional(Type.Boolean({ description: "When click opens a popup/new tab, focus it (default true)." })),
      popupWaitMs: Type.Optional(Type.Number({ minimum: 100, maximum: 10000 })),
      linkIndex: Type.Optional(Type.Number({ minimum: 1 })),
      linkText: Type.Optional(Type.String({ description: "Click first link containing this text." })),
      hrefContains: Type.Optional(Type.String({ description: "Click first link whose URL contains this value." })),
      formIndex: Type.Optional(Type.Number({ minimum: 1 })),
      fieldName: Type.Optional(Type.String({ description: "Form field name (for type/fill actions)." })),
      value: Type.Optional(Type.String({ description: "Field value (for type/fill actions)." })),
      code: Type.Optional(
        Type.String({
          description: "One-time MFA/OTP code for action=mfa. Use only after login indicates MFA is required.",
        }),
      ),
      values: Type.Optional(Type.Array(Type.String({ description: "Values for select action." }))),
      fields: Type.Optional(
        Type.Array(Type.Object({}, { additionalProperties: true }), {
          description: "Compatibility fill fields payload.",
        }),
      ),
      slowly: Type.Optional(Type.Boolean({ description: "When true (type), type characters with delay." })),
      submit: Type.Optional(Type.Boolean({ description: "When true (type), press Enter after typing." })),
      key: Type.Optional(Type.String({ description: "Keyboard key for press action, e.g. Enter." })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
      clear: Type.Optional(Type.Boolean({ description: "Clear buffered state after reading (console/dialog)." })),
      level: Type.Optional(Type.String({ description: "Console log level filter." })),
      accept: Type.Optional(Type.Boolean({ description: "For dialog action: true=accept, false=dismiss." })),
      once: Type.Optional(Type.Boolean({ description: "For dialog action: apply to next dialog only (default true)." })),
      promptText: Type.Optional(Type.String({ description: "Prompt text when accepting a prompt dialog." })),
      path: Type.Optional(Type.String({ description: "Single local file path for upload." })),
      paths: Type.Optional(Type.Array(Type.String({ description: "Local file paths for upload action." }))),
      startRef: Type.Optional(Type.String({ description: "Start element ref for drag action." })),
      endRef: Type.Optional(Type.String({ description: "End element ref for drag action." })),
      startSelector: Type.Optional(Type.String({ description: "Start CSS selector for drag action." })),
      endSelector: Type.Optional(Type.String({ description: "End CSS selector for drag action." })),
      expression: Type.Optional(Type.String({ description: "JavaScript expression/body for evaluate action." })),
      format: Type.Optional(Type.String({ description: "PDF page format (A4, Letter, etc.) for action=pdf." })),
      printBackground: Type.Optional(Type.Boolean({ description: "Include backgrounds for action=pdf (default true)." })),
      deltaX: Type.Optional(Type.Number({ description: "Scroll delta X for action=scroll." })),
      deltaY: Type.Optional(Type.Number({ description: "Scroll delta Y for action=scroll." })),
      toTop: Type.Optional(Type.Boolean({ description: "Scroll to top for action=scroll." })),
      toBottom: Type.Optional(Type.Boolean({ description: "Scroll to bottom for action=scroll." })),
      waitForSelector: Type.Optional(Type.String({ description: "For action=wait: CSS selector to wait for." })),
      waitForText: Type.Optional(Type.String({ description: "For action=wait: text to appear in page content." })),
      textGone: Type.Optional(Type.String({ description: "For action=wait: text that should disappear." })),
      urlContains: Type.Optional(Type.String({ description: "For action=wait: URL substring to wait for." })),
      waitForRequestUrl: Type.Optional(
        Type.String({
          description:
            "For action=wait_for_request: URL substring that the network request/response must include.",
        }),
      ),
      waitForRequestMethod: Type.Optional(
        Type.String({
          description: "For action=wait_for_request: HTTP method filter (GET|POST|PUT|PATCH|DELETE).",
        }),
      ),
      waitForStatus: Type.Optional(
        Type.Number({
          minimum: 100,
          maximum: 599,
          description: "For action=wait_for_request: optional HTTP response status filter.",
        }),
      ),
      waitForRequestBodyIncludes: Type.Optional(
        Type.String({
          description: "For action=wait_for_request: optional request body substring filter.",
        }),
      ),
      waitForResponseBodyIncludes: Type.Optional(
        Type.String({
          description: "For action=wait_for_request: optional response body substring filter.",
        }),
      ),
      state: Type.Optional(Type.String({ description: "For waitForSelector: attached|visible|hidden|detached." })),
      networkIdle: Type.Optional(
        Type.Boolean({
          description:
            "When true on snapshot-like actions, wait for network idle after DOM load (best effort for SPA/data-heavy pages).",
        }),
      ),
      networkIdleTimeoutMs: Type.Optional(
        Type.Number({
          minimum: 1000,
          maximum: 20000,
          description: "Timeout for networkIdle waits in milliseconds.",
        }),
      ),
      kind: Type.Optional(
        Type.String({
          description:
            "Sub-action for act: click|type|fill|submit|navigate|wait|wait_for_request|hover|press|select|drag|evaluate|upload|dialog|console|downloads|pdf|scroll|resize|login|mfa|challenge|close",
        }),
      ),
      timeMs: Type.Optional(Type.Number({ minimum: 0, maximum: 120000 })),
      snapshotAfter: Type.Optional(Type.Boolean({ description: "Capture a snapshot after navigation actions." })),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 120000 })),
      allowEngineFallback: Type.Optional(
        Type.Boolean({ description: "Allow automatic fallback from engine=live to fetch when live execution fails." }),
      ),
      maxRetries: Type.Optional(Type.Number({ minimum: 0, maximum: 4 })),
      maxBytes: Type.Optional(Type.Number({ minimum: 10000, maximum: 500000 })),
      maxChars: Type.Optional(Type.Number({ minimum: 500, maximum: 80000 })),
      maxLinks: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
      width: Type.Optional(Type.Number({ minimum: 320, maximum: 4096 })),
      height: Type.Optional(Type.Number({ minimum: 240, maximum: 4096 })),
      request: Type.Optional(Type.Object({}, { additionalProperties: true })),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = normalizeBrowserActionParams(rawParams);
      const actionRaw = String(params.action ?? "").trim().toLowerCase();
      const actionAliases: Record<string, string> = {
        "wait-for-request": "wait_for_request",
        waitforrequest: "wait_for_request",
        "wait-for-network": "wait_for_request",
        captcha: "challenge",
        "human-check": "challenge",
        human_check: "challenge",
        "human-verification": "challenge",
      };
      const action = actionAliases[actionRaw] ?? actionRaw;
      if (!action) {
        throw new Error("action is required.");
      }
      const targetRaw = String(params.target ?? "").trim().toLowerCase();
      const target = (targetRaw || defaultTarget) as "host" | "sandbox" | "node";
      if (targetRaw && targetRaw !== "host" && targetRaw !== "sandbox" && targetRaw !== "node") {
        throw new Error('target must be one of: host|sandbox|node');
      }
      if (target === "sandbox" && !sandboxBridgeUrl) {
        throw new Error(
          'Sandbox browser is unavailable. Enable agents.defaults.sandbox.browser.enabled or use target="host" if allowed.',
        );
      }
      if (target === "host" && !allowHostControl) {
        throw new Error("Host browser control is disabled by sandbox policy.");
      }
      if (target === "node" || String(params.node ?? "").trim().length > 0) {
        throw new Error(
          "target=node is not supported in this t560 browser build (browser proxy is unavailable).",
        );
      }
      const profile = String(params.profile ?? "").trim() || "default";
      const requestedEngine = normalizeEngineParam(params.engine);
      const liveAvailable = allowLiveEngine ? await hasLiveEngine() : false;
      const resolveEngine = (tab?: BrowserTab | null, actionParams?: Record<string, unknown>): BrowserEngineMode => {
        const fallbackAllowed = shouldAllowEngineFallback(actionParams ?? params);
        if (tab && getLivePage(tab.id)) {
          return "live";
        }
        if (requestedEngine === "fetch") {
          return "fetch";
        }
        if (requestedEngine === "live") {
          if (!liveAvailable) {
            if (!fallbackAllowed) {
              throw new Error("engine=live requested but unavailable, and allowEngineFallback=false.");
            }
            return "fetch";
          }
          return "live";
        }
        // Auto mode: prefer live when available, regardless of whether a tab already exists.
        return liveAvailable ? "live" : "fetch";
      };

      if (action === "status" || action === "diagnostics") {
        let statusEngine: string;
        try {
          statusEngine = resolveEngine(null, { ...params, allowEngineFallback: true }) === "live" ? "playwright" : "fetch-html";
        } catch {
          statusEngine = "fetch-html";
        }
        return {
          ok: true,
          engine: statusEngine,
          requestedEngine,
          liveAvailable,
          allowLiveEngine,
          liveRunning: Boolean(liveBrowser),
          liveTabCount: livePagesByTabId.size,
          sharedState: true,
          profile,
          target,
          targetDefault: defaultTarget,
          sandboxBridgeConfigured: Boolean(sandboxBridgeUrl),
          hostControlAllowed: allowHostControl,
          nodeProxyAvailable: false,
          capabilities: [
            "start",
            "stop",
            "profiles",
            "tabs",
            "snapshot",
            "refs",
            "search",
            "click",
            "forms",
            "products",
            "launch",
            "login",
            "mfa",
            "challenge",
            "fill",
            "submit",
            "hover",
            "press",
            "select",
            "drag",
            "evaluate",
            "upload",
            "dialog",
            "console",
            "downloads",
            "pdf",
            "scroll",
            "resize",
            "wait",
            "wait_for_request",
            "screenshot",
            "diagnostics",
          ],
          activeTabId: browserState.activeTabId,
          tabCount: browserState.tabs.length,
          createdAt: browserState.createdAt,
        };
      }

      if (action === "launch") {
        const url = normalizeHttpUrl(params.url ?? "https://www.google.com/");
        const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
        const launched = await externalLauncher(url, timeoutMs);
        return {
          ok: true,
          action: "launch",
          launched: true,
          url,
          command: launched.command,
          platform: process.platform,
          visibleToUser: true,
        };
      }

      if (action === "start") {
        let startedEngine: BrowserEngineMode = resolveEngine(null);
        let warning: string | null = null;
        if (startedEngine === "live" && liveAvailable) {
          try {
            await ensureLiveRuntime();
            startedEngine = "live";
          } catch (error) {
            startedEngine = "fetch";
            warning = error instanceof Error ? error.message : String(error);
          }
        } else {
          startedEngine = "fetch";
        }
        return {
          ok: true,
          started: true,
          profile,
          target,
          liveAvailable,
          liveRunning: Boolean(liveBrowser),
          engine: startedEngine,
          warning,
          activeTabId: browserState.activeTabId,
          tabCount: browserState.tabs.length,
        };
      }

      if (action === "stop") {
        await resetLiveRuntime();
        return {
          ok: true,
          stopped: true,
          profile,
          target,
          liveAvailable,
          liveRunning: false,
          activeTabId: browserState.activeTabId,
          tabCount: browserState.tabs.length,
        };
      }

      if (action === "profiles") {
        return {
          ok: true,
          profile,
          profiles: [
            {
              id: "default",
              label: "Default",
              engine: liveAvailable ? "auto(fetch|live)" : "fetch",
            },
          ],
        };
      }

      if (action === "tabs") {
        return {
          ok: true,
          activeTabId: browserState.activeTabId,
          tabs: browserState.tabs.map((tab) => serializeTab(tab)),
        };
      }

      if (action === "reset") {
        await resetLiveRuntime();
        browserState.tabs = [];
        browserState.activeTabId = null;
        browserState.nextTabIndex = 1;
        return { ok: true, reset: true };
      }

      if (action === "open") {
        const url = normalizeHttpUrl(params.url ?? "https://duckduckgo.com/");
        const tab = createTab(url);
        const snapshotAfter = params.snapshotAfter !== false;
        const engine = resolveEngine(tab, params);
        let usedEngine: BrowserEngineMode = engine;
        let fallbackFrom: BrowserEngineMode | undefined =
          requestedEngine === "live" && engine === "fetch" ? "live" : undefined;
        let fallbackReason: string | undefined =
          requestedEngine === "live" && engine === "fetch" && !liveAvailable
            ? "live engine unavailable; using fetch fallback."
            : undefined;
        let retryCount = 1;
        let snapshot: BrowserSnapshot | null = null;
        if (engine === "live") {
          try {
            const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
            const { context } = await ensureLiveRuntime();
            const page = await context.newPage();
            attachLivePage(tab.id, page);
            const response = await page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: timeoutMs,
            });
            setLiveMeta(tab.id, response);
            if (snapshotAfter) {
              snapshot = await captureLiveTabSnapshot(tab, params);
            } else {
              tab.url = normalizeHttpUrl(page.url() || url);
              tab.history[tab.historyIndex] = tab.url;
              tab.title = String(await page.title()) || summarizeTitleFromUrl(tab.url);
              tab.updatedAt = Date.now();
            }
          } catch (error) {
            if (!shouldAllowEngineFallback(params)) {
              throw error;
            }
            await closeLiveTab(tab.id);
            usedEngine = "fetch";
            fallbackFrom = "live";
            fallbackReason = formatToolError(error);
            const recovered = await captureTabSnapshotWithRetries(tab, params);
            retryCount = recovered.attempts;
            snapshot = snapshotAfter ? recovered.snapshot : null;
          }
        } else {
          if (snapshotAfter) {
            const captured = await captureTabSnapshotWithRetries(tab, params);
            retryCount = captured.attempts;
            snapshot = captured.snapshot;
          }
        }
        return {
          ok: true,
          engine: usedEngine,
          requestedEngine,
          fallbackFrom,
          fallbackReason,
          retryCount,
          activeTabId: browserState.activeTabId,
          tab: serializeTab(tab),
          snapshot,
        };
      }

      if (action === "focus") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        return { ok: true, activeTabId: tab.id, tab: serializeTab(tab) };
      }

      if (action === "close") {
        const tab = resolveTab(params.tabId);
        await closeLiveTab(tab.id);
        closeTab(tab);
        return {
          ok: true,
          closedTabId: tab.id,
          activeTabId: browserState.activeTabId,
          tabs: browserState.tabs.map((entry) => serializeTab(entry)),
        };
      }

      if (action === "search") {
        const query = String(params.query ?? "").trim();
        if (!query) {
          throw new Error("query is required for search.");
        }
        const count = clampInt(params.count, 1, 20, DEFAULT_SEARCH_COUNT);
        const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
        const region = String(params.region ?? "wt-wt").trim() || "wt-wt";
        const results = await duckDuckGoSearch({
          query,
          count,
          timeoutMs,
          region,
        });
        const openFirst = params.openFirstResult === true;
        let openedTab: Record<string, unknown> | null = null;
        let snapshot: BrowserSnapshot | null = null;
        let openedEngine: BrowserEngineMode | null = null;
        let openedFallbackFrom: BrowserEngineMode | undefined;
        let openedFallbackReason: string | undefined;
        let openedRetryCount = 1;
        if (openFirst && results.length > 0) {
          const tab = createTab(results[0].url);
          const engine = resolveEngine(tab, params);
          openedEngine = engine;
          openedFallbackFrom = requestedEngine === "live" && engine === "fetch" ? "live" : undefined;
          openedFallbackReason =
            requestedEngine === "live" && engine === "fetch" && !liveAvailable
              ? "live engine unavailable; using fetch fallback."
              : undefined;
          if (engine === "live") {
            try {
              const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
              const { context } = await ensureLiveRuntime();
              const page = await context.newPage();
              attachLivePage(tab.id, page);
              const response = await page.goto(results[0].url, {
                waitUntil: "domcontentloaded",
                timeout: timeoutMs,
              });
              setLiveMeta(tab.id, response);
              snapshot = await captureLiveTabSnapshot(tab, params);
            } catch (error) {
              if (!shouldAllowEngineFallback(params)) {
                throw error;
              }
              await closeLiveTab(tab.id);
              openedEngine = "fetch";
              openedFallbackFrom = "live";
              openedFallbackReason = formatToolError(error);
              const captured = await captureTabSnapshotWithRetries(tab, params);
              openedRetryCount = captured.attempts;
              snapshot = captured.snapshot;
            }
          } else {
            const captured = await captureTabSnapshotWithRetries(tab, params);
            openedRetryCount = captured.attempts;
            snapshot = captured.snapshot;
          }
          openedTab = serializeTab(tab);
        }
        return {
          ok: true,
          query,
          region,
          count: results.length,
          results,
          openedTab,
          openedEngine,
          openedFallbackFrom,
          openedFallbackReason,
          openedRetryCount,
          snapshot,
        };
      }

      if (action === "navigate") {
        const tab = resolveTab(params.tabId);
        const url = normalizeHttpUrl(params.url);
        navigateTab(tab, url);
        setActiveTab(tab);
        const snapshotAfter = params.snapshotAfter !== false;
        const engine = resolveEngine(tab, params);
        let usedEngine: BrowserEngineMode = engine;
        let fallbackFrom: BrowserEngineMode | undefined =
          requestedEngine === "live" && engine === "fetch" ? "live" : undefined;
        let fallbackReason: string | undefined =
          requestedEngine === "live" && engine === "fetch" && !liveAvailable
            ? "live engine unavailable; using fetch fallback."
            : undefined;
        let retryCount = 1;
        let snapshot: BrowserSnapshot | null = null;
        if (engine === "live") {
          try {
            const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
            const page = getLivePage(tab.id);
            if (!page) {
              const { context } = await ensureLiveRuntime();
              const created = await context.newPage();
              attachLivePage(tab.id, created);
            }
            const targetPage = getLivePage(tab.id);
            if (!targetPage) {
              throw new Error(`live browser page missing for tab ${tab.id}.`);
            }
            const response = await targetPage.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: timeoutMs,
            });
            setLiveMeta(tab.id, response);
            if (snapshotAfter) {
              snapshot = await captureLiveTabSnapshot(tab, params);
            } else {
              tab.url = normalizeHttpUrl(targetPage.url() || url);
              tab.history[tab.historyIndex] = tab.url;
              tab.title = String(await targetPage.title()) || summarizeTitleFromUrl(tab.url);
              tab.updatedAt = Date.now();
            }
          } catch (error) {
            if (!shouldAllowEngineFallback(params)) {
              throw error;
            }
            await closeLiveTab(tab.id);
            usedEngine = "fetch";
            fallbackFrom = "live";
            fallbackReason = formatToolError(error);
            if (snapshotAfter) {
              const captured = await captureTabSnapshotWithRetries(tab, params);
              retryCount = captured.attempts;
              snapshot = captured.snapshot;
            }
          }
        } else {
          if (snapshotAfter) {
            const captured = await captureTabSnapshotWithRetries(tab, params);
            retryCount = captured.attempts;
            snapshot = captured.snapshot;
          }
        }
        return {
          ok: true,
          engine: usedEngine,
          requestedEngine,
          fallbackFrom,
          fallbackReason,
          retryCount,
          activeTabId: tab.id,
          tab: serializeTab(tab),
          snapshot,
        };
      }

      if (action === "reload") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const snapshotAfter = params.snapshotAfter !== false;
        const engine = resolveEngine(tab, params);
        let usedEngine: BrowserEngineMode = engine;
        let fallbackFrom: BrowserEngineMode | undefined =
          requestedEngine === "live" && engine === "fetch" ? "live" : undefined;
        let fallbackReason: string | undefined =
          requestedEngine === "live" && engine === "fetch" && !liveAvailable
            ? "live engine unavailable; using fetch fallback."
            : undefined;
        let retryCount = 1;
        let snapshot: BrowserSnapshot | null = null;
        if (engine === "live") {
          try {
            const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
            const page = getLivePage(tab.id);
            if (!page) {
              throw new Error(`tab ${tab.id} is not backed by a live browser page.`);
            }
            const response = await page.reload({
              waitUntil: "domcontentloaded",
              timeout: timeoutMs,
            });
            setLiveMeta(tab.id, response);
            if (snapshotAfter) {
              snapshot = await captureLiveTabSnapshot(tab, params);
            } else {
              tab.url = normalizeHttpUrl(page.url() || tab.url);
              tab.history[tab.historyIndex] = tab.url;
              tab.title = String(await page.title()) || summarizeTitleFromUrl(tab.url);
              tab.updatedAt = Date.now();
            }
          } catch (error) {
            if (!shouldAllowEngineFallback(params)) {
              throw error;
            }
            await closeLiveTab(tab.id);
            usedEngine = "fetch";
            fallbackFrom = "live";
            fallbackReason = formatToolError(error);
            if (snapshotAfter) {
              const captured = await captureTabSnapshotWithRetries(tab, params);
              retryCount = captured.attempts;
              snapshot = captured.snapshot;
            }
          }
        } else {
          if (snapshotAfter) {
            const captured = await captureTabSnapshotWithRetries(tab, params);
            retryCount = captured.attempts;
            snapshot = captured.snapshot;
          }
        }
        return {
          ok: true,
          engine: usedEngine,
          requestedEngine,
          fallbackFrom,
          fallbackReason,
          retryCount,
          activeTabId: tab.id,
          tab: serializeTab(tab),
          snapshot,
        };
      }

      if (action === "snapshot") {
        const explicitUrl = String(params.url ?? "").trim();
        const tab = explicitUrl && String(params.tabId ?? "").trim().length === 0 ? createTab(normalizeHttpUrl(explicitUrl)) : resolveTab(params.tabId);
        setActiveTab(tab);
        const engine = resolveEngine(tab, params);
        let usedEngine: BrowserEngineMode = engine;
        let fallbackFrom: BrowserEngineMode | undefined =
          requestedEngine === "live" && engine === "fetch" ? "live" : undefined;
        let fallbackReason: string | undefined =
          requestedEngine === "live" && engine === "fetch" && !liveAvailable
            ? "live engine unavailable; using fetch fallback."
            : undefined;
        let retryCount = 1;
        let snapshot: BrowserSnapshot;
        if (engine === "live") {
          try {
            snapshot = await captureLiveTabSnapshot(tab, params);
          } catch (error) {
            if (!shouldAllowEngineFallback(params)) {
              throw error;
            }
            await closeLiveTab(tab.id);
            usedEngine = "fetch";
            fallbackFrom = "live";
            fallbackReason = formatToolError(error);
            const captured = await captureTabSnapshotWithRetries(tab, params);
            retryCount = captured.attempts;
            snapshot = captured.snapshot;
          }
        } else {
          const captured = await captureTabSnapshotWithRetries(tab, params);
          retryCount = captured.attempts;
          snapshot = captured.snapshot;
        }
        return {
          ok: true,
          engine: usedEngine,
          requestedEngine,
          fallbackFrom,
          fallbackReason,
          retryCount,
          activeTabId: tab.id,
          tab: serializeTab(tab),
          snapshot,
          forms: tab.forms,
          refs: snapshot.refs,
        };
      }

      if (action === "forms") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        if (!tab.lastSnapshot) {
          const engine = resolveEngine(tab);
          if (engine === "live") {
            await captureLiveTabSnapshot(tab, params);
          } else {
            await captureTabSnapshot(tab, params);
          }
        }
        return {
          ok: true,
          activeTabId: tab.id,
          tab: serializeTab(tab),
          forms: tab.forms,
          formValues: tab.formValues,
          refs: tab.lastSnapshot?.refs ?? [],
        };
      }

      if (action === "products") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const engine = resolveEngine(tab, params);
        if (!tab.lastSnapshot) {
          if (engine === "live") {
            try {
              await captureLiveTabSnapshot(tab, params);
            } catch (error) {
              if (!shouldAllowEngineFallback(params)) {
                throw error;
              }
              await closeLiveTab(tab.id);
              const captured = await captureTabSnapshotWithRetries(tab, params);
              tab.lastSnapshot = captured.snapshot;
            }
          } else {
            const captured = await captureTabSnapshotWithRetries(tab, params);
            tab.lastSnapshot = captured.snapshot;
          }
        }
        const query = String(params.query ?? "").trim() || tab.title || tab.url;
        const limit = clampInt(params.limit, 1, 50, 12);
        const candidates = extractEcommerceCandidates({
          query,
          outcomes: [
            {
              toolName: "browser",
              content: JSON.stringify({
                snapshot: tab.lastSnapshot,
                html: tab.lastHtml,
              }),
            },
          ],
          limit,
        });
        const cheapest = pickCheapestCandidate(candidates);
        return {
          ok: true,
          engine: getLivePage(tab.id) ? "live" : "fetch",
          activeTabId: tab.id,
          query,
          count: candidates.length,
          products: candidates,
          cheapest:
            cheapest && cheapest.price
              ? {
                  title: cheapest.title,
                  url: cheapest.url,
                  price: cheapest.price,
                  sourceTool: cheapest.sourceTool,
                }
              : null,
          tab: serializeTab(tab),
          snapshot: tab.lastSnapshot,
        };
      }

      if (action === "login") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);

        let page = getLivePage(tab.id);
        if (!page) {
          const { context } = await ensureLiveRuntime();
          const created = await context.newPage();
          attachLivePage(tab.id, created);
          const response = await created.goto(tab.url, {
            waitUntil: "domcontentloaded",
            timeout: timeoutMs,
          });
          setLiveMeta(tab.id, response);
          page = created;
        }

        const liveUrl = normalizeHttpUrlOrFallback(String(page.url?.() ?? tab.url), tab.url);
        if (liveUrl !== tab.url) {
          appendHistoryEntry(tab, liveUrl);
        }
        tab.url = liveUrl;
        tab.updatedAt = Date.now();

        const serviceCandidates = deriveServiceCandidates({
          explicitServiceRaw: params.service,
          currentUrl: liveUrl,
        });
        if (serviceCandidates.length === 0) {
          throw new Error(
            "Could not infer setup service for this page. Pass service=<site> (example: service=example.com).",
          );
        }

        const resolved = await resolveCredentialForCandidates({
          workspaceDir: process.cwd(),
          serviceCandidates,
          currentUrl: liveUrl,
        });
        if (!resolved) {
          throw new Error(
            `No credential is configured for services=[${serviceCandidates.join(", ")}]. Add account credentials in Setup -> Vault (or run /setup <service-or-site>).`,
          );
        }
        const resolvedService = resolved.service;
        const credential = resolved.credential;

        const loginResult = await performLiveCredentialLogin({
          tab,
          service: resolvedService,
          identifier: credential.identifier,
          secret: credential.secret,
          authMode: credential.authMode,
          timeoutMs,
        });
        const mfaSourceService = String(credential.mfaSourceService ?? "").trim();
        const mfaStrategy =
          String(credential.mfaStrategy ?? "").trim().toLowerCase() === "email_or_user"
            ? "email_or_user"
            : "user_prompt";
        const mfaSourceCredentialAvailable = mfaSourceService
          ? Boolean(
              await getCredential({
                workspaceDir: process.cwd(),
                service: mfaSourceService,
              }),
            )
          : false;
        const nextStep = loginResult.requiresMfa
          ? mfaStrategy === "email_or_user" && mfaSourceService && mfaSourceCredentialAvailable
            ? `MFA challenge detected. First try fetching the code from ${mfaSourceService}; if unavailable, ask the user and call browser action=mfa with that code.`
            : mfaStrategy === "email_or_user" && mfaSourceService
              ? `MFA challenge detected. ${mfaSourceService} is configured as source but credentials for it are missing; ask the user for the one-time code and call browser action=mfa.`
            : "MFA challenge detected. Ask user for one-time code, then call browser action=mfa with that code."
          : loginResult.mfaExpected
            ? mfaStrategy === "email_or_user" && mfaSourceService && mfaSourceCredentialAvailable
              ? `Account is configured with MFA (${mfaSourceService} preferred source). Continue flow and, if prompted, retrieve code from that source or ask the user.`
              : mfaStrategy === "email_or_user" && mfaSourceService
                ? `Account is configured with MFA. ${mfaSourceService} is configured as preferred source but credentials are missing, so ask the user for codes when prompted.`
              : "Account is configured with MFA. Continue flow and, if prompted, ask the user for the one-time code."
            : "Continue with the next authenticated step.";

        const snapshotAfter = params.snapshotAfter !== false;
        const snapshot = snapshotAfter ? await captureLiveTabSnapshot(tab, params) : null;
        return {
          ok: true,
          engine: "live",
          activeTabId: tab.id,
          service: loginResult.service,
          identifier: loginResult.identifier,
          identifierMasked: loginResult.identifierMasked,
          secretInjectedFromVault: true,
          secretVisibleToAgent: false,
          credentialService: resolvedService,
          submitted: loginResult.submitted,
          requiresMfa: loginResult.requiresMfa,
          mfaExpected: loginResult.mfaExpected,
          authMode: loginResult.authMode,
          mfaStrategy,
          mfaSourceCredentialAvailable,
          ...(mfaSourceService ? { mfaSourceService } : {}),
          nextStep,
          mfa: {
            required: loginResult.requiresMfa,
            expected: loginResult.mfaExpected,
            strategy: mfaStrategy,
            sourceCredentialAvailable: mfaSourceCredentialAvailable,
            ...(mfaSourceService ? { sourceService: mfaSourceService } : {}),
          },
          selectors: {
            identifier: loginResult.identifierSelector,
            password: loginResult.passwordSelector,
          },
          tab: serializeTab(tab),
          snapshot,
        };
      }

      if (action === "mfa") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);

        let page = getLivePage(tab.id);
        if (!page) {
          // Use the most recently visited URL (lastSnapshot) so we land on the OTP page,
          // not the original login URL.
          const gotoUrl = tab.lastSnapshot?.url ?? tab.url;
          const { context } = await ensureLiveRuntime();
          const created = await context.newPage();
          attachLivePage(tab.id, created);
          const response = await created.goto(gotoUrl, {
            waitUntil: "domcontentloaded",
            timeout: timeoutMs,
          });
          setLiveMeta(tab.id, response);
          page = created;
        }

        const liveUrl = normalizeHttpUrlOrFallback(String(page.url?.() ?? tab.url), tab.url);
        if (liveUrl !== tab.url) {
          appendHistoryEntry(tab, liveUrl);
        }
        tab.url = liveUrl;
        tab.updatedAt = Date.now();

        const serviceCandidates = deriveServiceCandidates({
          explicitServiceRaw: params.service,
          currentUrl: liveUrl,
        });
        const providedCode = String(params.code ?? params.value ?? "").trim();
        let code = providedCode;
        if (!code && serviceCandidates.length > 0) {
          const resolved = await resolveCredentialForCandidates({
            workspaceDir: process.cwd(),
            serviceCandidates,
            currentUrl: liveUrl,
          });
          const fallbackCode = String(resolved?.credential?.mfaCode ?? "").trim();
          if (fallbackCode) {
            code = fallbackCode;
          }
        }
        if (!code) {
          throw new Error(
            "No MFA code provided. Ask user for the one-time code and call browser action=mfa with code=<value>.",
          );
        }

        const mfaResult = await submitMfaCode({
          tab,
          code,
          timeoutMs,
        });
        const snapshotAfter = params.snapshotAfter !== false;
        const snapshot = snapshotAfter ? await captureLiveTabSnapshot(tab, params) : null;
        return {
          ok: true,
          engine: "live",
          activeTabId: tab.id,
          mfaSubmitted: mfaResult.submitted,
          selector: mfaResult.selector,
          multiField: mfaResult.multiField,
          codeMasked: `***${code.slice(-2)}`,
          ...(mfaResult.submissionError ? { submissionError: mfaResult.submissionError } : {}),
          tab: serializeTab(tab),
          snapshot,
        };
      }

      if (action === "challenge") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const engine = resolveEngine(tab, params);
        const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
        let challenge: {
          detected: boolean;
          provider: string | null;
          confidence: "none" | "low" | "medium" | "high";
          signals: string[];
          url: string;
        } = {
          detected: false,
          provider: null,
          confidence: "none",
          signals: [],
          url: "",
        };

        if (engine === "live") {
          let page = getLivePage(tab.id);
          if (!page) {
            const { context } = await ensureLiveRuntime();
            const created = await context.newPage();
            attachLivePage(tab.id, created);
            const response = await created.goto(tab.url, {
              waitUntil: "domcontentloaded",
              timeout: timeoutMs,
            });
            setLiveMeta(tab.id, response);
            page = created;
          }
          const liveUrl = normalizeHttpUrlOrFallback(String(page.url?.() ?? tab.url), tab.url);
          if (liveUrl !== tab.url) {
            appendHistoryEntry(tab, liveUrl);
          }
          tab.url = liveUrl;
          tab.updatedAt = Date.now();
          challenge = await detectInteractiveChallengeLive(page);
        } else {
          if (!tab.lastSnapshot) {
            const captured = await captureTabSnapshotWithRetries(tab, params);
            tab.lastSnapshot = captured.snapshot;
          }
          challenge = detectInteractiveChallengeFromFetchSnapshot(tab);
        }

        const snapshotAfter = params.snapshotAfter === true;
        const snapshot = snapshotAfter
          ? engine === "live"
            ? await captureLiveTabSnapshot(tab, params)
            : await captureTabSnapshot(tab, params)
          : null;
        return {
          ok: true,
          engine,
          activeTabId: tab.id,
          humanVerificationRequired: challenge.detected,
          challenge,
          tab: serializeTab(tab),
          snapshot,
        };
      }

      if (action === "type" || action === "fill") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const engine = resolveEngine(tab);

        const explicitSelector = getExplicitSelector(params, "selector");
        if (explicitSelector) {
          if (engine !== "live") {
            throw new Error("selector-based fill/type requires engine=live.");
          }
          const page = requireLivePage(tab);
          const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
          const value = String(params.value ?? "");
          const slowly = params.slowly === true;
          const submit = params.submit === true;
          // Resolve frame context for selectors prefixed with "frame:N:" (from snapshot iframe refs).
          const { context: fillCtx, selector: fillSel } = resolveFrameSelector(page, explicitSelector);

          // Detect input type so checkboxes and radio buttons are handled correctly.
          // Playwright's .fill() does not toggle checked state — we need .setChecked()/.click().
          const inputType = await fillCtx
            .locator(fillSel)
            .first()
            .evaluate((el: any) => {
              const tag = String(el?.tagName ?? "").toLowerCase();
              return tag === "input" ? String(el.type ?? "text").toLowerCase() : tag;
            })
            .catch(() => "text");

          if (inputType === "checkbox") {
            const checked = !["false", "0", "no", "off", "unchecked", ""].includes(value.toLowerCase());
            await fillCtx.locator(fillSel).first().setChecked(checked, { timeout: timeoutMs });
          } else if (inputType === "radio") {
            // Radio buttons are selected by clicking; only click if value is truthy.
            if (!["false", "0", "no", "off"].includes(value.toLowerCase())) {
              await fillCtx.locator(fillSel).first().click({ timeout: timeoutMs });
            }
          } else if (inputType === "date") {
            await fillLiveLocatorWithDateFallback({
              locator: fillCtx.locator(fillSel).first(),
              value,
              timeoutMs,
              typeMode: action === "type" ? "type" : "fill",
              slowly,
              submit,
            });
          } else if (action === "type") {
            await fillCtx.locator(fillSel).first().fill("", { timeout: timeoutMs });
            await fillCtx
              .locator(fillSel)
              .first()
              .type(value, { timeout: timeoutMs, ...(slowly ? { delay: 35 } : {}) });
            if (submit) {
              const submitted = await submitNearestFormFromInput(fillCtx.locator(fillSel).first(), timeoutMs);
              if (!submitted) {
                throw new Error(
                  "Unable to submit typed form without triggering social/OAuth controls. Use browser action=submit or browser action=login.",
                );
              }
            }
          } else {
            await fillCtx.locator(fillSel).first().fill(value, { timeout: timeoutMs });
          }
          tab.updatedAt = Date.now();
          const snapshotAfter = params.snapshotAfter === true;
          const snapshot = snapshotAfter ? await captureLiveTabSnapshot(tab, params) : null;
          return {
            ok: true,
            engine,
            activeTabId: tab.id,
            action,
            selector: explicitSelector,
            value,
            slowly: action === "type" ? slowly : undefined,
            submit: action === "type" ? submit : undefined,
            tab: serializeTab(tab),
            snapshot,
          };
        }

        if (!tab.lastSnapshot) {
          if (engine === "live") {
            await captureLiveTabSnapshot(tab, params);
          } else {
            await captureTabSnapshot(tab, params);
          }
        }
        const form = resolveForm(tab, params.formIndex, params.ref);
        const field = resolveFormField(tab, form, params.fieldName, params.ref);
        const value = String(params.value ?? "");
        if (!tab.formValues[form.index]) {
          tab.formValues[form.index] = {};
        }
        tab.formValues[form.index][field.name] = value;
        if (engine === "live") {
          await liveFillFormField(tab, form, field, value);
          if (action === "type" && params.submit === true) {
            await liveSubmitForm(tab, form, clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS));
          }
        }
        tab.updatedAt = Date.now();
        return {
          ok: true,
          engine,
          activeTabId: tab.id,
          action,
          formIndex: form.index,
          fieldName: field.name,
          value,
          formValues: tab.formValues[form.index],
        };
      }

      if (action === "submit") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        if (!tab.lastSnapshot) {
          const seedEngine = resolveEngine(tab);
          if (seedEngine === "live") {
            await captureLiveTabSnapshot(tab, params);
          } else {
            await captureTabSnapshot(tab, params);
          }
        }
        const form = resolveForm(tab, params.formIndex, params.ref);
        assertNotSocialAuthTarget({
          label: "",
          href: form.action,
          action: "submit",
        });
        const payload = collectFormPayload(tab, form);
        const payloadText = payload.toString();
        const engine = resolveEngine(tab);

        if (engine === "live") {
          const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
          const beforeUrl = tab.url;
          await liveSubmitForm(tab, form, timeoutMs);
          const snapshot = await captureLiveTabSnapshot(tab, params);
          if (snapshot.url !== beforeUrl) {
            appendHistoryEntry(tab, snapshot.url);
          }
          return {
            ok: true,
            engine,
            activeTabId: tab.id,
            method: form.method,
            actionUrl: form.action,
            submittedBytes: payloadText.length,
            formIndex: form.index,
            tab: serializeTab(tab),
            snapshot,
          };
        }

        if (form.method === "get") {
          const target = new URL(form.action);
          for (const [key, value] of payload.entries()) {
            target.searchParams.append(key, value);
          }
          navigateTab(tab, target.toString());
          const snapshot = await captureTabSnapshot(tab, params);
          return {
            ok: true,
            engine,
            activeTabId: tab.id,
            method: form.method,
            actionUrl: form.action,
            submittedUrl: target.toString(),
            formIndex: form.index,
            tab: serializeTab(tab),
            snapshot,
          };
        }

        navigateTab(tab, form.action);
        const snapshot = await captureTabSnapshot(tab, params, {
          method: "POST",
          url: form.action,
          body: payloadText,
        });
        return {
          ok: true,
          engine,
          activeTabId: tab.id,
          method: form.method,
          actionUrl: form.action,
          submittedBytes: payloadText.length,
          formIndex: form.index,
          tab: serializeTab(tab),
          snapshot,
        };
      }

      if (action === "screenshot") {
        const tab = params.tabId !== undefined || params.url === undefined ? resolveTab(params.tabId) : null;
        if (tab) {
          setActiveTab(tab);
        }
        const engine = resolveEngine(tab);
        const requestedType = String(params.type ?? "").trim().toLowerCase();
        const requestedJpeg = requestedType === "jpeg" || requestedType === "jpg";
        let shot;
        if (tab && engine === "live") {
          shot = await captureLiveScreenshot(tab, params);
        } else {
          const url = tab ? tab.url : normalizeHttpUrl(params.url);
          const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
          const width = clampInt(params.width, 320, 4096, DEFAULT_SCREENSHOT_WIDTH);
          const height = clampInt(params.height, 240, 4096, DEFAULT_SCREENSHOT_HEIGHT);
          shot = await captureFirefoxScreenshot({
            url,
            timeoutMs,
            width,
            height,
          });
        }
        const outputType: "png" | "jpeg" = shot.type === "jpeg" ? "jpeg" : "png";
        return {
          ok: true,
          engine: tab ? engine : "fetch",
          activeTabId: tab?.id ?? browserState.activeTabId,
          screenshot: {
            ...shot,
            mimeType: outputType === "jpeg" ? "image/jpeg" : "image/png",
            requestedType: requestedType || undefined,
            warning: !tab && requestedJpeg ? "jpeg output requires engine=live; returned png screenshot." : undefined,
          },
        };
      }

      if (action === "wait") {
        const delayMs = clampInt(params.timeMs, 0, 120000, DEFAULT_WAIT_MS);
        const tab = params.tabId !== undefined ? resolveTab(params.tabId) : getActiveTab();
        const engine = resolveEngine(tab);
        if (tab) {
          setActiveTab(tab);
        }
        const waitForSelector = String(params.waitForSelector ?? "").trim();
        const waitForText = String(params.waitForText ?? "").trim();
        const textGone = String(params.textGone ?? "").trim();
        const urlContains = String(params.urlContains ?? "").trim();
        if (engine === "live" && tab) {
          const page = requireLivePage(tab);
          const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
          if (waitForSelector) {
            const rawState = String(params.state ?? "visible").trim().toLowerCase();
            const state =
              rawState === "attached" || rawState === "hidden" || rawState === "detached" ? rawState : "visible";
            await page.locator(waitForSelector).first().waitFor({ state: state as any, timeout: timeoutMs });
          } else if (waitForText) {
            const wanted = waitForText.toLowerCase();
            await page.waitForFunction(
              `(() => {
                const bodyText = String(document.body?.innerText ?? "").toLowerCase();
                return bodyText.includes(${JSON.stringify(wanted)});
              })()`,
              { timeout: timeoutMs },
            );
          } else if (textGone) {
            const wanted = textGone.toLowerCase();
            await page.waitForFunction(
              `(() => {
                const bodyText = String(document.body?.innerText ?? "").toLowerCase();
                return !bodyText.includes(${JSON.stringify(wanted)});
              })()`,
              { timeout: timeoutMs },
            );
          } else if (urlContains) {
            await page.waitForURL((url: URL) => url.toString().includes(urlContains), { timeout: timeoutMs });
          } else {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        } else {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        if (!tab) {
          return { ok: true, waitedMs: delayMs, engine };
        }
        const snapshotAfter = params.snapshotAfter === true;
        const snapshot = snapshotAfter
          ? engine === "live"
            ? await captureLiveTabSnapshot(tab, params)
            : await captureTabSnapshot(tab, params)
          : null;
        return {
          ok: true,
          engine,
          activeTabId: tab.id,
          waitedMs: delayMs,
          textGone: textGone || undefined,
          tab: serializeTab(tab),
          snapshot,
        };
      }

      if (action === "wait_for_request" || action === "wait-for-request") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const engine = resolveEngine(tab);
        if (engine !== "live") {
          throw new Error("wait_for_request requires engine=live.");
        }
        const page = requireLivePage(tab);
        const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
        const urlFilter = String(params.waitForRequestUrl ?? params.urlContains ?? "").trim();
        const methodFilter = String(params.waitForRequestMethod ?? "")
          .trim()
          .toUpperCase();
        const statusRaw = Number(params.waitForStatus);
        const statusFilter = Number.isFinite(statusRaw) ? clampInt(statusRaw, 100, 599, 0) : 0;
        const requestBodyFilter = String(params.waitForRequestBodyIncludes ?? "")
          .trim()
          .toLowerCase();
        const responseBodyFilter = String(params.waitForResponseBodyIncludes ?? "")
          .trim()
          .toLowerCase();
        if (!urlFilter && !methodFilter && !statusFilter && !requestBodyFilter && !responseBodyFilter) {
          throw new Error(
            "wait_for_request requires at least one filter (waitForRequestUrl, waitForRequestMethod, waitForStatus, waitForRequestBodyIncludes, waitForResponseBodyIncludes).",
          );
        }

        const matchesRequest = (request: any): boolean => {
          const reqUrl = String(request?.url?.() ?? "");
          if (urlFilter && !reqUrl.includes(urlFilter)) {
            return false;
          }
          if (methodFilter) {
            const method = String(request?.method?.() ?? "")
              .trim()
              .toUpperCase();
            if (method !== methodFilter) {
              return false;
            }
          }
          if (requestBodyFilter) {
            const postData = String(request?.postData?.() ?? "").toLowerCase();
            if (!postData.includes(requestBodyFilter)) {
              return false;
            }
          }
          return true;
        };

        let matchedRequest: any = null;
        let matchedResponse: any = null;
        if (statusFilter || responseBodyFilter) {
          matchedResponse = await page.waitForResponse(
            async (response: any) => {
              const request = response?.request?.();
              if (!request || !matchesRequest(request)) {
                return false;
              }
              if (statusFilter) {
                const status = Number(response?.status?.() ?? 0);
                if (status !== statusFilter) {
                  return false;
                }
              }
              if (responseBodyFilter) {
                try {
                  const body = String(await response.text()).toLowerCase();
                  if (!body.includes(responseBodyFilter)) {
                    return false;
                  }
                } catch {
                  return false;
                }
              }
              return true;
            },
            { timeout: timeoutMs },
          );
          matchedRequest = matchedResponse?.request?.() ?? null;
        } else {
          matchedRequest = await page.waitForRequest((request: any) => matchesRequest(request), {
            timeout: timeoutMs,
          });
          matchedResponse = await matchedRequest?.response?.().catch(() => null);
        }

        const requestUrl = String(matchedRequest?.url?.() ?? "");
        const requestMethod = String(matchedRequest?.method?.() ?? "");
        const requestHeaders = (matchedRequest?.headers?.() as Record<string, string>) ?? {};
        const requestBody = String(matchedRequest?.postData?.() ?? "");
        const responseStatus = Number(matchedResponse?.status?.() ?? 0) || null;
        const responseUrl = String(matchedResponse?.url?.() ?? requestUrl);
        const responseHeaders = (matchedResponse?.headers?.() as Record<string, string>) ?? {};
        const responseOk = typeof matchedResponse?.ok === "function" ? Boolean(matchedResponse.ok()) : null;
        const snapshotAfter = params.snapshotAfter === true;
        const snapshot = snapshotAfter ? await captureLiveTabSnapshot(tab, params) : null;
        return {
          ok: true,
          engine,
          activeTabId: tab.id,
          matched: true,
          wait: {
            timeoutMs,
            urlFilter: urlFilter || null,
            methodFilter: methodFilter || null,
            statusFilter: statusFilter || null,
          },
          request: {
            url: requestUrl,
            method: requestMethod || null,
            headers: requestHeaders,
            bodySnippet: requestBody ? requestBody.slice(0, 1000) : "",
          },
          response: {
            url: responseUrl || null,
            status: responseStatus,
            ok: responseOk,
            headers: responseHeaders,
          },
          tab: serializeTab(tab),
          snapshot,
        };
      }

      if (action === "scroll") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const engine = resolveEngine(tab);
        if (engine !== "live") {
          throw new Error("scroll requires engine=live.");
        }
        const page = requireLivePage(tab);
        const deltaX = Number(params.deltaX ?? 0) || 0;
        const deltaY = Number(params.deltaY ?? 0) || 0;
        const toTop = params.toTop === true;
        const toBottom = params.toBottom === true;
        const selector = getExplicitSelector(params, "selector");
        await evalPageScript(
          page,
          `
            const target = args.selector ? document.querySelector(args.selector) : null;
            if (args.toTop) {
              if (target) {
                target.scrollTop = 0;
              } else {
                window.scrollTo({ top: 0, left: 0 });
              }
              return;
            }
            if (args.toBottom) {
              if (target) {
                target.scrollTop = target.scrollHeight;
              } else {
                window.scrollTo({ top: document.body.scrollHeight, left: 0 });
              }
              return;
            }
            if (target) {
              target.scrollBy({ left: args.deltaX, top: args.deltaY });
            } else {
              window.scrollBy({ left: args.deltaX, top: args.deltaY });
            }
          `,
          {
            selector,
            deltaX,
            deltaY,
            toTop,
            toBottom,
          },
        );
        const snapshotAfter = params.snapshotAfter === true;
        const snapshot = snapshotAfter ? await captureLiveTabSnapshot(tab, params) : null;
        return {
          ok: true,
          engine,
          activeTabId: tab.id,
          selector: selector || null,
          deltaX,
          deltaY,
          toTop,
          toBottom,
          tab: serializeTab(tab),
          snapshot,
        };
      }

      if (action === "resize") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const engine = resolveEngine(tab);
        if (engine !== "live") {
          throw new Error("resize requires engine=live.");
        }
        const page = requireLivePage(tab);
        const width = clampInt(params.width, 320, 4096, LIVE_ENGINE_VIEWPORT_WIDTH);
        const height = clampInt(params.height, 240, 4096, LIVE_ENGINE_VIEWPORT_HEIGHT);
        await page.setViewportSize({ width, height });
        tab.updatedAt = Date.now();
        const snapshotAfter = params.snapshotAfter === true;
        const snapshot = snapshotAfter ? await captureLiveTabSnapshot(tab, params) : null;
        return {
          ok: true,
          engine,
          activeTabId: tab.id,
          width,
          height,
          tab: serializeTab(tab),
          snapshot,
        };
      }

      if (action === "hover") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const engine = resolveEngine(tab);
        if (engine !== "live") {
          throw new Error("hover requires engine=live.");
        }
        if (!tab.lastSnapshot) {
          await captureLiveTabSnapshot(tab, params);
        }
        const { selector, ref } = resolveActionSelector(tab, params, {
          allowKinds: ["link", "field", "submit", "form", "button"],
        });
        const page = requireLivePage(tab);
        const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
        await page.locator(selector).first().hover({ timeout: timeoutMs });
        const snapshotAfter = params.snapshotAfter === true;
        const snapshot = snapshotAfter ? await captureLiveTabSnapshot(tab, params) : null;
        return {
          ok: true,
          engine,
          activeTabId: tab.id,
          selector,
          ref: ref?.ref ?? null,
          tab: serializeTab(tab),
          snapshot,
        };
      }

      if (action === "press") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const engine = resolveEngine(tab);
        if (engine !== "live") {
          throw new Error("press requires engine=live.");
        }
        const key = String(params.key ?? "").trim();
        if (!key) {
          throw new Error("key is required for press.");
        }
        if (!tab.lastSnapshot) {
          await captureLiveTabSnapshot(tab, params);
        }
        const page = requireLivePage(tab);
        const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
        const explicitSelector = getExplicitSelector(params, "selector");
        const hasRef = String(params.ref ?? "").trim().length > 0;
        let selector: string | null = null;
        let resolvedRef: BrowserElementRef | null = null;
        if (explicitSelector || hasRef) {
          const resolved = resolveActionSelector(tab, params, {
            allowKinds: ["link", "field", "submit", "form", "button"],
          });
          selector = resolved.selector;
          resolvedRef = resolved.ref;
          await page.locator(selector).first().focus({ timeout: timeoutMs });
          await page.locator(selector).first().press(key, { timeout: timeoutMs });
        } else {
          await page.keyboard.press(key, { timeout: timeoutMs });
        }
        const snapshotAfter = params.snapshotAfter === true;
        const snapshot = snapshotAfter ? await captureLiveTabSnapshot(tab, params) : null;
        return {
          ok: true,
          engine,
          activeTabId: tab.id,
          key,
          selector,
          ref: resolvedRef?.ref ?? null,
          tab: serializeTab(tab),
          snapshot,
        };
      }

      if (action === "select") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const engine = resolveEngine(tab);
        if (engine !== "live") {
          throw new Error("select requires engine=live.");
        }
        if (!tab.lastSnapshot) {
          await captureLiveTabSnapshot(tab, params);
        }
        const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
        const page = requireLivePage(tab);
        const valuesRaw = Array.isArray(params.values)
          ? params.values.map((entry) => String(entry ?? "")).filter((entry) => entry.length > 0)
          : [];
        const singleValue = String(params.value ?? "").trim();
        const values = valuesRaw.length > 0 ? valuesRaw : singleValue ? [singleValue] : [];
        if (values.length === 0) {
          throw new Error("select requires value or values.");
        }

        let selector = getExplicitSelector(params, "selector");
        let resolvedRef: BrowserElementRef | null = null;
        if (!selector) {
          const byRef = resolveSnapshotRef(tab, params.ref);
          if (byRef) {
            if (byRef.kind !== "field") {
              throw new Error(`ref ${byRef.ref} is not a selectable field.`);
            }
            const refSelector = selectorForRef(byRef);
            if (!refSelector) {
              throw new Error(`could not resolve selector for ref ${byRef.ref}.`);
            }
            selector = refSelector;
            resolvedRef = byRef;
          }
        }

        if (!selector) {
          const form = resolveForm(tab, params.formIndex);
          const field = resolveFormField(tab, form, params.fieldName);
          if (field.type !== "select") {
            throw new Error(`field "${field.name}" is not a select field.`);
          }
          selector = `form:nth-of-type(${form.index}) [name="${escapeCssAttributeValue(field.name)}"]`;
        }

        // Try native <select> first. Fall back to custom combobox (role=combobox / role=listbox)
        // which is used by Material UI, Radix, Ant Design, shadcn, etc.
        let selectOk = false;
        try {
          await page.locator(selector).first().selectOption(values, { timeout: Math.min(timeoutMs, 5000) });
          selectOk = true;
        } catch {
          // Not a native select — try combobox pattern.
        }
        if (!selectOk) {
          // Click the trigger to open the dropdown.
          await page.locator(selector).first().click({ timeout: Math.min(timeoutMs, 5000) });
          try {
            await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeoutMs, 2000) });
          } catch {}
          const searchValue = values[0] ?? "";
          // Type into the combobox input if it has one (type-to-filter pattern).
          const comboInput = page.locator(`${selector} input, [role="combobox"] input`).first();
          const hasInput = await comboInput.isVisible().catch(() => false);
          if (hasInput) {
            await comboInput.fill(searchValue, { timeout: Math.min(timeoutMs, 3000) });
            try { await page.waitForTimeout(400); } catch {}
          }
          // Click the matching option in the dropdown.
          const optionClicked = await clickRoleButtonExcludingSocial({
            page,
            namePattern: new RegExp(searchValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
            timeoutMs: Math.min(timeoutMs, 5000),
          });
          if (!optionClicked) {
            // Fallback: click any [role=option] whose text matches.
            const optionLocator = page.locator(`[role="option"]`).filter({ hasText: searchValue }).first();
            await optionLocator.click({ timeout: Math.min(timeoutMs, 4000) });
          }
          selectOk = true;
        }
        if (resolvedRef?.formIndex && resolvedRef.fieldName) {
          const formIndex = resolvedRef.formIndex;
          if (!tab.formValues[formIndex]) {
            tab.formValues[formIndex] = {};
          }
          tab.formValues[formIndex][resolvedRef.fieldName] = values[0];
        }
        tab.updatedAt = Date.now();
        const snapshotAfter = params.snapshotAfter === true;
        const snapshot = snapshotAfter ? await captureLiveTabSnapshot(tab, params) : null;
        return {
          ok: true,
          engine,
          activeTabId: tab.id,
          selector,
          ref: resolvedRef?.ref ?? null,
          values,
          tab: serializeTab(tab),
          snapshot,
        };
      }

      if (action === "drag") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const engine = resolveEngine(tab);
        if (engine !== "live") {
          throw new Error("drag requires engine=live.");
        }
        if (!tab.lastSnapshot) {
          await captureLiveTabSnapshot(tab, params);
        }
        const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
        const page = requireLivePage(tab);

        const startSelector = String(params.startSelector ?? "").trim();
        const endSelector = String(params.endSelector ?? "").trim();
        const startRefRaw = String(params.startRef ?? params.ref ?? "").trim();
        const endRefRaw = String(params.endRef ?? "").trim();

        const startRef = startRefRaw ? resolveSnapshotRef(tab, startRefRaw) : null;
        const endRef = endRefRaw ? resolveSnapshotRef(tab, endRefRaw) : null;
        const fromSelector = startSelector || (startRef ? selectorForRef(startRef) : "");
        const toSelector = endSelector || (endRef ? selectorForRef(endRef) : "");
        if (!fromSelector || !toSelector) {
          throw new Error("drag requires startSelector/endSelector or startRef/endRef.");
        }

        await page.locator(fromSelector).first().dragTo(page.locator(toSelector).first(), {
          timeout: timeoutMs,
        });
        const snapshotAfter = params.snapshotAfter === true;
        const snapshot = snapshotAfter ? await captureLiveTabSnapshot(tab, params) : null;
        return {
          ok: true,
          engine,
          activeTabId: tab.id,
          startSelector: fromSelector,
          endSelector: toSelector,
          startRef: startRef?.ref ?? null,
          endRef: endRef?.ref ?? null,
          tab: serializeTab(tab),
          snapshot,
        };
      }

      if (action === "evaluate") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const engine = resolveEngine(tab);
        if (engine !== "live") {
          throw new Error("evaluate requires engine=live.");
        }
        const expression = String(params.expression ?? "").trim();
        if (!expression) {
          throw new Error("expression is required for evaluate.");
        }
        const page = requireLivePage(tab);
        const result = await evalPageScript(
          page,
          `
            const source = String(args.source ?? "").trim();
            try {
              const exprFn = new Function("return (" + source + ");");
              const value = exprFn();
              return typeof value === "function" ? value() : value;
            } catch {
              // Accept statement-style snippets (for example "var x = ...; return x;").
              const stmtFn = new Function(source);
              const value = stmtFn();
              return typeof value === "function" ? value() : value;
            }
          `,
          { source: expression },
        );
        const snapshotAfter = params.snapshotAfter === true;
        const snapshot = snapshotAfter ? await captureLiveTabSnapshot(tab, params) : null;
        return {
          ok: true,
          engine,
          activeTabId: tab.id,
          result,
          tab: serializeTab(tab),
          snapshot,
        };
      }

      if (action === "upload") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const engine = resolveEngine(tab);
        if (engine !== "live") {
          throw new Error("upload requires engine=live.");
        }
        if (!tab.lastSnapshot) {
          await captureLiveTabSnapshot(tab, params);
        }
        const page = requireLivePage(tab);
        const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
        const { selector, ref } = resolveActionSelector(tab, params, {
          allowKinds: ["field"],
        });
        const many = Array.isArray(params.paths)
          ? params.paths.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
          : [];
        const one = String(params.path ?? "").trim();
        const uploadPaths = many.length > 0 ? many : one ? [one] : [];
        if (uploadPaths.length === 0) {
          throw new Error("upload requires path or paths.");
        }
        await page.locator(selector).first().setInputFiles(uploadPaths, { timeout: timeoutMs });
        const snapshotAfter = params.snapshotAfter !== false;
        const snapshot = snapshotAfter ? await captureLiveTabSnapshot(tab, params) : null;
        return {
          ok: true,
          engine,
          activeTabId: tab.id,
          selector,
          ref: ref?.ref ?? null,
          uploaded: uploadPaths,
          tab: serializeTab(tab),
          snapshot,
        };
      }

      if (action === "dialog") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const engine = resolveEngine(tab);
        if (engine !== "live") {
          throw new Error("dialog requires engine=live.");
        }
        const shouldArm =
          params.accept !== undefined || params.once !== undefined || String(params.promptText ?? "").trim().length > 0;
        let armed: { mode: "accept" | "dismiss"; once: boolean; promptText: string | null } | null = null;
        if (shouldArm) {
          const mode: "accept" | "dismiss" = params.accept === true ? "accept" : "dismiss";
          const promptText = String(params.promptText ?? "").trim();
          const once = params.once !== false;
          liveDialogPlansByTabId.set(tab.id, {
            mode,
            promptText: promptText || undefined,
            once,
            armedAt: Date.now(),
          });
          armed = {
            mode,
            once,
            promptText: promptText || null,
          };
        }
        const clear = params.clear === true;
        const recent = liveDialogEventsByTabId.get(tab.id) ?? [];
        const limit = clampInt(params.limit, 1, 500, 20);
        const events = recent.slice(-limit);
        if (clear) {
          liveDialogEventsByTabId.set(tab.id, []);
        }
        return {
          ok: true,
          engine,
          activeTabId: tab.id,
          armed,
          armedActive: liveDialogPlansByTabId.has(tab.id),
          clear,
          events,
        };
      }

      if (action === "console") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const engine = resolveEngine(tab);
        if (engine !== "live") {
          return {
            ok: true,
            engine,
            activeTabId: tab.id,
            messages: [],
            count: 0,
            total: 0,
          };
        }
        const clear = params.clear === true;
        const rows = liveConsoleByTabId.get(tab.id) ?? [];
        const limit = clampInt(params.limit, 1, 500, 80);
        const level = String(params.level ?? "").trim().toLowerCase();
        const filtered =
          level.length > 0 ? rows.filter((row) => String(row.type ?? "").trim().toLowerCase() === level) : rows;
        const messages = filtered.slice(-limit);
        if (clear) {
          liveConsoleByTabId.set(tab.id, []);
        }
        return {
          ok: true,
          engine,
          activeTabId: tab.id,
          count: messages.length,
          total: filtered.length,
          level: level || undefined,
          clear,
          messages,
        };
      }

      if (action === "downloads") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const engine = resolveEngine(tab);
        if (engine !== "live") {
          return {
            ok: true,
            engine,
            activeTabId: tab.id,
            downloads: [],
            count: 0,
            total: 0,
          };
        }
        const clear = params.clear === true;
        const rows = liveDownloadsByTabId.get(tab.id) ?? [];
        const limit = clampInt(params.limit, 1, 500, 50);
        const items = rows.slice(-limit).map((row) => serializeDownloadEntry(row));
        if (clear) {
          liveDownloadsByTabId.set(tab.id, []);
        }
        return {
          ok: true,
          engine,
          activeTabId: tab.id,
          count: items.length,
          total: rows.length,
          clear,
          downloads: items,
        };
      }

      if (action === "pdf") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const engine = resolveEngine(tab);
        if (engine !== "live") {
          throw new Error("pdf requires engine=live.");
        }
        const page = requireLivePage(tab);
        const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
        const format = String(params.format ?? "").trim() || "A4";
        const printBackground = params.printBackground !== false;
        const filePath = path.join(
          os.tmpdir(),
          `t560-browser-pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`,
        );
        await page.pdf({
          path: filePath,
          format,
          printBackground,
          timeout: timeoutMs,
        });
        const info = await stat(filePath);
        return {
          ok: true,
          engine,
          activeTabId: tab.id,
          pdf: {
            path: filePath,
            bytes: info.size,
            mimeType: "application/pdf",
            format,
            printBackground,
            url: normalizeHttpUrl(page.url() || tab.url),
          },
        };
      }

      if (action === "click") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        if (!tab.lastSnapshot) {
          const seedEngine = resolveEngine(tab);
          if (seedEngine === "live") {
            await captureLiveTabSnapshot(tab, params);
          } else {
            await captureTabSnapshot(tab, params);
          }
        }
        const engine = resolveEngine(tab);
        const byRef = resolveSnapshotRef(tab, params.ref);
        const explicitSelector = getExplicitSelector(params, "selector");
        const requestedSnapshotAfter = params.snapshotAfter !== false;

        if (engine === "live") {
          const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
          const popupWaitMs = clampInt(params.popupWaitMs, 100, 10000, 3000);
          const page = requireLivePage(tab);
          const button = normalizeClickButton(params.button);
          const snapshotAfter = requestedSnapshotAfter || button === "right";
          const clickCount = params.doubleClick === true ? 2 : clampInt(params.clickCount, 1, 5, 1);
          const modifiers = normalizeClickModifiers(params.modifiers);
          const clickOptions: Record<string, unknown> = {
            timeout: timeoutMs,
            button,
            clickCount,
          };
          if (modifiers) {
            clickOptions.modifiers = modifiers;
          }

          let selector = explicitSelector;
          let resolvedRef: BrowserElementRef | null = null;
          let fallbackTarget: BrowserLink | null = null;
          if (!selector) {
            if (byRef) {
              const fromRef = selectorForRef(byRef);
              if (!fromRef) {
                throw new Error(`could not resolve selector for ref ${byRef.ref}.`);
              }
              selector = fromRef;
              resolvedRef = byRef;
            } else {
              const byLinkRef = findLiveLinkRefForClick(tab, params);
              if (byLinkRef) {
                const fromRef = selectorForRef(byLinkRef);
                if (fromRef) {
                  selector = fromRef;
                  resolvedRef = byLinkRef;
                }
              }
              const hasLegacyLinkQuery =
                params.linkIndex !== undefined ||
                String(params.linkText ?? "").trim().length > 0 ||
                String(params.hrefContains ?? "").trim().length > 0;
              if (!selector && hasLegacyLinkQuery) {
                fallbackTarget = findClickTarget(tab, params);
              }
            }
          }

          let clicked: Record<string, unknown> = {};
          let popupTab: BrowserTab | null = null;
          let popupSnapshot: BrowserSnapshot | null = null;
          const downloadCountBefore = (liveDownloadsByTabId.get(tab.id) ?? []).length;
          const beforeUrl = normalizeHttpUrlOrFallback(page.url(), tab.url);
          if (selector) {
            // Resolve frame context for "frame:N:selector" refs produced by iframe snapshot detection.
            const { context: clickCtx, selector: clickSel } = resolveFrameSelector(page, selector);
            const locator = clickCtx.locator(clickSel).first();
            await assertLocatorNotSocialAuth(locator, "click");
            const popupPromise = page.waitForEvent("popup", { timeout: popupWaitMs }).catch(() => null);
            const urlChangedPromise = page
              .waitForURL((url: URL) => url.toString() !== beforeUrl, { timeout: Math.min(timeoutMs, 10_000) })
              .then(() => true)
              .catch(() => false);
            await locator.click(clickOptions as any);
            const popup = await popupPromise;
            await urlChangedPromise;
            if (button === "right") {
              try {
                await page.waitForTimeout(260);
              } catch {
                // no-op
              }
            }
            // Always wait for page to settle after click (handles both SPA state changes
            // and full navigations, including Clerk / OTP multi-step auth flows).
            try {
              await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeoutMs, 3000) });
            } catch {
              // no-op for SPA interactions without a full load event.
            }
            if (popup) {
              const popupResult = await registerPopupTabFromLivePage(tab, popup, params);
              popupTab = popupResult.tab;
              popupSnapshot = popupResult.snapshot;
            }
            clicked = {
              selector,
              ref: resolvedRef?.ref ?? (byRef?.ref ?? null),
              kind: resolvedRef?.kind ?? byRef?.kind ?? null,
              name: resolvedRef?.name ?? byRef?.name ?? null,
              button,
              clickCount,
              modifiers: modifiers ?? [],
            };
          } else {
            fallbackTarget = fallbackTarget ?? findClickTarget(tab, params);
            assertNotSocialAuthTarget({
              label: fallbackTarget.text,
              href: fallbackTarget.url,
              action: "click",
            });
            navigateTab(tab, fallbackTarget.url);
            const response = await page.goto(fallbackTarget.url, {
              waitUntil: "domcontentloaded",
              timeout: timeoutMs,
            });
            setLiveMeta(tab.id, response);
            clicked = fallbackTarget;
          }
          const downloadTimeoutMs = Math.min(timeoutMs, 5000);
          const newDownloads = await waitForNewDownloadEntries({
            tabId: tab.id,
            beforeCount: downloadCountBefore,
            timeoutMs: downloadTimeoutMs,
          });

          let activeTab = tab;
          let snapshot: BrowserSnapshot | null = null;
          let openedSnapshot: BrowserSnapshot | null = null;
          if (popupTab) {
            const focusPopup = params.focusPopup !== false;
            if (focusPopup) {
              setActiveTab(popupTab);
              activeTab = popupTab;
              if (snapshotAfter) {
                snapshot = popupSnapshot ?? (await captureLiveTabSnapshot(popupTab, params));
              }
            } else {
              setActiveTab(tab);
              activeTab = tab;
              if (snapshotAfter) {
                snapshot = await captureLiveTabSnapshot(tab, params);
                openedSnapshot = popupSnapshot;
              }
            }
          } else if (snapshotAfter) {
            snapshot = await captureLiveTabSnapshot(tab, params);
          } else {
            const currentUrl = normalizeHttpUrlOrFallback(page.url(), tab.url);
            if (currentUrl !== beforeUrl) {
              appendHistoryEntry(tab, currentUrl);
            }
            tab.url = currentUrl;
            if (tab.history.length > 0) {
              tab.history[tab.historyIndex] = currentUrl;
            }
            tab.title = String(await page.title()) || summarizeTitleFromUrl(currentUrl);
            tab.updatedAt = Date.now();
          }
          if (snapshot && activeTab.id === tab.id && snapshot.url !== beforeUrl) {
            appendHistoryEntry(tab, snapshot.url);
          }
          return {
            ok: true,
            engine,
            clicked,
            downloads: newDownloads.map((row) => serializeDownloadEntry(row)),
            downloadCount: (liveDownloadsByTabId.get(tab.id) ?? []).length,
            activeTabId: browserState.activeTabId,
            tab: serializeTab(activeTab),
            snapshot,
            openedTab: popupTab ? serializeTab(popupTab) : null,
            openedSnapshot,
          };
        }

        if (explicitSelector) {
          throw new Error("selector-based click requires engine=live.");
        }

        if (byRef?.kind === "submit") {
          const form = resolveForm(tab, byRef.formIndex, byRef.ref);
          assertNotSocialAuthTarget({
            label: byRef.name,
            href: form.action,
            action: "click submission",
          });
          const payload = collectFormPayload(tab, form);
          const payloadText = payload.toString();
          if (form.method === "get") {
            const target = new URL(form.action);
            for (const [key, value] of payload.entries()) {
              target.searchParams.append(key, value);
            }
            navigateTab(tab, target.toString());
            const snapshot = requestedSnapshotAfter ? await captureTabSnapshot(tab, params) : null;
            return {
              ok: true,
              engine,
              clicked: { ref: byRef.ref, kind: byRef.kind, name: byRef.name },
              method: form.method,
              activeTabId: tab.id,
              tab: serializeTab(tab),
              snapshot,
            };
          }
          navigateTab(tab, form.action);
          const snapshot = requestedSnapshotAfter
            ? await captureTabSnapshot(tab, params, {
                method: "POST",
                url: form.action,
                body: payloadText,
              })
            : null;
          return {
            ok: true,
            engine,
            clicked: { ref: byRef.ref, kind: byRef.kind, name: byRef.name },
            method: form.method,
            activeTabId: tab.id,
            tab: serializeTab(tab),
            snapshot,
          };
        }

        const target = byRef?.kind === "link" && byRef.url ? { index: -1, text: byRef.name, url: byRef.url } : findClickTarget(tab, params);
        assertNotSocialAuthTarget({
          label: target.text,
          href: target.url,
          action: "click",
        });
        navigateTab(tab, target.url);
        const snapshot = requestedSnapshotAfter ? await captureTabSnapshot(tab, params) : null;
        return {
          ok: true,
          engine,
          clicked: target,
          activeTabId: tab.id,
          tab: serializeTab(tab),
          snapshot,
        };
      }

      if (action === "act") {
        const kindRaw = String(params.kind ?? "click").trim().toLowerCase();
        const kind = kindRaw.replace(/-/g, "_");
        const requestFields = Array.isArray(params.fields)
          ? params.fields.filter((entry) => entry && typeof entry === "object")
          : [];
        if (kind === "fill" && requestFields.length > 0) {
          let lastResult: unknown = null;
          for (const fieldEntry of requestFields) {
            const row = fieldEntry as Record<string, unknown>;
            lastResult = await tool.execute("browser-act-fill-delegate", {
              ...params,
              action: "fill",
              fields: undefined,
              ref: row.ref ?? row.fieldRef ?? params.ref,
              selector: row.selector ?? params.selector,
              formIndex: row.formIndex ?? params.formIndex,
              fieldName: row.fieldName ?? row.name ?? params.fieldName,
              value: row.value ?? row.text ?? "",
            });
          }
          if (lastResult && typeof lastResult === "object" && !("kind" in (lastResult as Record<string, unknown>))) {
            return {
              kind,
              batch: true,
              filled: requestFields.length,
              ...(lastResult as Record<string, unknown>),
            };
          }
          return lastResult;
        }
        const mappedAction =
          kind === "click" ||
          kind === "type" ||
          kind === "fill" ||
          kind === "submit" ||
          kind === "navigate" ||
          kind === "wait" ||
          kind === "wait_for_request" ||
          kind === "hover" ||
          kind === "press" ||
          kind === "select" ||
          kind === "drag" ||
          kind === "evaluate" ||
          kind === "upload" ||
          kind === "dialog" ||
          kind === "console" ||
          kind === "downloads" ||
          kind === "pdf" ||
          kind === "scroll" ||
          kind === "resize" ||
          kind === "login" ||
          kind === "mfa" ||
          kind === "challenge" ||
          kind === "close"
            ? kind
            : null;
        if (!mappedAction) {
          throw new Error(`unsupported act kind: ${kind}`);
        }
        const delegated = await tool.execute("browser-act-delegate", {
          ...params,
          action: mappedAction,
        });
        if (delegated && typeof delegated === "object" && !("kind" in delegated)) {
          return {
            kind,
            ...(delegated as Record<string, unknown>),
          };
        }
        return delegated;
      }

      if (action === "back" || action === "forward") {
        const tab = resolveTab(params.tabId);
        setActiveTab(tab);
        const engine = resolveEngine(tab);
        if (engine === "live") {
          const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
          const page = getLivePage(tab.id);
          if (!page) {
            throw new Error(`tab ${tab.id} is not backed by a live browser page.`);
          }
          const response =
            action === "back"
              ? await page.goBack({ waitUntil: "domcontentloaded", timeout: timeoutMs })
              : await page.goForward({ waitUntil: "domcontentloaded", timeout: timeoutMs });
          if (!response) {
            return {
              ok: true,
              engine,
              activeTabId: tab.id,
              tab: serializeTab(tab),
              moved: false,
              reason: action === "back" ? "already at oldest history entry" : "already at latest history entry",
            };
          }
          setLiveMeta(tab.id, response);
          const currentUrl = normalizeHttpUrl(page.url() || tab.url);
          if (action === "back") {
            tab.historyIndex = Math.max(0, tab.historyIndex - 1);
          } else {
            tab.historyIndex = Math.min(tab.history.length - 1, tab.historyIndex + 1);
          }
          tab.url = currentUrl;
          tab.title = summarizeTitleFromUrl(currentUrl);
          tab.updatedAt = Date.now();
          const snapshotAfter = params.snapshotAfter !== false;
          const snapshot = snapshotAfter ? await captureLiveTabSnapshot(tab, params) : null;
          return {
            ok: true,
            engine,
            activeTabId: tab.id,
            tab: serializeTab(tab),
            moved: true,
            snapshot,
          };
        }
        const nextIndex =
          action === "back"
            ? Math.max(0, tab.historyIndex - 1)
            : Math.min(tab.history.length - 1, tab.historyIndex + 1);
        if (nextIndex === tab.historyIndex) {
          return {
            ok: true,
            engine,
            activeTabId: tab.id,
            tab: serializeTab(tab),
            moved: false,
            reason: action === "back" ? "already at oldest history entry" : "already at latest history entry",
          };
        }
        tab.historyIndex = nextIndex;
        tab.url = tab.history[nextIndex];
        tab.title = summarizeTitleFromUrl(tab.url);
        clearTabTransient(tab);
        tab.updatedAt = Date.now();
        const snapshotAfter = params.snapshotAfter !== false;
        const snapshot = snapshotAfter ? await captureTabSnapshot(tab, params) : null;
        return {
          ok: true,
          engine,
          activeTabId: tab.id,
          tab: serializeTab(tab),
          moved: true,
          snapshot,
        };
      }

      throw new Error(`unsupported browser action: ${action}`);
    },
  };
  return tool;
}
