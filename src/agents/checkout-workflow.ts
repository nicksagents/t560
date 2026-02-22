type CheckoutRisk = {
  action: string;
  reason: string;
  targetHint: string | null;
};

type PendingCheckout = CheckoutRisk & {
  createdAt: number;
};

type SessionCheckoutState = {
  pending: PendingCheckout | null;
  confirmedUntil: number;
};

type GuardDecision =
  | { allowed: true; confirmed: boolean; state: SessionCheckoutState }
  | { allowed: false; message: string; state: SessionCheckoutState };

const CHECKOUT_CONFIRM_TTL_MS = 5 * 60_000;
const checkoutStateBySession = new Map<string, SessionCheckoutState>();
const CHECKOUT_KEYWORDS =
  /\b(add to cart|buy now|checkout|place order|submit order|confirm order|purchase|pay now|payment|one[-\s]?click)\b/i;
const CHECKOUT_URL_HINT =
  /(amazon\.[a-z.]+\/(gp\/buy|checkout|cart)|\/checkout|\/cart|\/buy-now|\/place-order|\/payment)/i;
const CHECKOUT_ACTIONS = new Set(["click", "submit", "act"]);
const CONFIRM_REGEX =
  /\b(confirm|approved?|yes)\b.{0,20}\b(order|purchase|checkout|buy|payment)\b|\bt560\s+confirm\s+purchase\b/i;
const CANCEL_REGEX = /\b(cancel|abort|stop)\b.{0,20}\b(order|purchase|checkout|buy|payment)\b/i;

function normalizeToolName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function nowMs(): number {
  return Date.now();
}

function getState(sessionId: string): SessionCheckoutState {
  const existing = checkoutStateBySession.get(sessionId);
  if (existing) {
    return existing;
  }
  const fresh: SessionCheckoutState = {
    pending: null,
    confirmedUntil: 0,
  };
  checkoutStateBySession.set(sessionId, fresh);
  return fresh;
}

function compact(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function collectCheckoutHints(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    const text = compact(value);
    if (text) {
      out.push(text.toLowerCase());
    }
  };
  push(args.url);
  push(args.targetUrl);
  push(args.selector);
  push(args.element);
  push(args.linkText);
  push(args.hrefContains);
  push(args.ref);
  push(args.inputRef);
  const request = args.request;
  if (request && typeof request === "object" && !Array.isArray(request)) {
    const req = request as Record<string, unknown>;
    push(req.kind);
    push(req.selector);
    push(req.element);
    push(req.ref);
    push(req.inputRef);
    push(req.url);
    push(req.targetUrl);
    push(req.text);
  }
  return out;
}

function detectCheckoutRisk(toolName: string, args: unknown): CheckoutRisk | null {
  if (normalizeToolName(toolName) !== "browser") {
    return null;
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }

  const record = args as Record<string, unknown>;
  const action = compact(record.action).toLowerCase();
  if (!CHECKOUT_ACTIONS.has(action)) {
    return null;
  }
  const hints = collectCheckoutHints(record);
  const joined = hints.join(" | ");
  if (!joined) {
    return null;
  }

  if (CHECKOUT_KEYWORDS.test(joined) || CHECKOUT_URL_HINT.test(joined)) {
    return {
      action,
      reason: "purchase/checkout trigger detected",
      targetHint: hints[0] ?? null,
    };
  }

  const request = record.request;
  if (action === "act" && request && typeof request === "object" && !Array.isArray(request)) {
    const req = request as Record<string, unknown>;
    const kind = compact(req.kind).toLowerCase();
    if ((kind === "click" || kind === "submit") && (CHECKOUT_KEYWORDS.test(joined) || CHECKOUT_URL_HINT.test(joined))) {
      return {
        action: `act:${kind}`,
        reason: "purchase/checkout trigger detected",
        targetHint: hints[0] ?? null,
      };
    }
  }

  return null;
}

function buildBlockMessage(risk: CheckoutRisk): string {
  const hint = risk.targetHint ? ` Target: ${risk.targetHint}.` : "";
  return [
    `Checkout protection blocked browser action "${risk.action}" (${risk.reason}).${hint}`,
    'Reply with "confirm purchase" to authorize checkout actions for the next 5 minutes.',
  ].join("\n");
}

export function beginCheckoutWorkflowTurn(params: {
  sessionId: string;
  userMessage: string;
}): { confirmedThisTurn: boolean; canceled: boolean } {
  const state = getState(params.sessionId);
  const now = nowMs();
  if (state.confirmedUntil <= now) {
    state.confirmedUntil = 0;
  }

  const userMessage = compact(params.userMessage).toLowerCase();
  if (!userMessage) {
    return { confirmedThisTurn: false, canceled: false };
  }

  if (CANCEL_REGEX.test(userMessage)) {
    state.pending = null;
    state.confirmedUntil = 0;
    return { confirmedThisTurn: false, canceled: true };
  }

  if (CONFIRM_REGEX.test(userMessage)) {
    state.confirmedUntil = now + CHECKOUT_CONFIRM_TTL_MS;
    state.pending = null;
    return { confirmedThisTurn: true, canceled: false };
  }

  return { confirmedThisTurn: false, canceled: false };
}

export function enforceCheckoutWorkflow(params: {
  sessionId: string;
  toolName: string;
  toolArgs: unknown;
}): GuardDecision {
  const state = getState(params.sessionId);
  const now = nowMs();
  if (state.confirmedUntil <= now) {
    state.confirmedUntil = 0;
  }

  const risk = detectCheckoutRisk(params.toolName, params.toolArgs);
  if (!risk) {
    return { allowed: true, confirmed: false, state };
  }

  const hasConfirmation = state.confirmedUntil > now;
  if (hasConfirmation) {
    state.pending = null;
    return { allowed: true, confirmed: true, state };
  }

  state.pending = {
    ...risk,
    createdAt: now,
  };
  return {
    allowed: false,
    message: buildBlockMessage(risk),
    state,
  };
}

export function describeCheckoutWorkflowState(sessionId: string): string | null {
  const state = checkoutStateBySession.get(sessionId);
  if (!state) {
    return null;
  }
  const now = nowMs();
  const remainingMs = Math.max(0, state.confirmedUntil - now);
  if (remainingMs > 0) {
    return `checkout authorization active for ${Math.ceil(remainingMs / 1000)}s`;
  }
  if (state.pending) {
    return `checkout authorization pending (${state.pending.action})`;
  }
  return null;
}
