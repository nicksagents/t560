import { runOnboardingWizard } from "./onboard.js";
import { createWebWizardPrompter } from "./web_prompter.js";

export function createWizardSession({ env = process.env } = {}) {
  const web = createWebWizardPrompter();
  const { prompter, sessionId } = web;

  let started = false;
  let done = false;
  let error = null;

  const start = async () => {
    if (started) return;
    started = true;
    void (async () => {
      try {
        await runOnboardingWizard({ prompter, env });
        done = true;
      } catch (e) {
        error = e;
        done = true;
      }
    })();
  };

  const status = () => ({
    ...web.getStatus(),
    started,
    done,
    error: error ? String(error?.message ?? error) : null,
    notes: web.drainNotes(),
    step: web.nextStep(),
  });

  const answer = async (value) => {
    web.answer(value);
  };

  const cancel = async () => {
    web.cancel();
  };

  return { sessionId, start, status, answer, cancel };
}

