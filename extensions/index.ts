import { access, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLED_PLUGINS_PATH = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const BRIDGE_CONFIG_PATH = path.join(PACKAGE_ROOT, "claude-plugin-bridge.json");
const DEBUG = process.env.PI_CLAUDE_PLUGINS_DEBUG === "1";
const IGNORED_DIRECTORY_NAMES = new Set(["node_modules", "build", "dist", "out"]);

type InstalledPluginEntry = {
  scope?: string;
  projectPath?: string;
  installPath?: string;
};

type InstalledPluginsFile = {
  plugins?: Record<string, InstalledPluginEntry[]>;
};

type ClaudeSettingsFile = {
  enabledPlugins?: Record<string, boolean>;
};

type BridgeMode = "allow-all" | "deny-all";

type BridgeConfigFile = {
  mode?: BridgeMode;
  allowPlugins?: string[];
  denyPlugins?: string[];
  allowResources?: string[];
  denyResources?: string[];
};

type BridgeConfig = {
  mode: BridgeMode;
  allowPlugins: Set<string>;
  denyPlugins: Set<string>;
  allowResources: Set<string>;
  denyResources: Set<string>;
};

type EnabledPluginInstall = {
  pluginKey: string;
  installPath: string;
};

type DiscoveredResources = {
  skillPaths: string[];
  promptPaths: string[];
};

function shouldIgnoreEntry(name: string, isDirectory: boolean): boolean {
  if (name.startsWith(".")) return true;
  if (isDirectory && IGNORED_DIRECTORY_NAMES.has(name)) return true;
  return false;
}

async function readEntries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw error;
  }
}

function normalizeConfigValues(values: string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

async function loadBridgeConfig(): Promise<BridgeConfig> {
  let raw: string;
  try {
    raw = await readFile(BRIDGE_CONFIG_PATH, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        mode: "allow-all",
        allowPlugins: new Set(),
        denyPlugins: new Set(),
        allowResources: new Set(),
        denyResources: new Set(),
      };
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as BridgeConfigFile;
  return {
    mode: parsed.mode === "deny-all" ? "deny-all" : "allow-all",
    allowPlugins: normalizeConfigValues(parsed.allowPlugins),
    denyPlugins: normalizeConfigValues(parsed.denyPlugins),
    allowResources: normalizeConfigValues(parsed.allowResources),
    denyResources: normalizeConfigValues(parsed.denyResources),
  };
}

function matchesAny(candidates: Iterable<string>, values: Set<string>): boolean {
  for (const candidate of candidates) {
    if (values.has(candidate)) {
      return true;
    }
  }
  return false;
}

function isAllowed(candidates: Iterable<string>, allow: Set<string>, deny: Set<string>, mode: BridgeMode): boolean {
  if (matchesAny(candidates, allow)) {
    return true;
  }

  if (matchesAny(candidates, deny)) {
    return false;
  }

  return mode === "allow-all";
}

function getPromptResourceNames(entryPath: string): string[] {
  const fileName = path.basename(entryPath);
  const resourceName = path.basename(entryPath, ".md");
  return fileName === resourceName ? [resourceName] : [resourceName, fileName];
}

async function walkInstallPath(
  dir: string,
  config: BridgeConfig,
  resources: DiscoveredResources,
): Promise<void> {
  const entries = await readEntries(dir);

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      if (shouldIgnoreEntry(entry.name, true)) {
        continue;
      }

      await walkInstallPath(entryPath, config, resources);
      continue;
    }

    if (shouldIgnoreEntry(entry.name, false)) {
      continue;
    }

    if (entry.name === "SKILL.md") {
      const parentDir = path.dirname(entryPath);
      if (path.basename(path.dirname(parentDir)) === "skills") {
        const resourceName = path.basename(parentDir);
        if (isAllowed([resourceName], config.allowResources, config.denyResources, config.mode)) {
          resources.skillPaths.push(entryPath);
        }
      }
      continue;
    }

    if (entry.name.endsWith(".md") && path.basename(path.dirname(entryPath)) === "commands") {
      if (isAllowed(getPromptResourceNames(entryPath), config.allowResources, config.denyResources, config.mode)) {
        resources.promptPaths.push(entryPath);
      }
    }
  }
}

function normalizePath(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function isSameOrDescendant(parent: string, target: string): boolean {
  return target === parent || target.startsWith(`${parent}/`);
}

async function loadPluginEnabledStates(): Promise<Record<string, boolean>> {
  let raw: string;
  try {
    raw = await readFile(CLAUDE_SETTINGS_PATH, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw error;
  }

  const parsed = JSON.parse(raw) as ClaudeSettingsFile;
  return parsed.enabledPlugins ?? {};
}

async function loadEnabledPluginInstalls(cwd: string): Promise<EnabledPluginInstall[]> {
  let raw: string;
  try {
    raw = await readFile(INSTALLED_PLUGINS_PATH, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }

  const parsed = JSON.parse(raw) as InstalledPluginsFile;
  const plugins = parsed.plugins ?? {};
  const pluginEnabledStates = await loadPluginEnabledStates();
  const normalizedCwd = normalizePath(cwd);
  const enabledInstalls = new Map<string, EnabledPluginInstall>();

  for (const [pluginKey, entries] of Object.entries(plugins)) {
    if (pluginEnabledStates[pluginKey] === false) {
      continue;
    }

    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.installPath !== "string" || entry.installPath.length === 0) continue;

      const isEnabledForCwd =
        entry.scope === "user" ||
        (entry.scope === "project" &&
          typeof entry.projectPath === "string" &&
          isSameOrDescendant(normalizePath(entry.projectPath), normalizedCwd)) ||
        entry.scope == null;

      if (isEnabledForCwd) {
        const installPath = path.resolve(entry.installPath);
        enabledInstalls.set(`${pluginKey}:${installPath}`, { pluginKey, installPath });
      }
    }
  }

  return [...enabledInstalls.values()];
}

async function findResources(cwd: string): Promise<DiscoveredResources> {
  const [enabledInstalls, config] = await Promise.all([loadEnabledPluginInstalls(cwd), loadBridgeConfig()]);
  const discovered: DiscoveredResources = {
    skillPaths: [],
    promptPaths: [],
  };

  for (const { pluginKey, installPath } of enabledInstalls) {
    if (!isAllowed([pluginKey], config.allowPlugins, config.denyPlugins, config.mode)) {
      continue;
    }

    if (!(await fileExists(installPath))) {
      continue;
    }

    await walkInstallPath(installPath, config, discovered);
  }

  return {
    skillPaths: [...new Set(discovered.skillPaths)],
    promptPaths: [...new Set(discovered.promptPaths)],
  };
}

export default function claudeMarketplaceSkills(pi: ExtensionAPI) {
  async function discoverResources(cwd: string): Promise<DiscoveredResources> {
    const [enabledInstalls, config, resources] = await Promise.all([
      loadEnabledPluginInstalls(cwd),
      loadBridgeConfig(),
      findResources(cwd),
    ]);

    if (DEBUG) {
      const scannedInstalls = enabledInstalls.filter(({ pluginKey }) =>
        isAllowed([pluginKey], config.allowPlugins, config.denyPlugins, config.mode),
      );
      console.log(
        `[claude-marketplace-skills] Bridge config ${BRIDGE_CONFIG_PATH} (${config.mode}); scanning ${scannedInstalls.length} enabled Claude plugin install path${scannedInstalls.length === 1 ? "" : "s"}: ${scannedInstalls.length > 0 ? scannedInstalls.map(({ pluginKey, installPath }) => `${pluginKey} => ${installPath}`).join(", ") : "(none)"}\n`,
      );
    }

    return {
      skillPaths: resources.skillPaths.sort((a, b) => a.localeCompare(b)),
      promptPaths: resources.promptPaths.sort((a, b) => a.localeCompare(b)),
    };
  }

  pi.on("resources_discover", async (event) => {
    const resources = await discoverResources(event.cwd);
    return resources;
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const resources = await discoverResources(ctx.cwd);
      const skillCount = resources.skillPaths.length;
      const promptCount = resources.promptPaths.length;
      const message =
        skillCount > 0 || promptCount > 0
          ? `[claude-marketplace-skills] Loaded ${skillCount} skill file${skillCount === 1 ? "" : "s"} and ${promptCount} command file${promptCount === 1 ? "" : "s"} from enabled Claude plugin install paths`
          : `[claude-marketplace-skills] No enabled skill or command files found in enabled Claude plugin install paths`;

      console.log(`${message}\n`);
      if (ctx.hasUI) {
        ctx.ui.notify(message, skillCount > 0 || promptCount > 0 ? "success" : "warning");
      }
    } catch (error) {
      const message = `[claude-marketplace-skills] Failed to discover resources: ${(error as Error).message}`;
      console.log(`${message}\n`);
      if (ctx.hasUI) {
        ctx.ui.notify(message, "error");
      }
    }
  });
}
