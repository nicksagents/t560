import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { note } from "../terminal/note.js";
import { stylePromptHint, stylePromptMessage, stylePromptTitle } from "../terminal/promptStyle.js";
import { theme } from "../terminal/theme.js";

export class WizardCancelledError extends Error {
  constructor(message = "wizard cancelled") {
    super(message);
    this.name = "WizardCancelledError";
  }
}

function guardCancel(value) {
  if (isCancel(value)) {
    cancel(stylePromptTitle("Setup cancelled.") ?? "Setup cancelled.");
    throw new WizardCancelledError();
  }
  return value;
}

export function createPrompter() {
  return {
    intro: async (title) => {
      intro(stylePromptTitle(title) ?? title);
    },
    outro: async (message) => {
      outro(stylePromptTitle(message) ?? message);
    },
    note: async (message, title) => {
      note(message, title);
    },
    confirm: async ({ message, initialValue }) =>
      guardCancel(
        await confirm({
          message: stylePromptMessage(message),
          initialValue,
        }),
      ),
    select: async ({ message, options, initialValue }) =>
      guardCancel(
        await select({
          message: stylePromptMessage(message),
          options: options.map((opt) => {
            const base = { value: opt.value, label: opt.label };
            return opt.hint ? { ...base, hint: stylePromptHint(opt.hint) } : base;
          }),
          initialValue,
        }),
      ),
    multiselect: async ({ message, options, initialValues }) =>
      guardCancel(
        await multiselect({
          message: stylePromptMessage(message),
          options: options.map((opt) => {
            const base = { value: opt.value, label: opt.label };
            return opt.hint ? { ...base, hint: stylePromptHint(opt.hint) } : base;
          }),
          initialValues,
          required: false,
        }),
      ),
    text: async ({ message, initialValue, placeholder, validate }) =>
      guardCancel(
        await text({
          message: stylePromptMessage(message),
          initialValue,
          placeholder,
          validate: validate ? (v) => validate(v ?? "") : undefined,
        }),
      ),
    progress: (label) => {
      const spin = spinner();
      spin.start(theme.accent(label));
      return {
        update: (msg) => spin.message(theme.accent(msg)),
        stop: (msg) => spin.stop(msg),
      };
    },
  };
}
