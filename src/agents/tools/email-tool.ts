import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { randomUUID } from "node:crypto";
import { Type } from "@mariozechner/pi-ai";
import type { AnyAgentTool } from "../pi-tools.types.js";
import {
  getCredential,
  listConfiguredServices,
  normalizeSetupService,
  type CredentialRecord,
} from "../../security/credentials-vault.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_IMAP_BODY_PREVIEW_CHARS = 2500;
const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 50;
const MAX_BODY_PREVIEW_CHARS = 16_000;
const MAX_IMAP_COMMAND_LINES = 2000;
const MAX_IMAP_LITERAL_BYTES = 8_000_000;
const MAX_SMTP_RESPONSE_LINES = 500;
const LOGOUT_GRACE_TIMEOUT_MS = 3_000;

type EmailAction = "status" | "list_unread" | "read_unread" | "read_recent" | "send";
type EmailProviderId = "gmail" | "outlook" | "yahoo" | "icloud" | "proton" | "custom";
type AnySocket = net.Socket | tls.TLSSocket;

type TransportSettings = {
  host: string;
  port: number;
  secure: boolean;
  startTls: boolean;
};

type ResolvedProviderConfig = {
  providerId: EmailProviderId;
  label: string;
  loginUrl: string;
  protocolSupported: boolean;
  notes: string[];
  imap: TransportSettings | null;
  smtp: TransportSettings | null;
};

type ImapResponsePart =
  | { kind: "line"; line: string }
  | { kind: "literal"; line: string; data: Buffer };

type ParsedMessage = {
  sequence: number;
  uid: number | null;
  flags: string[];
  internalDate: string;
  size: number;
  headersRaw: string;
  bodyRaw: string;
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function sanitizeHeaderValue(value: string): string {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error ?? "unknown error");
}

function maskIdentifier(identifier: string): string {
  const value = String(identifier ?? "").trim();
  if (!value) {
    return "(empty)";
  }
  const at = value.indexOf("@");
  if (at > 1) {
    return `${value.slice(0, 1)}***${value.slice(at)}`;
  }
  if (value.length <= 3) {
    return `${value[0] ?? "*"}**`;
  }
  return `${value.slice(0, 2)}***${value.slice(-1)}`;
}

function normalizeHost(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) {
    return "";
  }
  return raw.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/^www\./, "");
}

function parseDomainFromEmailAddress(value: string): string {
  const source = String(value ?? "").trim().toLowerCase();
  const at = source.lastIndexOf("@");
  if (at < 0 || at >= source.length - 1) {
    return "";
  }
  return source.slice(at + 1).replace(/[^a-z0-9.-]/g, "");
}

function parseAddresses(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean);
  }
  const raw = String(value ?? "").trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(/[;,]/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function encodeHeaderValue(value: string): string {
  const safe = sanitizeHeaderValue(value);
  if (!safe) {
    return "";
  }
  if (/^[\x20-\x7E]+$/.test(safe)) {
    return safe;
  }
  return `=?UTF-8?B?${Buffer.from(safe, "utf-8").toString("base64")}?=`;
}

function decodeMimeEncodedWords(input: string): string {
  return String(input ?? "").replace(/=\?([^?]+)\?([bBqQ])\?([^?]+)\?=/g, (_match, _charset, mode, encoded) => {
    try {
      if (String(mode).toUpperCase() === "B") {
        return Buffer.from(String(encoded), "base64").toString("utf-8");
      }
      const qp = String(encoded)
        .replace(/_/g, " ")
        .replace(/=([A-Fa-f0-9]{2})/g, (_m, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
      return Buffer.from(qp, "binary").toString("utf-8");
    } catch {
      return String(encoded);
    }
  });
}

function parseRfc822Headers(raw: string): Record<string, string[]> {
  const lines = String(raw ?? "").split(/\r?\n/);
  const unfolded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] = `${unfolded[unfolded.length - 1]} ${line.trim()}`;
      continue;
    }
    unfolded.push(line);
  }

  const headers: Record<string, string[]> = {};
  for (const line of unfolded) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const idx = trimmed.indexOf(":");
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim().toLowerCase();
    const value = decodeMimeEncodedWords(trimmed.slice(idx + 1).trim());
    if (!headers[key]) {
      headers[key] = [];
    }
    headers[key].push(value);
  }
  return headers;
}

function compactText(value: string, maxChars: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function parseReferences(value: string): string[] {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(/\s+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return fallback;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), Math.max(250, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

class BufferedSocket {
  private buffer = Buffer.alloc(0);
  private ended = false;
  private failed: Error | null = null;
  private waiters: Array<() => void> = [];

  constructor(private readonly socket: AnySocket) {
    socket.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, "utf-8");
      this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, buf]) : buf;
      this.signal();
    });
    socket.on("end", () => {
      this.ended = true;
      this.signal();
    });
    socket.on("close", () => {
      this.ended = true;
      this.signal();
    });
    socket.on("error", (error: Error) => {
      this.failed = error;
      this.ended = true;
      this.signal();
    });
  }

  private signal(): void {
    const pending = this.waiters.splice(0);
    for (const resolve of pending) {
      resolve();
    }
  }

  private async waitForData(timeoutMs: number, minBufferLength = 1): Promise<void> {
    if (this.buffer.length >= Math.max(0, Math.floor(minBufferLength)) || this.ended || this.failed) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry !== onReady);
        reject(new Error("Timed out waiting for remote server response."));
      }, Math.max(500, timeoutMs));
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(onReady);
    });
    if (this.failed) {
      throw this.failed;
    }
  }

  writeLine(line: string): void {
    this.socket.write(`${line}\r\n`);
  }

  writeRaw(raw: string | Buffer): void {
    this.socket.write(raw);
  }

  async readLine(timeoutMs: number): Promise<string> {
    while (true) {
      const idx = this.buffer.indexOf("\r\n");
      if (idx >= 0) {
        const line = this.buffer.subarray(0, idx).toString("utf-8");
        this.buffer = this.buffer.subarray(idx + 2);
        return line;
      }
      if (this.failed) {
        throw this.failed;
      }
      if (this.ended) {
        if (this.buffer.length === 0) {
          throw new Error("Connection closed by remote server.");
        }
        const line = this.buffer.toString("utf-8");
        this.buffer = Buffer.alloc(0);
        return line;
      }
      // Wait for at least one additional byte so partial lines do not spin CPU.
      await this.waitForData(timeoutMs, this.buffer.length + 1);
    }
  }

  async readBytes(length: number, timeoutMs: number): Promise<Buffer> {
    const need = Math.max(0, Math.floor(length));
    while (this.buffer.length < need) {
      if (this.failed) {
        throw this.failed;
      }
      if (this.ended) {
        throw new Error("Connection closed before literal data was fully received.");
      }
      await this.waitForData(timeoutMs, need);
    }
    const out = this.buffer.subarray(0, need);
    this.buffer = this.buffer.subarray(need);
    return out;
  }

  consumeOptionalCrlf(): void {
    if (this.buffer.length >= 2 && this.buffer[0] === 13 && this.buffer[1] === 10) {
      this.buffer = this.buffer.subarray(2);
    }
  }

  close(): void {
    this.socket.destroy();
  }
}

async function connectSocket(options: {
  host: string;
  port: number;
  secure: boolean;
  timeoutMs: number;
  rejectUnauthorized: boolean;
}): Promise<AnySocket> {
  return await new Promise<AnySocket>((resolve, reject) => {
    const timeoutMs = Math.max(500, options.timeoutMs);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error(`Timed out connecting to ${options.host}:${options.port}.`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("error", onError);
      socket.off(connectEvent, onConnect);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };

    const socket: AnySocket = options.secure
      ? tls.connect({
          host: options.host,
          port: options.port,
          servername: options.host,
          rejectUnauthorized: options.rejectUnauthorized,
        })
      : net.createConnection({
          host: options.host,
          port: options.port,
        });
    const connectEvent = options.secure ? "secureConnect" : "connect";
    const timer = setTimeout(onTimeout, timeoutMs);

    socket.once("error", onError);
    socket.once(connectEvent, onConnect);
  });
}

class ImapSession {
  private tagCounter = 1;

  private constructor(
    private readonly socket: AnySocket,
    private readonly reader: BufferedSocket,
    private readonly timeoutMs: number,
  ) {}

  static async connect(options: {
    host: string;
    port: number;
    secure: boolean;
    timeoutMs: number;
    rejectUnauthorized: boolean;
  }): Promise<ImapSession> {
    const socket = await connectSocket(options);
    const reader = new BufferedSocket(socket);
    const greeting = await reader.readLine(options.timeoutMs);
    if (!/^\*\s+(OK|PREAUTH)\b/i.test(greeting)) {
      reader.close();
      throw new Error(`Unexpected IMAP greeting from ${options.host}:${options.port}.`);
    }
    return new ImapSession(socket, reader, options.timeoutMs);
  }

  private nextTag(): string {
    const tag = `A${String(this.tagCounter).padStart(4, "0")}`;
    this.tagCounter += 1;
    return tag;
  }

  private async command(command: string): Promise<{
    status: string;
    statusLine: string;
    parts: ImapResponsePart[];
  }> {
    const tag = this.nextTag();
    this.reader.writeLine(`${tag} ${command}`);
    const parts: ImapResponsePart[] = [];
    let status = "";
    let statusLine = "";
    let linesRead = 0;
    let literalBytesRead = 0;

    while (true) {
      linesRead += 1;
      if (linesRead > MAX_IMAP_COMMAND_LINES) {
        throw new Error(`IMAP ${command} response exceeded ${MAX_IMAP_COMMAND_LINES} lines.`);
      }
      const line = await this.reader.readLine(this.timeoutMs);
      parts.push({ kind: "line", line });

      const literalMatch = line.match(/\{(\d+)\}$/);
      if (literalMatch) {
        const literalLength = clampInt(literalMatch[1], 0, 50_000_000, 0);
        literalBytesRead += literalLength;
        if (literalBytesRead > MAX_IMAP_LITERAL_BYTES) {
          throw new Error(
            `IMAP ${command} response exceeded ${MAX_IMAP_LITERAL_BYTES} literal bytes.`,
          );
        }
        const literal = await this.reader.readBytes(literalLength, this.timeoutMs);
        parts.push({
          kind: "literal",
          line,
          data: literal,
        });
        this.reader.consumeOptionalCrlf();
      }

      if (line.startsWith(`${tag} `)) {
        statusLine = line;
        const parsed = line.slice(tag.length + 1).trim().split(/\s+/g)[0] ?? "";
        status = parsed.toUpperCase();
        break;
      }
    }

    return { status, statusLine, parts };
  }

  private assertOk(response: { status: string; statusLine: string }, context: string): void {
    if (response.status !== "OK") {
      throw new Error(`IMAP ${context} failed: ${response.statusLine}`);
    }
  }

  async login(identifier: string, secret: string): Promise<void> {
    const response = await this.command(`LOGIN ${quoteImapString(identifier)} ${quoteImapString(secret)}`);
    this.assertOk(response, "LOGIN");
  }

  async select(mailbox: string): Promise<void> {
    const response = await this.command(`SELECT ${quoteImapString(mailbox)}`);
    this.assertOk(response, "SELECT");
  }

  async search(criteria: string): Promise<number[]> {
    const response = await this.command(`SEARCH ${criteria}`);
    this.assertOk(response, "SEARCH");
    const ids = new Set<number>();
    for (const part of response.parts) {
      if (part.kind !== "line") {
        continue;
      }
      const match = part.line.match(/^\*\s+SEARCH\s*(.*)$/i);
      if (!match) {
        continue;
      }
      const nums = match[1]
        .split(/\s+/g)
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry > 0);
      for (const n of nums) {
        ids.add(n);
      }
    }
    return Array.from(ids).sort((a, b) => a - b);
  }

  async fetchHeaders(seqSet: string): Promise<ParsedMessage[]> {
    const response = await this.command(
      `FETCH ${seqSet} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO DATE MESSAGE-ID IN-REPLY-TO REFERENCES)])`,
    );
    this.assertOk(response, "FETCH headers");
    return parseFetchedMessages(response.parts);
  }

  async fetchBodies(seqSet: string, bodyChars: number): Promise<ParsedMessage[]> {
    const response = await this.command(`FETCH ${seqSet} (BODY.PEEK[TEXT]<0.${bodyChars}>)`);
    this.assertOk(response, "FETCH body");
    return parseFetchedMessages(response.parts);
  }

  async markSeen(seqSet: string): Promise<void> {
    const response = await this.command(`STORE ${seqSet} +FLAGS (\\Seen)`);
    this.assertOk(response, "STORE");
  }

  async logout(): Promise<void> {
    try {
      await withTimeout(
        this.command("LOGOUT"),
        Math.min(this.timeoutMs, LOGOUT_GRACE_TIMEOUT_MS),
        "IMAP LOGOUT timed out.",
      );
    } finally {
      this.reader.close();
    }
  }
}

function quoteImapString(value: string): string {
  const escaped = String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

class SmtpSession {
  private constructor(
    private socket: AnySocket,
    private reader: BufferedSocket,
    private readonly timeoutMs: number,
    private readonly host: string,
    private readonly rejectUnauthorized: boolean,
  ) {}

  static async connect(options: {
    host: string;
    port: number;
    secure: boolean;
    startTls: boolean;
    timeoutMs: number;
    rejectUnauthorized: boolean;
  }): Promise<SmtpSession> {
    const socket = await connectSocket({
      host: options.host,
      port: options.port,
      secure: options.secure,
      timeoutMs: options.timeoutMs,
      rejectUnauthorized: options.rejectUnauthorized,
    });
    const reader = new BufferedSocket(socket);
    const session = new SmtpSession(socket, reader, options.timeoutMs, options.host, options.rejectUnauthorized);

    const greeting = await session.readResponse();
    if (greeting.code !== 220) {
      session.close();
      throw new Error(`SMTP greeting failed (${greeting.code}).`);
    }

    await session.command(`EHLO localhost`, [250]);
    if (!options.secure && options.startTls) {
      await session.command("STARTTLS", [220]);
      await session.upgradeToTls();
      await session.command(`EHLO localhost`, [250]);
    }
    return session;
  }

  private async upgradeToTls(): Promise<void> {
    const upgraded = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const secureSocket = tls.connect({
        socket: this.socket,
        servername: this.host,
        rejectUnauthorized: this.rejectUnauthorized,
      });
      const timer = setTimeout(() => {
        secureSocket.destroy();
        reject(new Error("SMTP STARTTLS upgrade timed out."));
      }, Math.max(500, this.timeoutMs));
      secureSocket.once("secureConnect", () => {
        clearTimeout(timer);
        resolve(secureSocket);
      });
      secureSocket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    this.socket = upgraded;
    this.reader = new BufferedSocket(upgraded);
  }

  private async readResponse(): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    let code = 0;
    let linesRead = 0;
    while (true) {
      linesRead += 1;
      if (linesRead > MAX_SMTP_RESPONSE_LINES) {
        throw new Error(`SMTP response exceeded ${MAX_SMTP_RESPONSE_LINES} lines.`);
      }
      const line = await this.reader.readLine(this.timeoutMs);
      lines.push(line);
      const match = line.match(/^(\d{3})([\s-])(.*)$/);
      if (!match) {
        continue;
      }
      code = Number(match[1]);
      if (match[2] === " ") {
        break;
      }
    }
    return { code, lines };
  }

  private async command(command: string, expectedCodes: number[]): Promise<{ code: number; lines: string[] }> {
    this.reader.writeLine(command);
    const response = await this.readResponse();
    if (!expectedCodes.includes(response.code)) {
      throw new Error(`SMTP command failed (${response.code}): ${response.lines.join(" | ")}`);
    }
    return response;
  }

  async authenticateLogin(identifier: string, secret: string): Promise<void> {
    await this.command("AUTH LOGIN", [334]);
    await this.command(Buffer.from(identifier, "utf-8").toString("base64"), [334]);
    await this.command(Buffer.from(secret, "utf-8").toString("base64"), [235]);
  }

  async sendMail(params: {
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    text: string;
    html: string;
    inReplyTo: string;
    references: string[];
  }): Promise<{ messageId: string; accepted: string[] }> {
    const recipients = [...params.to, ...params.cc, ...params.bcc];
    if (recipients.length === 0) {
      throw new Error("At least one recipient is required.");
    }

    await this.command(`MAIL FROM:<${params.from}>`, [250]);
    for (const recipient of recipients) {
      await this.command(`RCPT TO:<${recipient}>`, [250, 251]);
    }
    await this.command("DATA", [354]);

    const messageId = `<${randomUUID()}@${parseDomainFromEmailAddress(params.from) || "t560.local"}>`;
    const data = buildMimeMessage({
      from: params.from,
      to: params.to,
      cc: params.cc,
      subject: params.subject,
      text: params.text,
      html: params.html,
      inReplyTo: params.inReplyTo,
      references: params.references,
      messageId,
    });
    this.reader.writeRaw(`${dotStuffSmtpBody(data)}\r\n.\r\n`);
    const response = await this.readResponse();
    if (response.code !== 250) {
      throw new Error(`SMTP DATA failed (${response.code}): ${response.lines.join(" | ")}`);
    }
    return {
      messageId,
      accepted: recipients,
    };
  }

  async quit(): Promise<void> {
    try {
      await this.command("QUIT", [221, 250]);
    } finally {
      this.close();
    }
  }

  close(): void {
    this.reader.close();
  }
}

function dotStuffSmtpBody(body: string): string {
  return String(body ?? "")
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

function buildMimeMessage(params: {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html: string;
  inReplyTo: string;
  references: string[];
  messageId: string;
}): string {
  const headers: string[] = [
    `Date: ${new Date().toUTCString()}`,
    `From: ${sanitizeHeaderValue(params.from)}`,
    `To: ${params.to.map((entry) => sanitizeHeaderValue(entry)).join(", ")}`,
    `Subject: ${encodeHeaderValue(params.subject || "(no subject)")}`,
    `Message-ID: ${sanitizeHeaderValue(params.messageId)}`,
    "MIME-Version: 1.0",
  ];
  if (params.cc.length > 0) {
    headers.push(`Cc: ${params.cc.map((entry) => sanitizeHeaderValue(entry)).join(", ")}`);
  }
  if (params.inReplyTo.trim()) {
    headers.push(`In-Reply-To: ${sanitizeHeaderValue(params.inReplyTo)}`);
  }
  if (params.references.length > 0) {
    headers.push(`References: ${params.references.map((entry) => sanitizeHeaderValue(entry)).join(" ")}`);
  }

  const textBody = String(params.text ?? "").replace(/\r?\n/g, "\r\n");
  const htmlBody = String(params.html ?? "").replace(/\r?\n/g, "\r\n");
  if (htmlBody && textBody) {
    const boundary = `t560-${randomUUID()}`;
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      textBody || "(no content)",
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      htmlBody,
      "",
      `--${boundary}--`,
      "",
    ].join("\r\n");
  }

  if (htmlBody) {
    return [
      ...headers,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      htmlBody,
      "",
    ].join("\r\n");
  }

  return [
    ...headers,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    textBody || "(no content)",
    "",
  ].join("\r\n");
}

function extractFetchSequence(line: string): number | null {
  const match = String(line ?? "").match(/^\*\s+(\d+)\s+FETCH\b/i);
  if (!match) {
    return null;
  }
  const seq = Number(match[1]);
  return Number.isInteger(seq) && seq > 0 ? seq : null;
}

function parseFlags(raw: string): string[] {
  const value = String(raw ?? "").trim();
  if (!value) {
    return [];
  }
  return value
    .split(/\s+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function ensureParsedMessage(map: Map<number, ParsedMessage>, sequence: number): ParsedMessage {
  const existing = map.get(sequence);
  if (existing) {
    return existing;
  }
  const created: ParsedMessage = {
    sequence,
    uid: null,
    flags: [],
    internalDate: "",
    size: 0,
    headersRaw: "",
    bodyRaw: "",
  };
  map.set(sequence, created);
  return created;
}

function parseFetchedMessages(parts: ImapResponsePart[]): ParsedMessage[] {
  const rows = new Map<number, ParsedMessage>();
  for (const part of parts) {
    const line = part.line;
    const sequence = extractFetchSequence(line);
    if (sequence === null) {
      continue;
    }
    const target = ensureParsedMessage(rows, sequence);
    const uidMatch = line.match(/\bUID\s+(\d+)\b/i);
    if (uidMatch) {
      const uid = Number(uidMatch[1]);
      if (Number.isInteger(uid) && uid > 0) {
        target.uid = uid;
      }
    }
    const sizeMatch = line.match(/\bRFC822\.SIZE\s+(\d+)\b/i);
    if (sizeMatch) {
      const size = Number(sizeMatch[1]);
      if (Number.isInteger(size) && size >= 0) {
        target.size = size;
      }
    }
    const dateMatch = line.match(/\bINTERNALDATE\s+"([^"]+)"/i);
    if (dateMatch) {
      target.internalDate = dateMatch[1] ?? "";
    }
    const flagsMatch = line.match(/\bFLAGS\s+\(([^)]*)\)/i);
    if (flagsMatch) {
      target.flags = parseFlags(flagsMatch[1]);
    }
    if (part.kind === "literal") {
      if (/BODY\[HEADER/i.test(line)) {
        target.headersRaw = part.data.toString("utf-8");
      } else if (/BODY\[(TEXT|\])/i.test(line) || /\bRFC822\b/i.test(line)) {
        target.bodyRaw = part.data.toString("utf-8");
      }
    }
  }
  return Array.from(rows.values()).sort((a, b) => b.sequence - a.sequence);
}

function messageThreadKey(headers: Record<string, string[]>): string {
  const inReplyTo = headers["in-reply-to"]?.[0] ?? "";
  if (inReplyTo.trim()) {
    return inReplyTo.trim();
  }
  const refs = parseReferences(headers.references?.[0] ?? "");
  if (refs.length > 0) {
    return refs[refs.length - 1] ?? refs[0] ?? "";
  }
  return headers["message-id"]?.[0] ?? "";
}

function isAuthErrorMessage(message: string): boolean {
  const text = String(message ?? "").toLowerCase();
  return (
    text.includes("auth") ||
    text.includes("authentication") ||
    text.includes("invalid credentials") ||
    text.includes("login failed") ||
    text.includes("535")
  );
}

function mapAction(value: unknown): EmailAction {
  const normalized = String(value ?? "status").trim().toLowerCase();
  if (
    normalized === "list_unread" ||
    normalized === "unread" ||
    normalized === "inbox" ||
    normalized === "list"
  ) {
    return "list_unread";
  }
  if (normalized === "read_unread" || normalized === "read") {
    return "read_unread";
  }
  if (normalized === "read_recent" || normalized === "recent") {
    return "read_recent";
  }
  if (normalized === "send" || normalized === "send_email" || normalized === "compose") {
    return "send";
  }
  return "status";
}

function resolveProviderConfig(params: {
  service: string;
  credential: CredentialRecord;
  overrides: Record<string, unknown>;
}): ResolvedProviderConfig {
  const service = normalizeHost(params.service);
  const websiteHost = normalizeHost(params.credential.websiteUrl ?? "");
  const emailDomain = parseDomainFromEmailAddress(params.credential.identifier);
  const hint = `${service} ${websiteHost} ${emailDomain}`.toLowerCase();

  const readPort = (value: unknown, fallback: number) => clampInt(value, 1, 65535, fallback);
  const readSecure = (value: unknown, fallback: boolean) => toBoolean(value, fallback);

  const overrideImapHost = normalizeHost(params.overrides.imapHost);
  const overrideSmtpHost = normalizeHost(params.overrides.smtpHost);

  const buildCustom = (domainHint: string): ResolvedProviderConfig => {
    const domain = normalizeHost(domainHint);
    const imapHost = overrideImapHost || (domain ? `imap.${domain}` : "");
    const smtpHost = overrideSmtpHost || (domain ? `smtp.${domain}` : "");
    if (!imapHost || !smtpHost) {
      return {
        providerId: "custom",
        label: "Custom",
        loginUrl: params.credential.websiteUrl || "",
        protocolSupported: false,
        notes: [
          "Cannot infer IMAP/SMTP hosts for this mailbox. Provide imapHost and smtpHost in the tool call, or configure a supported provider.",
        ],
        imap: null,
        smtp: null,
      };
    }
    return {
      providerId: "custom",
      label: "Custom",
      loginUrl: params.credential.websiteUrl || "",
      protocolSupported: true,
      notes: [],
      imap: {
        host: imapHost,
        port: readPort(params.overrides.imapPort, 993),
        secure: readSecure(params.overrides.imapSecure, true),
        startTls: false,
      },
      smtp: {
        host: smtpHost,
        port: readPort(params.overrides.smtpPort, 465),
        secure: readSecure(params.overrides.smtpSecure, true),
        startTls: toBoolean(params.overrides.smtpStartTls, false),
      },
    };
  };

  if (hint.includes("gmail") || hint.includes("googlemail") || service === "mail.google.com") {
    return {
      providerId: "gmail",
      label: "Gmail",
      loginUrl: "https://mail.google.com",
      protocolSupported: true,
      notes: [],
      imap: {
        host: overrideImapHost || "imap.gmail.com",
        port: readPort(params.overrides.imapPort, 993),
        secure: readSecure(params.overrides.imapSecure, true),
        startTls: false,
      },
      smtp: {
        host: overrideSmtpHost || "smtp.gmail.com",
        port: readPort(params.overrides.smtpPort, 465),
        secure: readSecure(params.overrides.smtpSecure, true),
        startTls: toBoolean(params.overrides.smtpStartTls, false),
      },
    };
  }

  if (
    hint.includes("outlook") ||
    hint.includes("hotmail") ||
    hint.includes("live.com") ||
    hint.includes("office365") ||
    service === "outlook.live.com" ||
    service === "outlook.office.com"
  ) {
    return {
      providerId: "outlook",
      label: "Outlook/Microsoft",
      loginUrl: "https://outlook.live.com",
      protocolSupported: true,
      notes: [],
      imap: {
        host: overrideImapHost || "imap-mail.outlook.com",
        port: readPort(params.overrides.imapPort, 993),
        secure: readSecure(params.overrides.imapSecure, true),
        startTls: false,
      },
      smtp: {
        host: overrideSmtpHost || "smtp-mail.outlook.com",
        port: readPort(params.overrides.smtpPort, 587),
        secure: readSecure(params.overrides.smtpSecure, false),
        startTls: toBoolean(params.overrides.smtpStartTls, true),
      },
    };
  }

  if (hint.includes("yahoo") || service === "mail.yahoo.com") {
    return {
      providerId: "yahoo",
      label: "Yahoo Mail",
      loginUrl: "https://mail.yahoo.com",
      protocolSupported: true,
      notes: [],
      imap: {
        host: overrideImapHost || "imap.mail.yahoo.com",
        port: readPort(params.overrides.imapPort, 993),
        secure: readSecure(params.overrides.imapSecure, true),
        startTls: false,
      },
      smtp: {
        host: overrideSmtpHost || "smtp.mail.yahoo.com",
        port: readPort(params.overrides.smtpPort, 465),
        secure: readSecure(params.overrides.smtpSecure, true),
        startTls: toBoolean(params.overrides.smtpStartTls, false),
      },
    };
  }

  if (hint.includes("icloud") || hint.includes("me.com") || hint.includes("mac.com")) {
    return {
      providerId: "icloud",
      label: "iCloud Mail",
      loginUrl: "https://www.icloud.com/mail",
      protocolSupported: true,
      notes: [],
      imap: {
        host: overrideImapHost || "imap.mail.me.com",
        port: readPort(params.overrides.imapPort, 993),
        secure: readSecure(params.overrides.imapSecure, true),
        startTls: false,
      },
      smtp: {
        host: overrideSmtpHost || "smtp.mail.me.com",
        port: readPort(params.overrides.smtpPort, 587),
        secure: readSecure(params.overrides.smtpSecure, false),
        startTls: toBoolean(params.overrides.smtpStartTls, true),
      },
    };
  }

  if (hint.includes("proton")) {
    const hasOverrides = overrideImapHost.length > 0 && overrideSmtpHost.length > 0;
    if (hasOverrides) {
      return buildCustom(overrideImapHost);
    }
    return {
      providerId: "proton",
      label: "Proton Mail",
      loginUrl: "https://mail.proton.me",
      protocolSupported: false,
      notes: [
        "Direct IMAP/SMTP access requires Proton Bridge. Configure bridge host/ports via imapHost/smtpHost overrides, or use browser login.",
      ],
      imap: null,
      smtp: null,
    };
  }

  return buildCustom(websiteHost || emailDomain || service);
}

async function resolveMailboxCredential(options: {
  workspaceDir: string;
  serviceRaw: unknown;
}): Promise<{ service: string; credential: CredentialRecord }> {
  const explicitService = normalizeSetupService(String(options.serviceRaw ?? ""));
  if (explicitService) {
    const credential = await getCredential({
      workspaceDir: options.workspaceDir,
      service: explicitService,
    });
    if (credential) {
      return { service: explicitService, credential };
    }
  }

  const services = await listConfiguredServices(options.workspaceDir);
  const candidateServices = new Set<string>();
  for (const seed of ["mail.google.com", "outlook.live.com", "mail.yahoo.com", "mail.proton.me", "icloud.com", "email"]) {
    const normalized = normalizeSetupService(seed);
    if (normalized) {
      candidateServices.add(normalized);
    }
  }
  for (const service of services) {
    candidateServices.add(service);
  }

  for (const candidate of candidateServices) {
    const credential = await getCredential({
      workspaceDir: options.workspaceDir,
      service: candidate,
    });
    if (!credential) {
      continue;
    }
    if (credential.identifier.includes("@")) {
      return { service: candidate, credential };
    }
  }

  throw new Error("No mailbox credential found in vault. Add one in Setup -> Vault (type: Email inbox).");
}

function buildBrowserFallback(params: {
  action: EmailAction;
  service: string;
  credential: CredentialRecord;
  provider: ResolvedProviderConfig;
  reason: string;
}): Record<string, unknown> {
  const loginUrl = params.credential.websiteUrl || params.provider.loginUrl || "";
  return {
    ok: false,
    action: params.action,
    requiresBrowserLogin: true,
    reason: params.reason,
    service: params.service,
    identifier: maskIdentifier(params.credential.identifier),
    loginUrl,
    nextStep:
      "Open the mailbox login page in browser (engine=live), then run browser action=login with this service. If prompted for MFA, run browser action=mfa with the code.",
  };
}

function shapeMessages(messages: ParsedMessage[], includeBody: boolean, maxSnippet: number): Array<Record<string, unknown>> {
  return messages.map((entry) => {
    const headers = parseRfc822Headers(entry.headersRaw);
    const subject = headers.subject?.[0] ?? "(no subject)";
    const from = headers.from?.[0] ?? "";
    const to = headers.to?.[0] ?? "";
    const date = headers.date?.[0] ?? entry.internalDate ?? "";
    const messageId = headers["message-id"]?.[0] ?? "";
    const inReplyTo = headers["in-reply-to"]?.[0] ?? "";
    const references = parseReferences(headers.references?.[0] ?? "");
    const bodySnippet = includeBody ? compactText(entry.bodyRaw, maxSnippet) : "";
    return {
      sequence: entry.sequence,
      uid: entry.uid,
      flags: entry.flags,
      size: entry.size,
      date,
      from,
      to,
      subject,
      messageId,
      inReplyTo,
      references,
      threadKey: messageThreadKey(headers),
      snippet: bodySnippet,
    };
  });
}

export function createEmailTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = path.resolve(options?.workspaceDir ?? process.cwd());
  return {
    name: "email",
    description:
      "Mailbox tool that uses secure vault credentials for inbox access and sending messages. Supports unread/recent reads via IMAP + sends via SMTP when app-password style credentials are configured; falls back to browser-login instructions for password+MFA flows.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description: "status|list_unread|read_unread|read_recent|send",
        }),
      ),
      service: Type.Optional(
        Type.String({ description: "Vault service key for the mailbox (example: mail.google.com)." }),
      ),
      mailbox: Type.Optional(Type.String({ description: "Mailbox name for IMAP reads (default INBOX)." })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_LIST_LIMIT })),
      includeBody: Type.Optional(Type.Boolean({ description: "Include message body snippets in read/list output." })),
      bodyMaxChars: Type.Optional(Type.Number({ minimum: 200, maximum: MAX_BODY_PREVIEW_CHARS })),
      markSeen: Type.Optional(Type.Boolean({ description: "Mark fetched messages as seen after reading." })),
      forceProtocolLogin: Type.Optional(
        Type.Boolean({
          description:
            "Try direct IMAP/SMTP even when credential auth mode is password_with_mfa (normally browser login is preferred).",
        }),
      ),
      to: Type.Optional(Type.Array(Type.String(), { description: "Recipient emails for action=send." })),
      cc: Type.Optional(Type.Array(Type.String(), { description: "CC recipient emails for action=send." })),
      bcc: Type.Optional(Type.Array(Type.String(), { description: "BCC recipient emails for action=send." })),
      subject: Type.Optional(Type.String({ description: "Subject for action=send." })),
      text: Type.Optional(Type.String({ description: "Plain text body for action=send." })),
      html: Type.Optional(Type.String({ description: "HTML body for action=send." })),
      inReplyTo: Type.Optional(Type.String({ description: "Message-ID for thread replies (optional)." })),
      references: Type.Optional(Type.Array(Type.String(), { description: "Message-ID chain for thread replies." })),
      from: Type.Optional(Type.String({ description: "Optional From override; defaults to vault identifier." })),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 120000 })),
      imapHost: Type.Optional(Type.String({ description: "Override IMAP host." })),
      imapPort: Type.Optional(Type.Number({ minimum: 1, maximum: 65535 })),
      imapSecure: Type.Optional(Type.Boolean({ description: "Use TLS for IMAP (default true)." })),
      smtpHost: Type.Optional(Type.String({ description: "Override SMTP host." })),
      smtpPort: Type.Optional(Type.Number({ minimum: 1, maximum: 65535 })),
      smtpSecure: Type.Optional(
        Type.Boolean({ description: "Use implicit TLS for SMTP (default true for most providers)." }),
      ),
      smtpStartTls: Type.Optional(Type.Boolean({ description: "Use STARTTLS upgrade for SMTP (default provider-specific)." })),
      tlsRejectUnauthorized: Type.Optional(
        Type.Boolean({
          description: "Reject invalid TLS certs (default true). Set false only for local/testing mail servers.",
        }),
      ),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams ?? {};
      const action = mapAction(params.action);
      const timeoutMs = clampInt(params.timeoutMs, 1000, 120000, DEFAULT_TIMEOUT_MS);
      const rejectUnauthorized = toBoolean(params.tlsRejectUnauthorized, true);
      const limit = clampInt(params.limit, 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
      const bodyMaxChars = clampInt(
        params.bodyMaxChars,
        200,
        MAX_BODY_PREVIEW_CHARS,
        DEFAULT_IMAP_BODY_PREVIEW_CHARS,
      );

      const { service, credential } = await resolveMailboxCredential({
        workspaceDir,
        serviceRaw: params.service,
      });
      const provider = resolveProviderConfig({
        service,
        credential,
        overrides: params,
      });
      const forceProtocolLogin = toBoolean(params.forceProtocolLogin, false);

      const credentialAuthMode = credential.authMode;
      const protocolAllowed = credentialAuthMode === "password" || forceProtocolLogin;

      if (action === "status") {
        return {
          ok: true,
          action,
          service,
          identifier: maskIdentifier(credential.identifier),
          authMode: credentialAuthMode,
          provider: provider.providerId,
          providerLabel: provider.label,
          protocolSupported: provider.protocolSupported,
          protocolAllowed,
          loginUrl: credential.websiteUrl || provider.loginUrl || "",
          notes: provider.notes,
          imap: provider.imap
            ? {
                host: provider.imap.host,
                port: provider.imap.port,
                secure: provider.imap.secure,
              }
            : null,
          smtp: provider.smtp
            ? {
                host: provider.smtp.host,
                port: provider.smtp.port,
                secure: provider.smtp.secure,
                startTls: provider.smtp.startTls,
              }
            : null,
          requiresBrowserLogin: !protocolAllowed || !provider.protocolSupported,
        };
      }

      if (!provider.protocolSupported) {
        return buildBrowserFallback({
          action,
          service,
          credential,
          provider,
          reason: provider.notes[0] || "Direct mail protocol access is not configured for this provider.",
        });
      }

      if (!protocolAllowed) {
        return buildBrowserFallback({
          action,
          service,
          credential,
          provider,
          reason:
            "Vault credential is configured as password_with_mfa. Use browser login flow so MFA can be completed interactively.",
        });
      }

      if (action === "list_unread" || action === "read_unread" || action === "read_recent") {
        if (!provider.imap) {
          return buildBrowserFallback({
            action,
            service,
            credential,
            provider,
            reason: "IMAP settings are not configured for this mailbox.",
          });
        }
        const mailbox = String(params.mailbox ?? "INBOX").trim() || "INBOX";
        const includeBody = toBoolean(params.includeBody, action !== "list_unread");
        const markSeen = toBoolean(params.markSeen, false);
        const imap = await ImapSession.connect({
          host: provider.imap.host,
          port: provider.imap.port,
          secure: provider.imap.secure,
          timeoutMs,
          rejectUnauthorized,
        });
        try {
          await imap.login(credential.identifier, credential.secret);
          await imap.select(mailbox);
          const criteria = action === "read_recent" ? "ALL" : "UNSEEN";
          const ids = await imap.search(criteria);
          if (ids.length === 0) {
            return {
              ok: true,
              action,
              service,
              mailbox,
              provider: provider.providerId,
              count: 0,
              messages: [],
            };
          }

          const selectedIds = ids.slice(Math.max(0, ids.length - limit));
          const seqSet = selectedIds.join(",");

          const headerRows = await imap.fetchHeaders(seqSet);
          const merged = new Map<number, ParsedMessage>();
          for (const row of headerRows) {
            merged.set(row.sequence, row);
          }
          if (includeBody) {
            const bodyRows = await imap.fetchBodies(seqSet, bodyMaxChars);
            for (const row of bodyRows) {
              const existing = merged.get(row.sequence);
              if (existing) {
                existing.bodyRaw = row.bodyRaw || existing.bodyRaw;
              } else {
                merged.set(row.sequence, row);
              }
            }
          }
          if (markSeen) {
            await imap.markSeen(seqSet);
          }

          const rows = Array.from(merged.values()).sort((a, b) => b.sequence - a.sequence);
          return {
            ok: true,
            action,
            service,
            mailbox,
            provider: provider.providerId,
            count: rows.length,
            markSeen,
            messages: shapeMessages(rows, includeBody, bodyMaxChars),
          };
        } catch (error: unknown) {
          const message = toErrorMessage(error);
          if (!forceProtocolLogin && isAuthErrorMessage(message)) {
            return buildBrowserFallback({
              action,
              service,
              credential,
              provider,
              reason:
                "Mailbox auth failed using direct protocol login. If this account requires interactive sign-in/MFA, use browser login flow.",
            });
          }
          throw new Error(`Email inbox access failed for ${service}: ${message}`);
        } finally {
          await imap.logout().catch(() => undefined);
        }
      }

      if (action === "send") {
        if (!provider.smtp) {
          return buildBrowserFallback({
            action,
            service,
            credential,
            provider,
            reason: "SMTP settings are not configured for this mailbox.",
          });
        }
        const to = parseAddresses(params.to);
        const cc = parseAddresses(params.cc);
        const bcc = parseAddresses(params.bcc);
        const recipients = [...to, ...cc, ...bcc];
        if (recipients.length === 0) {
          throw new Error("Send requires at least one recipient in to/cc/bcc.");
        }
        const from = String(params.from ?? credential.identifier).trim();
        if (!from || !from.includes("@")) {
          throw new Error("A valid from email address is required.");
        }
        const subject = String(params.subject ?? "").trim() || "(no subject)";
        const text = String(params.text ?? "").trim();
        const html = String(params.html ?? "").trim();
        if (!text && !html) {
          throw new Error("Send requires text and/or html content.");
        }
        const inReplyTo = String(params.inReplyTo ?? "").trim();
        const references = Array.isArray(params.references)
          ? params.references.map((entry) => String(entry ?? "").trim()).filter(Boolean)
          : parseReferences(String(params.references ?? ""));

        const smtp = await SmtpSession.connect({
          host: provider.smtp.host,
          port: provider.smtp.port,
          secure: provider.smtp.secure,
          startTls: provider.smtp.startTls,
          timeoutMs,
          rejectUnauthorized,
        });
        try {
          await smtp.authenticateLogin(credential.identifier, credential.secret);
          const sent = await smtp.sendMail({
            from,
            to,
            cc,
            bcc,
            subject,
            text,
            html,
            inReplyTo,
            references,
          });
          return {
            ok: true,
            action,
            service,
            provider: provider.providerId,
            from,
            to,
            cc,
            bcc,
            subject,
            acceptedCount: sent.accepted.length,
            accepted: sent.accepted,
            messageId: sent.messageId,
          };
        } catch (error: unknown) {
          const message = toErrorMessage(error);
          if (!forceProtocolLogin && isAuthErrorMessage(message)) {
            return buildBrowserFallback({
              action,
              service,
              credential,
              provider,
              reason:
                "SMTP auth failed using direct protocol login. If this account requires interactive sign-in/MFA, use browser login flow.",
            });
          }
          throw new Error(`Email send failed for ${service}: ${message}`);
        } finally {
          await smtp.quit().catch(() => smtp.close());
        }
      }

      throw new Error(`Unsupported email action: ${action}`);
    },
  };
}
