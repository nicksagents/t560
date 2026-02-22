// @ts-nocheck
import { formatCliCommand } from "../cli/command-format.js";
import { DEFAULT_WORKSPACE, handleReset, printWizardHeader, summarizeExistingConfig, } from "../commands/onboard-helpers.js";
import { readConfigFileSnapshot, resolveGatewayPort, } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { WizardCancelledError } from "./prompts.js";
async function requireRiskAcknowledgement(params) {
    if (params.opts.acceptRisk === true) {
        return;
    }
    await params.prompter.note([
        "Security warning — please read.",
        "",
        "t560 is a hobby project and still in beta. Expect sharp edges.",
        "This bot can read files and run actions if tools are enabled.",
        "A bad prompt can trick it into doing unsafe things.",
        "",
        "If you’re not comfortable with basic security and access control, don’t run t560.",
        "Ask someone experienced to help before enabling tools or exposing it to the internet.",
        "",
        "Recommended baseline:",
        "- Pairing/allowlists + mention gating.",
        "- Sandbox + least-privilege tools.",
        "- Keep secrets out of the agent’s reachable filesystem.",
        "- Use the strongest available model for any bot with tools or untrusted inboxes.",
        "",
        "Run regularly:",
        "t560 security audit --deep",
        "t560 security audit --fix",
        "",
        "Must read: https://docs.t560.ai/gateway/security",
    ].join("\n"), "Security");
    const ok = await params.prompter.confirm({
        message: "I understand this is powerful and inherently risky. Continue?",
        initialValue: false,
    });
    if (!ok) {
        throw new WizardCancelledError("risk not accepted");
    }
}
export async function runOnboardingWizard(opts, runtime = defaultRuntime, prompter) {
    printWizardHeader(runtime);
    await prompter.intro("t560 onboarding");
    await requireRiskAcknowledgement({ opts, prompter });
    const snapshot = await readConfigFileSnapshot();
    let baseConfig = snapshot.valid ? snapshot.config : {};
    if (snapshot.exists && !snapshot.valid) {
        await prompter.note(summarizeExistingConfig(baseConfig), "Invalid config");
        if (snapshot.issues.length > 0) {
            await prompter.note([
                ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
                "",
                "Docs: https://docs.t560.ai/gateway/configuration",
            ].join("\n"), "Config issues");
        }
        await prompter.outro(`Config invalid. Run \`${formatCliCommand("t560 doctor")}\` to repair it, then re-run onboarding.`);
        runtime.exit(1);
        return;
    }
    const quickstartHint = `Configure details later via ${formatCliCommand("t560 configure")}.`;
    const manualHint = "Configure port, network, Tailscale, and auth options.";
    const explicitFlowRaw = opts.flow?.trim();
    const normalizedExplicitFlow = explicitFlowRaw === "manual" ? "advanced" : explicitFlowRaw;
    if (normalizedExplicitFlow &&
        normalizedExplicitFlow !== "quickstart" &&
        normalizedExplicitFlow !== "advanced") {
        runtime.error("Invalid --flow (use quickstart, manual, or advanced).");
        runtime.exit(1);
        return;
    }
    const explicitFlow = normalizedExplicitFlow === "quickstart" || normalizedExplicitFlow === "advanced"
        ? normalizedExplicitFlow
        : undefined;
    let flow = explicitFlow ??
        (await prompter.select({
            message: "Onboarding mode",
            options: [
                { value: "quickstart", label: "QuickStart", hint: quickstartHint },
                { value: "advanced", label: "Manual", hint: manualHint },
            ],
            initialValue: "quickstart",
        }));
    if (opts.mode === "remote" && flow === "quickstart") {
        await prompter.note("QuickStart only supports local gateways. Switching to Manual mode.", "QuickStart");
        flow = "advanced";
    }
    if (snapshot.exists) {
        await prompter.note(summarizeExistingConfig(baseConfig), "Existing config detected");
        const action = await prompter.select({
            message: "Config handling",
            options: [
                { value: "keep", label: "Use existing values" },
                { value: "modify", label: "Update values" },
                { value: "reset", label: "Reset" },
            ],
        });
        if (action === "reset") {
            const workspaceDefault = baseConfig.agents?.defaults?.workspace ?? DEFAULT_WORKSPACE;
            const resetScope = (await prompter.select({
                message: "Reset scope",
                options: [
                    { value: "config", label: "Config only" },
                    {
                        value: "config+creds+sessions",
                        label: "Config + creds + sessions",
                    },
                    {
                        value: "full",
                        label: "Full reset (config + creds + sessions + workspace)",
                    },
                ],
            }));
            await handleReset(resetScope, resolveUserPath(workspaceDefault), runtime);
            baseConfig = {};
        }
    }
    const quickstartGateway = (() => {
        const hasExisting = typeof baseConfig.gateway?.port === "number" ||
            baseConfig.gateway?.bind !== undefined ||
            baseConfig.gateway?.auth?.mode !== undefined ||
            baseConfig.gateway?.auth?.token !== undefined ||
            baseConfig.gateway?.auth?.password !== undefined ||
            baseConfig.gateway?.customBindHost !== undefined ||
            baseConfig.gateway?.tailscale?.mode !== undefined;
        const bindRaw = baseConfig.gateway?.bind;
        const bind = bindRaw === "loopback" ||
            bindRaw === "lan" ||
            bindRaw === "auto" ||
            bindRaw === "custom" ||
            bindRaw === "tailnet"
            ? bindRaw
            : "loopback";
        let authMode = "token";
        if (baseConfig.gateway?.auth?.mode === "token" ||
            baseConfig.gateway?.auth?.mode === "password") {
            authMode = baseConfig.gateway.auth.mode;
        }
        else if (baseConfig.gateway?.auth?.token) {
            authMode = "token";
        }
        else if (baseConfig.gateway?.auth?.password) {
            authMode = "password";
        }
        const tailscaleRaw = baseConfig.gateway?.tailscale?.mode;
        const tailscaleMode = tailscaleRaw === "off" || tailscaleRaw === "serve" || tailscaleRaw === "funnel"
            ? tailscaleRaw
            : "off";
        return {
            hasExisting,
            port: resolveGatewayPort(baseConfig),
            bind,
            authMode,
            tailscaleMode,
            token: baseConfig.gateway?.auth?.token,
            password: baseConfig.gateway?.auth?.password,
            customBindHost: baseConfig.gateway?.customBindHost,
            tailscaleResetOnExit: baseConfig.gateway?.tailscale?.resetOnExit ?? false,
        };
    })();
    if (flow === "quickstart") {
        const formatBind = (value) => {
            if (value === "loopback") {
                return "Loopback (127.0.0.1)";
            }
            if (value === "lan") {
                return "LAN";
            }
            if (value === "custom") {
                return "Custom IP";
            }
            if (value === "tailnet") {
                return "Tailnet (Tailscale IP)";
            }
            return "Auto";
        };
        const formatAuth = (value) => {
            if (value === "token") {
                return "Token (default)";
            }
            return "Password";
        };
    }
}
