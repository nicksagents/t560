import {
  cancel,
  confirm,
  intro,
  isCancel,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";

type SelectOption<T> = {
  label: string;
  value: T;
};

export class OnboardingCancelledError extends Error {
  constructor(message = "Onboarding cancelled") {
    super(message);
    this.name = "OnboardingCancelledError";
  }
}

function assertNotCancelled<T>(value: T): T {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    throw new OnboardingCancelledError();
  }
  return value;
}

export function createClackOnboardingPrompter() {
  return {
    async intro(message: string): Promise<void> {
      intro(message);
    },

    async outro(message: string): Promise<void> {
      outro(message);
    },

    async note(message: string, title?: string): Promise<void> {
      note(message, title);
    },

    async askYesNo(message: string, initial = true): Promise<boolean> {
      const value = await confirm({
        message,
        initialValue: initial,
      });
      return Boolean(assertNotCancelled(value));
    },

    async askRequired(message: string, initial?: string): Promise<string> {
      const value = await text({
        message,
        defaultValue: initial,
        validate: (input) => (String(input ?? "").trim().length > 0 ? undefined : "Required."),
      });
      return String(assertNotCancelled(value)).trim();
    },

    async choose<T>(message: string, options: Array<SelectOption<T>>): Promise<T> {
      const value = await select<T>({
        message,
        options: options.map((option) => ({
          value: option.value,
          label: option.label,
        })),
      });
      return assertNotCancelled(value);
    },

    progress(label: string): { update: (message: string) => void; stop: (message?: string) => void } {
      const handle = spinner();
      handle.start(label);
      return {
        update(message: string) {
          handle.message(message);
        },
        stop(message?: string) {
          handle.stop(message);
        },
      };
    },

    close(): void {
      // no-op: clack manages TTY lifecycle for these prompt primitives
    },
  };
}
