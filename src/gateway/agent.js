import {
  buildInputFromMessages,
  createResponse,
  extractFunctionCalls,
  extractOutputText,
  isUnstoredInputItemReferenceError,
  sanitizeInputForUnstoredReplay,
} from "../openai/responses.js";
import { createChatCompletion, extractChatText, extractChatToolCalls } from "../openai/chat_completions.js";
import { parseModelRef } from "../models/model_ref.js";
import { getToolDefinitions, toAnthropicTools, toOpenAIChatTools, toOpenAIResponseTools } from "../tools/definitions.js";
import { dispatchToolCall } from "../tools/dispatch.js";
import { anthropicCreateMessage, anthropicExtractText, anthropicExtractToolUses } from "../anthropic/messages.js";
import { buildSkillsPrompt, buildSkillsRunEnv } from "../skills/runtime.js";
import { loadSession, saveSession } from "./state.js";
import { resolveModelRefForTurn } from "./model_select.js";
import fs from "node:fs";
import crypto from "node:crypto";

function isProviderMessageFormatError(err) {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  return (
    msg.includes("invalid message") ||
    msg.includes("invalid messages") ||
    msg.includes("invalid input") ||
    msg.includes("invalid response") ||
    msg.includes("tool_call") ||
    msg.includes("tool call") ||
    msg.includes("schema") ||
    msg.includes("format")
  );
}

function normalizeChatRole(role) {
  const r = String(role ?? "").trim().toLowerCase();
  if (r === "assistant") return "assistant";
  return "user";
}

function buildTextOnlyChatConversation({ messages, instructions }) {
  return [
    { role: "system", content: String(instructions ?? "") },
    ...(messages ?? []).map((m) => ({
      role: normalizeChatRole(m.role),
      content: String(m.content ?? ""),
    })),
  ];
}

function stringifyToolArguments(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function resolveOpenAIReasoningEffort({ provider, model }) {
  const p = String(provider ?? "").trim().toLowerCase();
  const m = String(model ?? "").trim().toLowerCase();
  if (p !== "openai" && p !== "openai-codex") return undefined;
  if (!m.startsWith("gpt-5")) return undefined;
  if (m.includes("mini")) return "low";
  return "medium";
}

function resolveDefaultMaxToolSteps(provider) {
  const p = String(provider ?? "").trim().toLowerCase();
  if (p === "openai-codex") return 12;
  if (p === "openai") return 10;
  if (p === "anthropic") return 8;
  return 6;
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timeout: true, error: "timeout" }), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function safeSessionMeta(session) {
  return session?.meta && typeof session.meta === "object" && !Array.isArray(session.meta) ? session.meta : {};
}

async function runOpenAIResponsesLoop(params) {
  const { env, auth, parsedModel, messages, tools, instructions, maxToolSteps, toolContext } = params;
  let input = buildInputFromMessages(messages);
  let lastText = "";
  const reasoning = resolveOpenAIReasoningEffort({ provider: parsedModel?.provider, model: parsedModel?.model });

  for (let step = 0; step < maxToolSteps; step += 1) {
    const provider = parsedModel.provider;
    const model = parsedModel.model;
    let token = "";
    let transport = "openai";
    let codexAccountId = "";
    let organization = undefined;
    let project = undefined;
    if (provider === "openai-codex") {
      token = String(auth?.codex?.accessToken ?? "").trim();
      codexAccountId = String(auth?.codex?.accountId ?? "").trim();
      transport = "openai-codex";
      if (!token) throw new Error("Missing OpenAI Codex OAuth token. Run: t560 deploy");
      if (!codexAccountId) throw new Error("Missing OpenAI Codex account id. Run: t560 deploy");
    } else {
      token = String(auth?.openai?.apiKey ?? "").trim();
      organization = auth?.openai?.organization;
      project = auth?.openai?.project;
      if (!token) throw new Error("Missing OpenAI API key. Run: t560 deploy");
    }

    let json = null;
    try {
      const out = await createResponse({
        apiKey: token,
        organization,
        project,
        model,
        input,
        tools,
        parallelToolCalls: false,
        // Keep policy out of message history.
        instructions,
        transport,
        codexAccountId,
        reasoning,
        timeoutMs: 120_000,
      });
      json = out.json;
    } catch (err) {
      // OpenAI/Codex can return "Item with id ... not found" when replaying stale items with store=false.
      // Recover by stripping reference IDs and retrying once with sanitized input.
      if (isUnstoredInputItemReferenceError(err)) {
        const repairedInput = sanitizeInputForUnstoredReplay(input);
        const retryInput = repairedInput.length > 0 ? repairedInput : buildInputFromMessages(messages);
        const out = await createResponse({
          apiKey: token,
          organization,
          project,
          model,
          input: retryInput,
          tools,
          parallelToolCalls: false,
          instructions,
          transport,
          codexAccountId,
          reasoning,
          timeoutMs: 120_000,
        });
        input = retryInput;
        json = out.json;
      } else {
        // Some OpenAI-compatible surfaces (especially OAuth-backed/codex transports)
        // can reject tool schemas/messages. Fall back to plain text completion for this turn.
        if (Array.isArray(tools) && tools.length > 0 && isProviderMessageFormatError(err)) {
          const out = await createResponse({
            apiKey: token,
            organization,
            project,
            model,
            input: buildInputFromMessages(messages),
            tools: undefined,
            parallelToolCalls: false,
            instructions,
            transport,
            codexAccountId,
            reasoning,
            timeoutMs: 120_000,
          });
          return { ok: true, reply: extractOutputText(out.json) || "" };
        }
        throw err;
      }
    }

    lastText = extractOutputText(json);

    const calls = extractFunctionCalls(json);
    const outItems = Array.isArray(json?.output) ? json.output : [];
    input = [...input, ...outItems];

    if (!calls || calls.length === 0) {
      return { ok: true, reply: lastText || "" };
    }

    for (const call of calls) {
      const result = await dispatchToolCall({ name: call.name, arguments: call.arguments, env, context: toolContext });
      input.push({
        type: "function_call_output",
        call_id: call.callId,
        output: JSON.stringify(result),
      });
    }
  }

  return { ok: true, reply: lastText || "" };
}

async function runOpenAICompatChatLoop(params) {
  const { env, auth, parsedModel, messages, tools, instructions, maxToolSteps, baseUrl, extraHeaders, toolContext } = params;

  const apiKey = String(auth?.apiKey ?? "").trim();
  if (!apiKey) throw new Error("Missing API key. Run: t560 deploy");

  const model = parsedModel.model;
  const convo = buildTextOnlyChatConversation({ messages, instructions });

  let lastText = "";
  for (let step = 0; step < maxToolSteps; step += 1) {
    let json = null;
    try {
      json = await createChatCompletion({
        apiKey,
        baseUrl,
        model,
        messages: convo,
        tools,
        toolChoice: tools && tools.length > 0 ? "auto" : undefined,
        extraHeaders,
        timeoutMs: 120_000,
      });
    } catch (err) {
      // Recovery path: if tool payload format is rejected, retry text-only for this turn.
      if (Array.isArray(tools) && tools.length > 0 && isProviderMessageFormatError(err)) {
        const fallbackJson = await createChatCompletion({
          apiKey,
          baseUrl,
          model,
          messages: buildTextOnlyChatConversation({ messages, instructions }),
          tools: undefined,
          toolChoice: undefined,
          extraHeaders,
          timeoutMs: 120_000,
        });
        return { ok: true, reply: extractChatText(fallbackJson) || "" };
      }
      throw err;
    }

    lastText = extractChatText(json);
    const toolCalls = extractChatToolCalls(json);

    const assistantMsg = {
      role: "assistant",
      // Some OpenAI-compatible providers reject null content; keep it a string.
      content: lastText || "",
      ...(toolCalls.length > 0
        ? {
            tool_calls: toolCalls.map((c) => ({
              id: c.id,
              type: "function",
              function: {
                name: c.name,
                arguments: stringifyToolArguments(c.arguments),
              },
            })),
          }
        : {}),
    };
    convo.push(assistantMsg);

    if (!toolCalls || toolCalls.length === 0) {
      return { ok: true, reply: lastText || "" };
    }

    for (const call of toolCalls) {
      const result = await dispatchToolCall({ name: call.name, arguments: call.arguments, env, context: toolContext });
      convo.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return { ok: true, reply: lastText || "" };
}

async function runAnthropicMessagesLoop(params) {
  const { env, auth, parsedModel, messages, tools, system, maxToolSteps, baseUrl, toolContext } = params;
  const apiKey = String(auth?.anthropic?.apiKey ?? "").trim();
  if (!apiKey) throw new Error("Missing Anthropic API key. Run: t560 deploy");
  const model = parsedModel.model;

  // Anthropic messages with tool use require us to keep the tool_use and tool_result blocks.
  const convo = (messages ?? []).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: [{ type: "text", text: String(m.content ?? "") }],
  }));

  let lastText = "";

  for (let step = 0; step < maxToolSteps; step += 1) {
    const json = await anthropicCreateMessage({
      apiKey,
      model,
      system,
      messages: convo,
      tools,
      maxTokens: 1024,
      baseUrl,
      timeoutMs: 120_000,
    });

    lastText = anthropicExtractText(json);
    const toolUses = anthropicExtractToolUses(json);
    const assistantBlocks = Array.isArray(json?.content) ? json.content : [];
    convo.push({ role: "assistant", content: assistantBlocks });

    if (!toolUses || toolUses.length === 0) {
      return { ok: true, reply: lastText || "" };
    }

    const results = [];
