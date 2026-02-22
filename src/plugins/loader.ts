// @ts-nocheck
import { createJiti } from "jiti";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { clearPluginCommands } from "./commands.js";
import { normalizePluginsConfig, } from "./config-state.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { createPluginRegistry } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";
import { createPluginRuntime } from "./runtime/index.js";
import { validateJsonSchemaValue } from "./schema-validator.js";
const registryCache = new Map();
const defaultLogger = () => createSubsystemLogger("plugins");
const resolvePluginSdkAlias = () => {
    try {
        const modulePath = fileURLToPath(import.meta.url);
        const isProduction = process.env.NODE_ENV === "production";
        const isTest = process.env.VITEST || process.env.NODE_ENV === "test";
        let cursor = path.dirname(modulePath);
        for (let i = 0; i < 6; i += 1) {
            const srcCandidate = path.join(cursor, "src", "plugin-sdk", "index.ts");
            const distCandidate = path.join(cursor, "dist", "plugin-sdk", "index.js");
            const orderedCandidates = isProduction
                ? isTest
                    ? [distCandidate, srcCandidate]
                    : [distCandidate]
                : [srcCandidate, distCandidate];
            for (const candidate of orderedCandidates) {
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            }
            const parent = path.dirname(cursor);
            if (parent === cursor) {
                break;
            }
            cursor = parent;
        }
    }
    catch {
        // ignore
    }
    return null;
};
function buildCacheKey(params) {
    const workspaceKey = params.workspaceDir ? resolveUserPath(params.workspaceDir) : "";
    return `${workspaceKey}::${JSON.stringify(params.plugins)}`;
}
function validatePluginConfig(params) {
    const schema = params.schema;
    if (!schema) {
        return { ok: true, value: params.value };
    }
    const cacheKey = params.cacheKey ?? JSON.stringify(schema);
    const result = validateJsonSchemaValue({
        schema,
        cacheKey,
        value: params.value ?? {},
    });
    if (result.ok) {
        return { ok: true, value: params.value };
    }
    return { ok: false, errors: result.errors };
}
function resolvePluginModuleExport(moduleExport) {
    const resolved = moduleExport &&
        typeof moduleExport === "object" &&
        "default" in moduleExport
        ? moduleExport.default
        : moduleExport;
    if (typeof resolved === "function") {
        return {
            register: resolved,
        };
    }
    if (resolved && typeof resolved === "object") {
        const def = resolved;
        const register = def.register ?? def.activate;
        return { definition: def, register };
    }
    return {};
}
function createPluginRecord(params) {
    return {
        id: params.id,
        name: params.name ?? params.id,
        description: params.description,
        version: params.version,
        source: params.source,
        origin: params.origin,
        workspaceDir: params.workspaceDir,
        enabled: params.enabled,
        status: params.enabled ? "loaded" : "disabled",
        toolNames: [],
        hookNames: [],
        channelIds: [],
        providerIds: [],
        gatewayMethods: [],
        cliCommands: [],
        services: [],
        commands: [],
        httpHandlers: 0,
        hookCount: 0,
        configSchema: params.configSchema,
        configUiHints: undefined,
        configJsonSchema: undefined,
    };
}
function pushDiagnostics(diagnostics, append) {
    diagnostics.push(...append);
}
export function loadOpenClawPlugins(options = {}) {
    const cfg = options.config ?? {};
    const logger = options.logger ?? defaultLogger();
    const validateOnly = options.mode === "validate";
    const normalized = normalizePluginsConfig(cfg.plugins);
    const cacheKey = buildCacheKey({
        workspaceDir: options.workspaceDir,
        plugins: normalized,
    });
    const cacheEnabled = options.cache !== false;
    if (cacheEnabled) {
        const cached = registryCache.get(cacheKey);
        if (cached) {
            setActivePluginRegistry(cached, cacheKey);
            return cached;
        }
    }
    // Clear previously registered plugin commands before reloading
    clearPluginCommands();
    const runtime = createPluginRuntime();
    const { registry, createApi } = createPluginRegistry({
        logger,
        runtime,
        coreGatewayHandlers: options.coreGatewayHandlers,
    });
    const discovery = discoverOpenClawPlugins({
        workspaceDir: options.workspaceDir,
        extraPaths: normalized.loadPaths,
    });
    const manifestRegistry = loadPluginManifestRegistry({
        config: cfg,
        workspaceDir: options.workspaceDir,
        cache: options.cache,
        candidates: discovery.candidates,
        diagnostics: discovery.diagnostics,
    });
    pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);
    const pluginSdkAlias = resolvePluginSdkAlias();
    const jiti = createJiti(import.meta.url, {
        interopDefault: true,
        extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
        ...(pluginSdkAlias
            ? {
                alias: { "openclaw/plugin-sdk": pluginSdkAlias },
            }
            : {}),
    });
}
