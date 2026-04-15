import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolCallEvent } from "@mariozechner/pi-coding-agent";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USER_CLAUDE_SKILLS_DIR = path.join(os.homedir(), ".claude", "skills");
const USER_CLAUDE_COMMANDS_DIR = path.join(os.homedir(), ".claude", "commands");
const INSTALLED_PLUGINS_PATH = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const BRIDGE_CONFIG_PATH = path.join(PACKAGE_ROOT, "claude-plugin-bridge.json");
const SANITIZED_PROMPTS_DIR = path.join(os.tmpdir(), "pi-claude-plugins", "prompts");
const DEBUG = process.env.PI_CLAUDE_PLUGINS_DEBUG === "1";
const RULE_AUTO_READ_MESSAGE_TYPE = "claude-rule-auto-read";
const RULE_AUTO_READ_AUDIT_MESSAGE_TYPE = "claude-rule-auto-read-audit";
const RULE_AUTO_READ_MARKER_TYPE = "claude-rule-auto-read-marker";
const IGNORED_DIRECTORY_NAMES = new Set(["node_modules", "build", "dist", "out"]);
const GLOB_WILDCARD_RE = /[*?[]/;

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

type RuleDefinition = {
  rulePath: string;
  realPath: string;
  displayPath: string;
  sourceDisplayPath: string;
  paths: string[];
  exactPaths: Set<string>;
  prefixPaths: string[];
  wildcardMatchers: RegExp[];
};

type RuleMatchIndex = {
  rulesDir: string;
  rules: RuleDefinition[];
  exactPathRules: Map<string, RuleDefinition[]>;
  prefixRules: Array<{ prefix: string; rule: RuleDefinition }>;
  wildcardRules: RuleDefinition[];
  matchCache: Map<string, RuleDefinition[]>;
};

type RuleAutoReadMarker = {
  ruleRealPath: string;
  rulePath: string;
  sourcePath: string;
  triggeredByTool: string;
  targetPath: string;
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

function normalizePath(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/^\//, "");
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

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizeRelativePath(glob);
  let pattern = "^";

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];

    if (char === "*") {
      if (next === "*") {
        const afterNext = normalized[i + 2];
        if (afterNext === "/") {
          pattern += "(?:.*/)?";
          i += 2;
        } else {
          pattern += ".*";
          i += 1;
        }
      } else {
        pattern += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      pattern += "[^/]";
      continue;
    }

    pattern += escapeRegExp(char);
  }

  pattern += "$";
  return new RegExp(pattern);
}

function getPromptResourceNames(entryPath: string): string[] {
  const fileName = path.basename(entryPath);
  const resourceName = path.basename(entryPath, ".md");
  return fileName === resourceName ? [resourceName] : [resourceName, fileName];
}

function extractFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: null, body: normalized };
  }

  const endIndex = normalized.indexOf("\n---", 4);
  if (endIndex === -1) {
    return { frontmatter: null, body: normalized };
  }

  return {
    frontmatter: normalized.slice(4, endIndex),
    body: normalized.slice(endIndex + 4).trimStart(),
  };
}

function parseSimpleFrontmatterValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function buildSanitizedPromptTemplate(rawContent: string): string {
  const { frontmatter, body } = extractFrontmatter(rawContent);
  if (frontmatter == null) {
    return rawContent;
  }

  let description: string | undefined;
  let argumentHint: string | undefined;

  for (const line of frontmatter.split("\n")) {
    const descriptionMatch = line.match(/^description:\s*(.*)$/);
    if (descriptionMatch) {
      description = parseSimpleFrontmatterValue(descriptionMatch[1]);
      continue;
    }

    const argumentHintMatch = line.match(/^argument-hint:\s*(.*)$/);
    if (argumentHintMatch) {
      argumentHint = parseSimpleFrontmatterValue(argumentHintMatch[1]);
    }
  }

  const sanitizedLines = ["---"];
  if (description && description.length > 0) {
    sanitizedLines.push(`description: ${JSON.stringify(description)}`);
  }
  if (argumentHint && argumentHint.length > 0) {
    sanitizedLines.push(`argument-hint: ${JSON.stringify(argumentHint)}`);
  }
  sanitizedLines.push("---", "", body);

  return `${sanitizedLines.join("\n").replace(/\n+$/, "")}\n`;
}

async function sanitizePromptTemplatePath(filePath: string): Promise<string> {
  const rawContent = await readFile(filePath, "utf8");
  const sanitizedContent = buildSanitizedPromptTemplate(rawContent);
  const sourceHash = crypto.createHash("sha1").update(normalizePath(filePath)).digest("hex").slice(0, 12);
  const targetDir = path.join(SANITIZED_PROMPTS_DIR, sourceHash);
  const targetPath = path.join(targetDir, path.basename(filePath));

  await mkdir(targetDir, { recursive: true });
  await writeFile(targetPath, sanitizedContent, "utf8");
  return targetPath;
}

function getStandaloneSkillResourceNames(entryPath: string): string[] {
  const dirName = path.basename(path.dirname(entryPath));
  return [dirName];
}

function getProjectClaudeSkillsDir(cwd: string): string {
  return path.join(path.resolve(cwd), ".claude", "skills");
}

function getProjectClaudeCommandsDir(cwd: string): string {
  return path.join(path.resolve(cwd), ".claude", "commands");
}

function getProjectClaudeRulesDir(cwd: string): string {
  return path.join(path.resolve(cwd), ".claude", "rules");
}

function isSameOrDescendant(parent: string, target: string): boolean {
  return target === parent || target.startsWith(`${parent}/`);
}

function formatDisplayPath(filePath: string, cwd: string): string {
  const normalizedFilePath = normalizePath(filePath);
  const normalizedCwd = normalizePath(cwd);

  if (isSameOrDescendant(normalizedCwd, normalizedFilePath)) {
    const relative = normalizeRelativePath(path.relative(normalizedCwd, normalizedFilePath));
    return relative.length > 0 ? relative : path.basename(normalizedFilePath);
  }

  return normalizedFilePath;
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
        if (isAllowed(getStandaloneSkillResourceNames(entryPath), config.allowResources, config.denyResources, config.mode)) {
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

async function discoverStandaloneClaudeSkillsDir(
  skillsDir: string,
  config: BridgeConfig,
  resources: DiscoveredResources,
): Promise<void> {
  const entries = await readEntries(skillsDir);

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || shouldIgnoreEntry(entry.name, true)) {
      continue;
    }

    const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
    if (!(await fileExists(skillPath))) {
      continue;
    }

    if (isAllowed(getStandaloneSkillResourceNames(skillPath), config.allowResources, config.denyResources, config.mode)) {
      resources.skillPaths.push(skillPath);
    }
  }
}

async function discoverStandaloneClaudeCommandsDir(
  commandsDir: string,
  config: BridgeConfig,
  resources: DiscoveredResources,
): Promise<void> {
  const entries = await readEntries(commandsDir);

  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || shouldIgnoreEntry(entry.name, false) || !entry.name.endsWith(".md")) {
      continue;
    }

    const commandPath = path.join(commandsDir, entry.name);
    if (isAllowed(getPromptResourceNames(commandPath), config.allowResources, config.denyResources, config.mode)) {
      resources.promptPaths.push(commandPath);
    }
  }
}

function parseRuleFrontmatter(content: string): string[] {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return [];

  const lines = match[1].split(/\r?\n/);
  const paths: string[] = [];
  let inPaths = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "    ");
    const trimmed = line.trim();

    if (!inPaths) {
      if (trimmed === "paths:" || trimmed.startsWith("paths:")) {
        inPaths = true;
      }
      continue;
    }

    if (trimmed.length === 0) continue;
    if (!line.startsWith(" ") && !line.startsWith("-")) break;
    if (!trimmed.startsWith("-")) continue;

    const value = trimmed.slice(1).trim().replace(/^['"]|['"]$/g, "");
    if (value.length > 0) {
      paths.push(normalizeRelativePath(value));
    }
  }

  return paths;
}

function buildRuleDefinition(rulePath: string, realRulePath: string, content: string, cwd: string): RuleDefinition {
  const displayPath = formatDisplayPath(rulePath, cwd);
  const sourceDisplayPath = formatDisplayPath(realRulePath, cwd);
  const paths = parseRuleFrontmatter(content);
  const exactPaths = new Set<string>();
  const prefixPaths: string[] = [];
  const wildcardMatchers: RegExp[] = [];

  for (const rulePathGlob of paths) {
    if (!GLOB_WILDCARD_RE.test(rulePathGlob)) {
      exactPaths.add(rulePathGlob);
      continue;
    }

    if (rulePathGlob.endsWith("/**") && !GLOB_WILDCARD_RE.test(rulePathGlob.slice(0, -3))) {
      prefixPaths.push(rulePathGlob.slice(0, -3));
      continue;
    }

    wildcardMatchers.push(globToRegExp(rulePathGlob));
  }

  return {
    rulePath: normalizePath(rulePath),
    realPath: normalizePath(realRulePath),
    displayPath,
    sourceDisplayPath,
    paths,
    exactPaths,
    prefixPaths,
    wildcardMatchers,
  };
}

async function scanRuleFiles(dir: string): Promise<string[]> {
  const entries = await readEntries(dir);
  const results: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.isSymbolicLink() || shouldIgnoreEntry(entry.name, true)) {
        continue;
      }

      results.push(...(await scanRuleFiles(entryPath)));
      continue;
    }

    if (entry.isFile()) {
      if (!shouldIgnoreEntry(entry.name, false) && entry.name.endsWith(".md")) {
        results.push(entryPath);
      }
      continue;
    }

    if (entry.isSymbolicLink() && !shouldIgnoreEntry(entry.name, false) && entry.name.endsWith(".md")) {
      try {
        const targetStats = await stat(entryPath);
        if (targetStats.isFile()) {
          results.push(entryPath);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  return results;
}

async function loadRuleIndex(cwd: string, config: BridgeConfig): Promise<RuleMatchIndex> {
  const rulesDir = getProjectClaudeRulesDir(cwd);
  if (!(await fileExists(rulesDir))) {
    return {
      rulesDir,
      rules: [],
      exactPathRules: new Map(),
      prefixRules: [],
      wildcardRules: [],
      matchCache: new Map(),
    };
  }

  const ruleFiles = await scanRuleFiles(rulesDir);
  const rules: RuleDefinition[] = [];
  const exactPathRules = new Map<string, RuleDefinition[]>();
  const prefixRules: Array<{ prefix: string; rule: RuleDefinition }> = [];
  const wildcardRules: RuleDefinition[] = [];

  for (const ruleFile of ruleFiles) {
    const content = await readFile(ruleFile, "utf8");
    const realRulePath = await realpath(ruleFile);
    const rule = buildRuleDefinition(ruleFile, realRulePath, content, cwd);

    if (!isAllowed(getPromptResourceNames(ruleFile), config.allowResources, config.denyResources, config.mode)) {
      continue;
    }

    if (rule.paths.length === 0) {
      continue;
    }

    rules.push(rule);

    for (const exactPath of rule.exactPaths) {
      const existing = exactPathRules.get(exactPath) ?? [];
      existing.push(rule);
      exactPathRules.set(exactPath, existing);
    }

    for (const prefix of rule.prefixPaths) {
      prefixRules.push({ prefix, rule });
    }

    if (rule.wildcardMatchers.length > 0) {
      wildcardRules.push(rule);
    }
  }

  return {
    rulesDir,
    rules,
    exactPathRules,
    prefixRules,
    wildcardRules,
    matchCache: new Map(),
  };
}

function getMatchingRules(index: RuleMatchIndex, targetRelativePath: string): RuleDefinition[] {
  const normalizedTarget = normalizeRelativePath(targetRelativePath);
  const cached = index.matchCache.get(normalizedTarget);
  if (cached) {
    return cached;
  }

  const matches = new Map<string, RuleDefinition>();

  for (const rule of index.exactPathRules.get(normalizedTarget) ?? []) {
    matches.set(rule.realPath, rule);
  }

  for (const { prefix, rule } of index.prefixRules) {
    if (normalizedTarget === prefix || normalizedTarget.startsWith(`${prefix}/`)) {
      matches.set(rule.realPath, rule);
    }
  }

  for (const rule of index.wildcardRules) {
    if (rule.wildcardMatchers.some((matcher) => matcher.test(normalizedTarget))) {
      matches.set(rule.realPath, rule);
    }
  }

  const result = [...matches.values()].sort((a, b) => a.displayPath.localeCompare(b.displayPath));
  index.matchCache.set(normalizedTarget, result);
  return result;
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

  for (const skillsDir of [USER_CLAUDE_SKILLS_DIR, getProjectClaudeSkillsDir(cwd)]) {
    if (await fileExists(skillsDir)) {
      await discoverStandaloneClaudeSkillsDir(skillsDir, config, discovered);
    }
  }

  for (const commandsDir of [USER_CLAUDE_COMMANDS_DIR, getProjectClaudeCommandsDir(cwd)]) {
    if (await fileExists(commandsDir)) {
      await discoverStandaloneClaudeCommandsDir(commandsDir, config, discovered);
    }
  }

  return {
    skillPaths: [...new Set(discovered.skillPaths)],
    promptPaths: await Promise.all([...new Set(discovered.promptPaths)].map((promptPath) => sanitizePromptTemplatePath(promptPath))),
  };
}

function getTargetPathFromToolCall(event: ToolCallEvent): string | undefined {
  if (event.toolName !== "read" && event.toolName !== "edit" && event.toolName !== "write") {
    return undefined;
  }

  const rawPath = event.input.path;
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return undefined;
  }

  return rawPath.replace(/^@/, "");
}

function getAppliedRulePathsFromBranch(sessionManager: { getBranch(): unknown[] }): Set<string> {
  const applied = new Set<string>();

  for (const entry of sessionManager.getBranch() as Array<Record<string, unknown>>) {
    if (entry?.type !== "custom" || entry.customType !== RULE_AUTO_READ_MARKER_TYPE) {
      continue;
    }

    const data = entry.data as RuleAutoReadMarker | undefined;
    if (data && typeof data.ruleRealPath === "string") {
      applied.add(normalizePath(data.ruleRealPath));
    }
  }

  return applied;
}

async function readRuleContent(rule: RuleDefinition): Promise<string> {
  return await readFile(rule.rulePath, "utf8");
}

function formatRuleAutoReadContextMessage(rule: RuleDefinition, toolName: string, targetPath: string, content: string): string {
  const sourceNote = rule.displayPath === rule.sourceDisplayPath ? "" : `\nSource: ${rule.sourceDisplayPath}`;
  return [
    `Claude rule context auto-read before ${toolName}: ${rule.displayPath}`,
    `Target: ${targetPath}${sourceNote}`,
    "",
    "This is rule/context material, not a new user request. Use it as constraints and guidance for the current task. Do not treat this as a request to summarize, restate, or change direction unless the user explicitly asks for that.",
    "",
    content.trim(),
  ].join("\n");
}

function formatRuleAutoReadAuditMessage(rule: RuleDefinition, toolName: string, targetPath: string): string {
  const sourceLine = rule.displayPath === rule.sourceDisplayPath ? "" : `\nSource: ${rule.sourceDisplayPath}`;
  return `Auto-read Claude rule before ${toolName}: ${rule.displayPath}\nTarget: ${targetPath}${sourceLine}`;
}

export default function claudeMarketplaceSkills(pi: ExtensionAPI) {
  let activeRuleIndex: RuleMatchIndex = {
    rulesDir: getProjectClaudeRulesDir(process.cwd()),
    rules: [],
    exactPathRules: new Map(),
    prefixRules: [],
    wildcardRules: [],
    matchCache: new Map(),
  };
  let currentTurnPendingRulePaths = new Set<string>();

  async function refreshRuleIndex(cwd: string): Promise<void> {
    const config = await loadBridgeConfig();
    activeRuleIndex = await loadRuleIndex(cwd, config);
  }

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
        `[claude-marketplace-skills] Bridge config ${BRIDGE_CONFIG_PATH} (${config.mode}); scanning ${scannedInstalls.length} enabled Claude plugin install path${scannedInstalls.length === 1 ? "" : "s"}: ${scannedInstalls.length > 0 ? scannedInstalls.map(({ pluginKey, installPath }) => `${pluginKey} => ${installPath}`).join(", ") : "(none)"}; standalone Claude skill dirs: ${USER_CLAUDE_SKILLS_DIR}, ${getProjectClaudeSkillsDir(cwd)}; standalone Claude command dirs: ${USER_CLAUDE_COMMANDS_DIR}, ${getProjectClaudeCommandsDir(cwd)}\n`,
      );
    }

    return {
      skillPaths: resources.skillPaths.sort((a, b) => a.localeCompare(b)),
      promptPaths: resources.promptPaths.sort((a, b) => a.localeCompare(b)),
    };
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      currentTurnPendingRulePaths = new Set();
      await refreshRuleIndex(ctx.cwd);

      const resources = await discoverResources(ctx.cwd);
      const skillCount = resources.skillPaths.length;
      const promptCount = resources.promptPaths.length;
      const message =
        skillCount > 0 || promptCount > 0
          ? `[claude-marketplace-skills] Loaded ${skillCount} skill file${skillCount === 1 ? "" : "s"} and ${promptCount} command file${promptCount === 1 ? "" : "s"} from Claude plugins, skills, and commands`
          : `[claude-marketplace-skills] No enabled skill or command files found in Claude plugins, skills, or commands`;

      console.log(`${message}\n`);
      if (ctx.hasUI) {
        ctx.ui.notify(message, skillCount > 0 || promptCount > 0 ? "success" : "warning");
      }

      if (DEBUG) {
        const ruleSummary = `[claude-marketplace-skills] Indexed ${activeRuleIndex.rules.length} Claude rule file${activeRuleIndex.rules.length === 1 ? "" : "s"} from ${activeRuleIndex.rulesDir}`;
        console.log(`${ruleSummary}\n`);
        if (ctx.hasUI) {
          ctx.ui.notify(ruleSummary, "info");
        }
      }
    } catch (error) {
      const message = `[claude-marketplace-skills] Failed to discover resources: ${(error as Error).message}`;
      console.log(`${message}\n`);
      if (ctx.hasUI) {
        ctx.ui.notify(message, "error");
      }
    }
  });

  pi.on("resources_discover", async (event) => {
    return await discoverResources(event.cwd);
  });

  pi.on("turn_start", async () => {
    currentTurnPendingRulePaths = new Set();
  });

  pi.on("turn_end", async () => {
    currentTurnPendingRulePaths = new Set();
  });

  pi.on("tool_call", async (event, ctx) => {
    const targetPath = getTargetPathFromToolCall(event);
    if (!targetPath) {
      return;
    }

    const absoluteTargetPath = normalizePath(path.resolve(ctx.cwd, targetPath));
    const relativeTargetPath = normalizeRelativePath(path.relative(ctx.cwd, absoluteTargetPath));
    if (relativeTargetPath.startsWith("..")) {
      return;
    }

    const matchingRules = getMatchingRules(activeRuleIndex, relativeTargetPath);
    if (matchingRules.length === 0) {
      return;
    }

    const appliedRulePaths = getAppliedRulePathsFromBranch(ctx.sessionManager);
    const rulesToInject = matchingRules.filter(
      (rule) => !appliedRulePaths.has(rule.realPath) && !currentTurnPendingRulePaths.has(rule.realPath),
    );

    if (rulesToInject.length === 0) {
      return;
    }

    for (const rule of rulesToInject) {
      currentTurnPendingRulePaths.add(rule.realPath);
      const ruleContent = await readRuleContent(rule);

      pi.sendMessage(
        {
          customType: RULE_AUTO_READ_MESSAGE_TYPE,
          content: formatRuleAutoReadContextMessage(rule, event.toolName, relativeTargetPath, ruleContent),
          display: false,
          details: {
            rulePath: rule.displayPath,
            sourcePath: rule.sourceDisplayPath,
            targetPath: relativeTargetPath,
            toolName: event.toolName,
          },
        },
        { deliverAs: "steer" },
      );

      pi.sendMessage(
        {
          customType: RULE_AUTO_READ_AUDIT_MESSAGE_TYPE,
          content: formatRuleAutoReadAuditMessage(rule, event.toolName, relativeTargetPath),
          display: true,
          details: {
            rulePath: rule.displayPath,
            sourcePath: rule.sourceDisplayPath,
            targetPath: relativeTargetPath,
            toolName: event.toolName,
          },
        },
        { deliverAs: "steer" },
      );

      pi.appendEntry<RuleAutoReadMarker>(RULE_AUTO_READ_MARKER_TYPE, {
        ruleRealPath: rule.realPath,
        rulePath: rule.displayPath,
        sourcePath: rule.sourceDisplayPath,
        triggeredByTool: event.toolName,
        targetPath: relativeTargetPath,
      });

      if (ctx.hasUI) {
        ctx.ui.notify(`Auto-read Claude rule: ${rule.displayPath}`, "info");
      }
    }

    if (DEBUG) {
      console.log(
        `[claude-marketplace-skills] Auto-read ${rulesToInject.length} Claude rule file${rulesToInject.length === 1 ? "" : "s"} before ${event.toolName}: ${rulesToInject.map((rule) => rule.displayPath).join(", ")} for ${relativeTargetPath}\n`,
      );
    }

    return {
      block: true,
      reason: `Auto-read ${rulesToInject.length} Claude rule file${rulesToInject.length === 1 ? "" : "s"} for ${relativeTargetPath}. Retry now that the rule${rulesToInject.length === 1 ? " is" : "s are"} in context.`,
    };
  });
}
