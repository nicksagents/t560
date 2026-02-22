# t560 (Mini Foundation)

Minimal, upgradeable local agent with a shared gateway for:

- Terminal chat
- Local + Tailscale webchat dashboard
- Telegram bot bridge

It starts in foundation mode immediately. Provider mode is enabled by onboarding.

## Prerequisites

- Node.js 20+
- npm
- bash shell (Linux/macOS)
- Tailscale CLI installed and connected (`tailscale up`)

Check:

```bash
node -v
npm -v
tailscale version
tailscale ip -4
```

## Install

From project root:

```bash
cd /home/agent_t490/Desktop/t560
chmod +x install.sh
./install.sh
```

`install.sh` does:

1. `npm install`
2. `npm run build`
3. `npm link` (global `t560` command)
4. starts `t560 gateway`

If shell still sees old path:

```bash
hash -r
which -a t560
```

## Core commands

```bash
t560 start
t560 gateway      # alias of start
t560 onboard      # interactive onboarding wizard
t560 pairing list
t560 pairing approve telegram <code>
t560 help
```

## Runtime behavior

Start runtime:

```bash
t560 start
```

If required setup is missing, `t560` will show what is missing and prompt to start onboarding immediately.
If required setup remains incomplete, startup is blocked.

If Telegram is configured, startup also validates the bot token (`getMe` check) and blocks on invalid tokens.

What starts:

1. Banner + runtime loop
2. Dashboard on all interfaces (default bind `0.0.0.0:5600`)
3. Dashboard access URLs printed for:
   1. local (`http://127.0.0.1:<port>`)
   2. tailscale (`http://<tailscale-ip>:<port>`)
4. Terminal live chat prompt (`t560>`) when running in TTY
5. Telegram bridge if bot token exists

Webchat + Telegram + terminal all use the same gateway message handler.
Heartbeat-style messages (`heartbeat`, `ping`, `healthcheck`) are ignored to keep chat clean.

## Onboarding (providers + routing + telegram)

Run:

```bash
t560 onboard
```

Wizard configures:

1. Providers/auth (OpenAI, OpenAI Codex OAuth token, Anthropic token/API key, DeepSeek, OpenRouter, LiteLLM, Google, xAI, Moonshot, MiniMax, Z.AI, Qwen, etc.)
2. Routed model slots:
   1. `default`
   2. `planning`
   3. `coding`
3. Telegram channel setup:
   1. bot token
   2. DM policy: `pairing`, `allowlist`, `open`, `disabled`
   3. optional (can be skipped and configured later)
4. Persona files:
   1. `~/.t560/users.md` (who the human is)
   2. `~/.t560/soul.md` (who t560 is, including personality traits)

The onboarding UI now uses the same Clack-style interactive terminal flow as OpenClaw (selects, confirms, note panels), with T560 branding + banner.

OpenAI Codex provider now supports browser OAuth redirect during onboarding (OpenAI sign-in page opens, then credentials are captured and saved).

For compatibility, onboarding also writes `~/.t560/user.md` with the same contents as `users.md`.

Config file written to:

```text
~/.t560/config.json
```

## Telegram pairing flow

If `dmPolicy=pairing` and a new user messages the bot:

1. Bot replies with a pairing code
2. Owner approves from terminal:

```bash
t560 pairing approve telegram <code>
```

Inspect pairing state:

```bash
t560 pairing list
```

## API endpoints

```bash
curl http://127.0.0.1:5600/health
curl http://127.0.0.1:5600/api/status
curl -X POST http://127.0.0.1:5600/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"hello"}'
```

## Environment variables

```bash
T560_WEB_PORT=5610 t560 start
T560_WEB_HOST=0.0.0.0 t560 start
T560_TELEGRAM_BOT_TOKEN="<token>" t560 start
```

`T560_TELEGRAM_BOT_TOKEN` overrides config token.

## Notes

- Current provider mode is routing/auth-complete with provider stubs in chat response.
- Next implementation phase is live provider inference execution per route slot.
