// @ts-nocheck
import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import fs from "node:fs";
import { formatCliCommand } from "../cli/command-format.js";
import { CONFIG_PATH } from "../config/config.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { defaultRuntime } from "../runtime.js";
import { note } from "../terminal/note.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";
import { maybeRemoveDeprecatedCliAuthProfiles, maybeRepairAnthropicOAuthProfileId, noteAuthProfileHealth, } from "./doctor-auth.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import { noteSourceInstallIssues } from "./doctor-install.js";
import { noteDeprecatedLegacyEnvVars, } from "./doctor-platform-notes.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import { detectLegacyStateMigrations, } from "./doctor-state-migrations.js";
import { maybeRepairUiProtocolFreshness } from "./doctor-ui.js";
import { maybeOfferUpdateBeforeDoctor } from "./doctor-update.js";
import { printWizardHeader, randomToken } from "./onboard-helpers.js";
const intro = (message) => clackIntro(stylePromptTitle(message) ?? message);
const outro = (message) => clackOutro(stylePromptTitle(message) ?? message);
function resolveMode(cfg) {
    return cfg.gateway?.mode === "remote" ? "remote" : "local";
}
export async function doctorCommand(runtime = defaultRuntime, options = {}) {
    const prompter = createDoctorPrompter({ runtime, options });
    printWizardHeader(runtime);
    intro("OpenClaw doctor");
    const root = await resolveOpenClawPackageRoot({
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
        cwd: process.cwd(),
    });
    const updateResult = await maybeOfferUpdateBeforeDoctor({
        runtime,
        options,
        root,
        confirm: (p) => prompter.confirm(p),
        outro,
    });
    if (updateResult.handled) {
        return;
    }
    await maybeRepairUiProtocolFreshness(runtime, prompter);
    noteSourceInstallIssues(root);
    noteDeprecatedLegacyEnvVars();
    const configResult = await loadAndMaybeMigrateDoctorConfig({
        options,
        confirm: (p) => prompter.confirm(p),
    });
    let cfg = configResult.cfg;
    const configPath = configResult.path ?? CONFIG_PATH;
    if (!cfg.gateway?.mode) {
        const lines = [
            "gateway.mode is unset; gateway start will be blocked.",
            `Fix: run ${formatCliCommand("openclaw configure")} and set Gateway mode (local/remote).`,
            `Or set directly: ${formatCliCommand("openclaw config set gateway.mode local")}`,
        ];
        if (!fs.existsSync(configPath)) {
            lines.push(`Missing config: run ${formatCliCommand("openclaw setup")} first.`);
        }
        note(lines.join("\n"), "Gateway");
    }
    cfg = await maybeRepairAnthropicOAuthProfileId(cfg, prompter);
    cfg = await maybeRemoveDeprecatedCliAuthProfiles(cfg, prompter);
    await noteAuthProfileHealth({
        cfg,
        prompter,
        allowKeychainPrompt: options.nonInteractive !== true && Boolean(process.stdin.isTTY),
    });
    const gatewayDetails = buildGatewayConnectionDetails({ config: cfg });
    if (gatewayDetails.remoteFallbackNote) {
        note(gatewayDetails.remoteFallbackNote, "Gateway");
    }
    if (resolveMode(cfg) === "local") {
        const auth = resolveGatewayAuth({
            authConfig: cfg.gateway?.auth,
            tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off",
        });
        const needsToken = auth.mode !== "password" && (auth.mode !== "token" || !auth.token);
        if (needsToken) {
            note("Gateway auth is off or missing a token. Token auth is now the recommended default (including loopback).", "Gateway auth");
            const shouldSetToken = options.generateGatewayToken === true
                ? true
                : options.nonInteractive === true
                    ? false
                    : await prompter.confirmRepair({
                        message: "Generate and configure a gateway token now?",
                        initialValue: true,
                    });
            if (shouldSetToken) {
                const nextToken = randomToken();
                cfg = {
                    ...cfg,
                    gateway: {
                        ...cfg.gateway,
                        auth: {
                            ...cfg.gateway?.auth,
                            mode: "token",
                            token: nextToken,
                        },
                    },
                };
                note("Gateway token configured.", "Gateway auth");
            }
        }
    }
    const legacyState = await detectLegacyStateMigrations({ cfg });
    if (legacyState.preview.length > 0) {
        note(legacyState.preview.join("\n"), "Legacy state detected");
        const migrate = options.nonInteractive === true
            ? true
            : await prompter.confirm({
                message: "Migrate legacy state (sessions/agent/WhatsApp auth) now?",
                initialValue: true,
            });
    }
}
