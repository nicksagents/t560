import readline from "node:readline";

async function askLine(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, (answer) => resolve(answer)));
}

export async function runTerminalChat({ baseUrl, gatewayToken, sessionId = "terminal" }) {
  const url = String(baseUrl ?? "").trim();
  const token = String(gatewayToken ?? "").trim();
  if (!url) throw new Error("Missing baseUrl.");
  if (!token) throw new Error("Missing gatewayToken.");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`t560 chat (gateway: ${url})`);
  console.log("Ctrl+C to exit.");

  try {
    while (true) {
      const input = String(await askLine(rl, "> ")).trim();
      if (!input) continue;
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sessionId, message: input }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = json?.error || json?.message || `Gateway error (status ${res.status})`;
        console.log(`[error] ${msg}`);
        continue;
      }
      console.log(String(json?.reply ?? "").trim() || "(empty response)");
    }
  } finally {
    rl.close();
  }
}
