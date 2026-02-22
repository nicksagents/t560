import readline from "node:readline/promises";
import process from "node:process";
import colors from "picocolors";
import type { AppConfig } from "../config/types.js";
import { generateAssistantResponse } from "../llm/router.js";
import { startWebChatServer, type ChatEnvelope } from "./webchat.js";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

function toEnvelope(role: ChatEnvelope["role"], text: string): ChatEnvelope {
  return {
    type: "message",
    role,
    text,
    timestamp: new Date().toISOString(),
  };
}

export async function startChatRuntime(config: AppConfig, port = 3456): Promise<void> {
  const history: ChatMessage[] = [];
  let queue = Promise.resolve();

  const web = await startWebChatServer({
    port,
    onUserMessage: async (text) => {
      queue = queue.then(async () => {
        history.push({ role: "user", content: text });
        web.broadcast(toEnvelope("user", text));
        const reply = await generateAssistantResponse(config, history);
        history.push({ role: "assistant", content: reply });
        web.broadcast(toEnvelope("assistant", reply));
      });
      await queue;
    },
  });

  console.log(colors.bold(colors.cyan(`WebChat: ${web.url}`)));
  console.log(colors.dim("Terminal chat ready. Type /exit to quit."));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const prompt = colors.bold(colors.blue("you")) + colors.dim(" > ");
      const userText = (await rl.question(prompt)).trim();
      if (!userText) {
        continue;
      }
      if (userText === "/exit" || userText === "/quit") {
        break;
      }

      history.push({ role: "user", content: userText });
      web.broadcast(toEnvelope("user", userText));
      const reply = await generateAssistantResponse(config, history);
      history.push({ role: "assistant", content: reply });
      web.broadcast(toEnvelope("assistant", reply));
      console.log(colors.bold(colors.green("t560")) + colors.dim(" > ") + reply);
    }
  } finally {
    rl.close();
    await web.close();
  }
}

