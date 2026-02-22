import crypto from "node:crypto";
import { createWizardSession } from "../wizard/web_session.js";

function randomId() {
  return `wiz_${crypto.randomBytes(12).toString("hex")}`;
}

export function createWizardSessionTracker() {
  const sessions = new Map();

  const create = ({ env } = {}) => {
    const id = randomId();
    const session = createWizardSession({ env });
    sessions.set(id, session);
    return { id, session };
  };

  const get = (id) => (id ? sessions.get(String(id)) : undefined);

  const remove = (id) => {
    sessions.delete(String(id));
  };

  return { create, get, remove, sessions };
}

