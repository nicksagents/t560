import crypto from "node:crypto";
import { WizardCancelledError } from "./prompter.js";

function randomId() {
  return crypto.randomBytes(12).toString("hex");
}

export function createWebWizardPrompter() {
  const sessionId = randomId();
  let pending = null; // { step, resolve, reject }
  let introTitle = "";
  let outroMessage = "";
  let notes = [];
  let completed = false;
  let cancelled = false;
  let lastProgress = null;

  const waitForAnswer = (step) =>
    new Promise((resolve, reject) => {
      pending = { step, resolve, reject };
    });

  const prompter = {
    async intro(title) {
      introTitle = String(title ?? "");
      notes.push({ type: "intro", title: introTitle });
    },
    async outro(message) {
      outroMessage = String(message ?? "");
      notes.push({ type: "outro", message: outroMessage });
      completed = true;
    },
    async note(message, title) {
      notes.push({ type: "note", title: String(title ?? ""), message: String(message ?? "") });
    },
    select: async (params) => {
      const step = {
        id: randomId(),
        type: "select",
        message: String(params?.message ?? ""),
        options: (params?.options ?? []).map((o) => ({
          value: o.value,
          label: o.label,
          hint: o.hint,
        })),
        initialValue: params?.initialValue ?? null,
      };
      const ans = await waitForAnswer(step);
      return ans;
    },
    multiselect: async (params) => {
      const step = {
        id: randomId(),
        type: "multiselect",
        message: String(params?.message ?? ""),
        options: (params?.options ?? []).map((o) => ({
          value: o.value,
          label: o.label,
          hint: o.hint,
        })),
        initialValues: params?.initialValues ?? [],
      };
      const ans = await waitForAnswer(step);
      return Array.isArray(ans) ? ans : [];
    },
    text: async (params) => {
      const step = {
        id: randomId(),
        type: "text",
        message: String(params?.message ?? ""),
        initialValue: params?.initialValue ?? "",
        placeholder: params?.placeholder ?? "",
      };
      const value = await waitForAnswer(step);
      const v = String(value ?? "");
      if (typeof params?.validate === "function") {
        const err = params.validate(v);
        if (err) {
          // Re-ask with validation error attached.
          const step2 = { ...step, id: randomId(), error: String(err) };
          const value2 = await waitForAnswer(step2);
          return String(value2 ?? "");
        }
      }
      return v;
    },
    confirm: async (params) => {
      const step = {
        id: randomId(),
        type: "confirm",
        message: String(params?.message ?? ""),
        initialValue: Boolean(params?.initialValue ?? false),
      };
      const value = await waitForAnswer(step);
      return Boolean(value);
    },
    progress: (label) => {
      const id = randomId();
      lastProgress = { id, label: String(label ?? ""), message: "" };
      return {
        update: (message) => {
          lastProgress = { id, label: String(label ?? ""), message: String(message ?? "") };
        },
        stop: (message) => {
          if (message) {
            notes.push({ type: "note", title: String(label ?? ""), message: String(message ?? "") });
          }
          lastProgress = null;
        },
      };
    },
  };

  const api = {
    sessionId,
    prompter,
    nextStep() {
      if (cancelled) throw new WizardCancelledError("cancelled");
      if (pending?.step) return pending.step;
      return null;
    },
    drainNotes() {
      const out = notes;
      notes = [];
      return out;
    },
    getStatus() {
      return {
        sessionId,
        introTitle,
        outroMessage,
        completed,
        cancelled,
        pending: pending?.step ?? null,
        progress: lastProgress,
      };
    },
    answer(answer) {
      if (!pending) return;
      const { resolve } = pending;
      pending = null;
      resolve(answer);
    },
    cancel() {
      cancelled = true;
      if (pending?.reject) {
        const rej = pending.reject;
        pending = null;
        rej(new WizardCancelledError("cancelled"));
      }
    },
  };

  return api;
}
