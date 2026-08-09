import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, Theme, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USER_CLAUDE_SKILLS_DIR = path.join(os.homedir(), ".claude", "skills");
const USER_CLAUDE_COMMANDS_DIR = path.join(os.homedir(), ".claude", "commands");
const INSTALLED_PLUGINS_PATH = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const BRIDGE_CONFIG_PATH = path.join(PACKAGE_ROOT, "claude-plugin-bridge.json");
const SANITIZED_PROMPTS_DIR = path.join(os.tmpdir(), "pi-claude-plugins", "prompts");
const DEBUG = process.env.PI_CLAUDE_PLUGINS_DEBUG === "1";
const RULE_AUTO_READ_MESSAGE_TYPE = "claude-rule-auto-read";
const RULE_AUTO_READ_MARKER_TYPE = "claude-rule-auto-read-marker";
const CONTEXT_REFERENCE_AUTO_READ_MESSAGE_TYPE = "context-reference-auto-read";
const CONTEXT_REFERENCE_AUTO_READ_MARKER_TYPE = "context-reference-auto-read-marker";
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
  contentHash?: string;
  triggeredByTool: string;
  targetPath: string;
};

type PendingRuleAutoRead = {
  rule: RuleDefinition;
  content: string;
  contentHash: string;
  matchingGlobs: string[];
  targetPath: string;
};

type ContextReferenceSource = {
  path: string;
  realPath: string;
  displayPath: string;
};

type ContextReferenceFile = {
  path: string;
  realPath: string;
  displayPath: string;
  sourcePath: string;
  sourceDisplayPath: string;
  content: string;
};

type ContextReferenceAutoReadMarker = {
  referenceRealPath: string;
  referencePath: string;
  sourcePath: string;
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

function getContextFileCandidates(cwd: string): string[] {
  const projectRoot = path.resolve(cwd);
  return [path.join(projectRoot, "AGENTS.md"), path.join(projectRoot, "CLAUDE.md")];
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

function parseAtReferences(content: string): string[] {
  const references = new Set<string>();
  const matches = content.matchAll(/(^|[\s(])@([^\s)\]>"'`,;:!?]+)/gm);

  for (const match of matches) {
    const reference = match[2]?.trim();
    if (!reference || reference.startsWith("@")) {
      continue;
    }
    references.add(reference);
  }

  return [...references];
}

function resolveContextReferencePath(reference: string, projectRoot: string): string {
  if (path.isAbsolute(reference)) {
    return normalizePath(reference);
  }

  if (reference.startsWith("~/")) {
    return normalizePath(path.join(os.homedir(), reference.slice(2)));
  }

  const relativeReference = normalizeRelativePath(reference);
  return normalizePath(path.resolve(projectRoot, relativeReference));
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

function ruleGlobMatchesPath(rulePathGlob: string, targetRelativePath: string): boolean {
  const normalizedGlob = normalizeRelativePath(rulePathGlob);
  const normalizedTarget = normalizeRelativePath(targetRelativePath);

  if (!GLOB_WILDCARD_RE.test(normalizedGlob)) {
    return normalizedGlob === normalizedTarget;
  }

  if (normalizedGlob.endsWith("/**") && !GLOB_WILDCARD_RE.test(normalizedGlob.slice(0, -3))) {
    const prefix = normalizedGlob.slice(0, -3);
    return normalizedTarget === prefix || normalizedTarget.startsWith(`${prefix}/`);
  }

  return globToRegExp(normalizedGlob).test(normalizedTarget);
}

function getMatchingRuleGlobs(rule: RuleDefinition, targetRelativePath: string): string[] {
  return rule.paths.filter((rulePathGlob) => ruleGlobMatchesPath(rulePathGlob, targetRelativePath));
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

function getAppliedRuleMarkersFromBranch(sessionManager: { getBranch(): unknown[] }): RuleAutoReadMarker[] {
  const applied: RuleAutoReadMarker[] = [];

  for (const entry of sessionManager.getBranch() as Array<Record<string, unknown>>) {
    if (entry?.type !== "custom" || entry.customType !== RULE_AUTO_READ_MARKER_TYPE) {
      continue;
    }

    const data = entry.data as RuleAutoReadMarker | undefined;
    if (
      data &&
      typeof data.ruleRealPath === "string" &&
      typeof data.rulePath === "string" &&
      typeof data.sourcePath === "string"
    ) {
      applied.push({
        ...data,
        ruleRealPath: normalizePath(data.ruleRealPath),
        contentHash: typeof data.contentHash === "string" ? data.contentHash : undefined,
      });
    }
  }

  return applied;
}

async function readRuleContent(rule: RuleDefinition): Promise<string> {
  return await readFile(rule.rulePath, "utf8");
}

function hashRuleContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function discoverContextReferenceSources(cwd: string): Promise<ContextReferenceSource[]> {
  const projectRoot = normalizePath(cwd);
  const candidates = getContextFileCandidates(projectRoot);
  const sources: ContextReferenceSource[] = [];
  const seenRealPaths = new Set<string>();

  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) {
      continue;
    }

    const realCandidatePath = normalizePath(await realpath(candidate));
    if (seenRealPaths.has(realCandidatePath)) {
      continue;
    }

    seenRealPaths.add(realCandidatePath);
    sources.push({
      path: normalizePath(candidate),
      realPath: realCandidatePath,
      displayPath: formatDisplayPath(candidate, cwd),
    });
  }

  return sources;
}

async function discoverContextReferenceFiles(cwd: string): Promise<ContextReferenceFile[]> {
  const sources = await discoverContextReferenceSources(cwd);
  const references: ContextReferenceFile[] = [];
  const visitedRealPaths = new Set<string>(sources.map((source) => source.realPath));
  const queue = [...sources];

  while (queue.length > 0) {
    const source = queue.shift()!;
    const content = await readFile(source.path, "utf8");

    for (const reference of parseAtReferences(content)) {
      const resolvedPath = resolveContextReferencePath(reference, cwd);
      if (!isSameOrDescendant(normalizePath(cwd), resolvedPath)) {
        continue;
      }
      if (!(await fileExists(resolvedPath))) {
        continue;
      }

      const realReferencePath = normalizePath(await realpath(resolvedPath));
      if (visitedRealPaths.has(realReferencePath)) {
        continue;
      }

      visitedRealPaths.add(realReferencePath);
      const referenceContent = await readFile(resolvedPath, "utf8");
      const referenceFile: ContextReferenceFile = {
        path: resolvedPath,
        realPath: realReferencePath,
        displayPath: formatDisplayPath(resolvedPath, cwd),
        sourcePath: source.path,
        sourceDisplayPath: source.displayPath,
        content: referenceContent,
      };
      references.push(referenceFile);
      queue.push({
        path: resolvedPath,
        realPath: realReferencePath,
        displayPath: referenceFile.displayPath,
      });
    }
  }

  return references;
}

function getAppliedContextReferenceMarkersFromBranch(sessionManager: { getBranch(): unknown[] }): ContextReferenceAutoReadMarker[] {
  const applied: ContextReferenceAutoReadMarker[] = [];

  for (const entry of sessionManager.getBranch() as Array<Record<string, unknown>>) {
    if (entry?.type !== "custom" || entry.customType !== CONTEXT_REFERENCE_AUTO_READ_MARKER_TYPE) {
      continue;
    }

    const data = entry.data as ContextReferenceAutoReadMarker | undefined;
    if (
      data &&
      typeof data.referenceRealPath === "string" &&
      typeof data.referencePath === "string" &&
      typeof data.sourcePath === "string"
    ) {
      applied.push({
        ...data,
        referenceRealPath: normalizePath(data.referenceRealPath),
      });
    }
  }

  return applied;
}

function formatContextReferenceAutoReadContextMessage(files: ContextReferenceFile[]): string {
  const sections = files.map((file) => {
    const sourceLine = file.displayPath === file.sourceDisplayPath ? "" : `\nReferenced from: ${file.sourceDisplayPath}`;
    return [`Context file reference auto-read: ${file.displayPath}${sourceLine}`, "", file.content.trim()].join("\n");
  });

  return [
    "Claude context file references were auto-read before this turn.",
    "",
    "This is context material, not a new user request. The full contents of the referenced files are already loaded below; use them as project instructions and supporting context. Do not re-read those files unless the user explicitly asks.",
    "",
    ...sections,
  ].join("\n");
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

function formatReadRulePrefix(rules: PendingRuleAutoRead[]): string {
  const provenance = rules.map(({ rule, matchingGlobs, targetPath }) => {
    const source = rule.displayPath === rule.sourceDisplayPath ? "" : ` → ${rule.sourceDisplayPath}`;
    return `- ${rule.displayPath}${source} via ${matchingGlobs.join(", ")} for ${targetPath}`;
  });
  const sections = rules.map(({ rule, content }) => {
    const source = rule.displayPath === rule.sourceDisplayPath ? "" : `\nSource: ${rule.sourceDisplayPath}`;
    return [`## Rule: ${rule.displayPath}${source}`, "", content.trim()].join("\n");
  });

  return [
    "Claude rules newly loaded for this read:",
    ...provenance,
    "",
    "Treat the following as constraints and guidance. The requested file content follows these rules.",
    "",
    ...sections,
    "",
    "Requested file:",
  ].join("\n");
}

type ContextOverviewRule = Pick<RuleAutoReadMarker, "ruleRealPath" | "rulePath" | "sourcePath" | "triggeredByTool" | "targetPath">;
type ContextOverviewReference = Pick<ContextReferenceAutoReadMarker, "referenceRealPath" | "referencePath" | "sourcePath">;

type ContextOverview = {
  piContextPaths: string[];
  references: ContextOverviewReference[];
  rules: ContextOverviewRule[];
};

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const itemKey = key(item);
    if (seen.has(itemKey)) return false;
    seen.add(itemKey);
    return true;
  });
}

function getContextOverview(ctx: ExtensionCommandContext): ContextOverview {
  // Pi supplies these in the same order it concatenates them into the system prompt.
  const piContextPaths = (ctx.getSystemPromptOptions().contextFiles ?? []).map((file) => file.path);

  const references = uniqueBy(
    getAppliedContextReferenceMarkersFromBranch(ctx.sessionManager)
      .map((marker) => ({
        referenceRealPath: marker.referenceRealPath,
        referencePath: marker.referencePath,
        sourcePath: marker.sourcePath,
      }))
      .sort((a, b) => a.referencePath.localeCompare(b.referencePath)),
    (marker) => marker.referenceRealPath,
  );

  const rules = uniqueBy(
    getAppliedRuleMarkersFromBranch(ctx.sessionManager)
      .map((marker) => ({
        ruleRealPath: marker.ruleRealPath,
        rulePath: marker.rulePath,
        sourcePath: marker.sourcePath,
        triggeredByTool: marker.triggeredByTool,
        targetPath: marker.targetPath,
      }))
      .sort((a, b) => a.rulePath.localeCompare(b.rulePath)),
    (marker) => marker.ruleRealPath,
  );

  return { piContextPaths, references, rules };
}

function buildContextOverviewLines(overview: ContextOverview): string[] {
  const lines: string[] = [];
  const addSection = (title: string, count: number, emptyMessage: string) => {
    if (lines.length > 0) lines.push("");
    lines.push(`${title} (${count})`);
    if (count === 0) lines.push(`  ${emptyMessage}`);
  };

  addSection("Pi context files in the system prompt", overview.piContextPaths.length, "None reported by Pi.");
  for (const contextPath of overview.piContextPaths) {
    lines.push(`  • ${contextPath}`);
  }

  addSection("Claude @file references auto-loaded on this branch", overview.references.length, "No references have been injected.");
  for (const reference of overview.references) {
    const source = reference.referencePath === reference.sourcePath ? "" : ` ← ${reference.sourcePath}`;
    lines.push(`  • ${reference.referencePath}${source}`);
  }

  addSection("Claude path rules auto-loaded on this branch", overview.rules.length, "No rules have been injected.");
  for (const rule of overview.rules) {
    const source = rule.rulePath === rule.sourcePath ? "" : ` → ${rule.sourcePath}`;
    lines.push(`  • ${rule.rulePath}${source} — ${rule.triggeredByTool}: ${rule.targetPath}`);
  }

  return lines;
}

class ContextOverviewComponent {
  private static readonly chromeRows = 7;
  private static readonly verticalMargin = 1;
  private scrollOffset = 0;
  private lines: string[];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly getLines: () => string[],
    private readonly done: () => void,
  ) {
    this.lines = getLines();
  }

  refresh(): void {
    this.lines = this.getLines();
    this.tui.requestRender();
  }

  private refreshLines(): void {
    this.lines = this.getLines();
  }

  private getPageSize(): number {
    const availableRows = this.tui.terminal.rows - ContextOverviewComponent.verticalMargin * 2;
    const maxContentRows = Math.max(1, availableRows - ContextOverviewComponent.chromeRows);
    return Math.min(this.lines.length, maxContentRows);
  }

  handleInput(data: string): void {
    this.refreshLines();
    const pageSize = this.getPageSize();
    const maxOffset = Math.max(0, this.lines.length - pageSize);

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "return")) {
      this.done();
      return;
    }

    if (matchesKey(data, "up")) this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    else if (matchesKey(data, "down")) this.scrollOffset = Math.min(maxOffset, this.scrollOffset + 1);
    else if (matchesKey(data, "pageUp")) this.scrollOffset = Math.max(0, this.scrollOffset - pageSize);
    else if (matchesKey(data, "pageDown")) this.scrollOffset = Math.min(maxOffset, this.scrollOffset + pageSize);
    else if (matchesKey(data, "home")) this.scrollOffset = 0;
    else if (matchesKey(data, "end")) this.scrollOffset = maxOffset;
    else return;

    this.tui.requestRender();
  }

  render(width: number): string[] {
    this.refreshLines();
    const innerWidth = Math.max(1, width - 2);
    const border = (text: string) => this.theme.fg("border", text);
    const pad = (text: string) => {
      const truncated = truncateToWidth(text, innerWidth, "...", true);
      return truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
    };
    const row = (text: string) => `${border("│")}${pad(text)}${border("│")}`;
    const pageSize = this.getPageSize();
    const maxOffset = Math.max(0, this.lines.length - pageSize);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    const visibleLines = this.lines.slice(this.scrollOffset, this.scrollOffset + pageSize);
    const position = this.lines.length > pageSize ? ` ${this.scrollOffset + 1}-${this.scrollOffset + visibleLines.length}/${this.lines.length}` : "";

    const rendered = [
      border(`╭${"─".repeat(innerWidth)}╮`),
      row(` ${this.theme.fg("accent", this.theme.bold("Context overview"))}${this.theme.fg("dim", position)}`),
      row(` ${this.theme.fg("dim", "Pi system context and this branch's automatic Claude injections")}`),
      border(`├${"─".repeat(innerWidth)}┤`),
    ];

    rendered.push(...visibleLines.map((line) => row(line)));
    while (rendered.length < pageSize + 4) rendered.push(row(""));
    rendered.push(border(`├${"─".repeat(innerWidth)}┤`));
    rendered.push(row(` ${this.theme.fg("dim", "↑↓ scroll • PgUp/PgDn page • Home/End • Enter/Esc close")}`));
    rendered.push(border(`╰${"─".repeat(innerWidth)}╯`));
    return rendered;
  }

  invalidate(): void {}
}

export default function claudeMarketplaceSkills(pi: ExtensionAPI) {
  let activeContextOverview: ContextOverviewComponent | undefined;

  pi.registerCommand("claude-context", {
    description: "Show Pi context files and Claude files auto-loaded on this branch",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/claude-context is available in interactive Pi sessions only.", "info");
        return;
      }

      let component: ContextOverviewComponent | undefined;
      try {
        await ctx.ui.custom<void>(
          (tui, theme, _keybindings, done) => {
            component = new ContextOverviewComponent(
              tui,
              theme,
              () => buildContextOverviewLines(getContextOverview(ctx)),
              done,
            );
            activeContextOverview = component;
            return component;
          },
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: "75%",
              minWidth: 50,
              // This is clamped to the available terminal height on every render.
              maxHeight: "100%",
              margin: 1,
            },
          },
        );
      } finally {
        if (activeContextOverview === component) {
          activeContextOverview = undefined;
        }
      }
    },
  });

  let activeRuleIndex: RuleMatchIndex = {
    rulesDir: getProjectClaudeRulesDir(process.cwd()),
    rules: [],
    exactPathRules: new Map(),
    prefixRules: [],
    wildcardRules: [],
    matchCache: new Map(),
  };
  let currentTurnPendingRulePaths = new Set<string>();
  let pendingReadRules = new Map<string, PendingRuleAutoRead[]>();

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
      pendingReadRules = new Map();
      await refreshRuleIndex(ctx.cwd);

      const resources = await discoverResources(ctx.cwd);
      const skillCount = resources.skillPaths.length;
      const promptCount = resources.promptPaths.length;
      const message =
        skillCount > 0 || promptCount > 0
          ? `[claude-marketplace-skills] Loaded ${skillCount} skill file${skillCount === 1 ? "" : "s"} and ${promptCount} command file${promptCount === 1 ? "" : "s"} from Claude plugins, skills, and commands`
          : `[claude-marketplace-skills] No enabled skill or command files found in Claude plugins, skills, or commands`;

      if (ctx.hasUI) {
        ctx.ui.notify(message, skillCount > 0 || promptCount > 0 ? "info" : "warning");
      } else {
        console.log(`${message}\n`);
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
      if (ctx.hasUI) {
        ctx.ui.notify(message, "error");
      } else {
        console.log(`${message}\n`);
      }
    }
  });

  pi.on("resources_discover", async (event) => {
    return await discoverResources(event.cwd);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    try {
      const referencedFiles = await discoverContextReferenceFiles(ctx.cwd);
      if (referencedFiles.length === 0) {
        return;
      }

      const appliedReferenceMarkers = getAppliedContextReferenceMarkersFromBranch(ctx.sessionManager);
      const appliedReferenceRealPaths = new Set(appliedReferenceMarkers.map((marker) => marker.referenceRealPath));
      const filesToInject = referencedFiles.filter((file) => !appliedReferenceRealPaths.has(file.realPath));
      if (filesToInject.length === 0) {
        return;
      }

      pi.sendMessage(
        {
          customType: CONTEXT_REFERENCE_AUTO_READ_MESSAGE_TYPE,
          content: formatContextReferenceAutoReadContextMessage(filesToInject),
          display: false,
          details: {
            paths: filesToInject.map((file) => file.displayPath),
          },
        },
        { deliverAs: "steer" },
      );

      for (const file of filesToInject) {
        pi.appendEntry<ContextReferenceAutoReadMarker>(CONTEXT_REFERENCE_AUTO_READ_MARKER_TYPE, {
          referenceRealPath: file.realPath,
          referencePath: file.displayPath,
          sourcePath: file.sourceDisplayPath,
        });
      }
      activeContextOverview?.refresh();

    } catch (error) {
      const message = `[claude-marketplace-skills] Failed to expand Claude context file references: ${(error as Error).message}`;
      if (ctx.hasUI) {
        ctx.ui.notify(message, "warning");
      } else {
        console.log(`${message}\n`);
      }
    }
  });

  pi.on("turn_start", async () => {
    currentTurnPendingRulePaths = new Set();
    pendingReadRules = new Map();
  });

  pi.on("turn_end", async () => {
    currentTurnPendingRulePaths = new Set();
    pendingReadRules = new Map();
  });

  pi.on("tool_result", async (event) => {
    const rules = pendingReadRules.get(event.toolCallId);
    if (!rules) {
      return;
    }

    pendingReadRules.delete(event.toolCallId);
    for (const pendingRule of rules) {
      pi.appendEntry<RuleAutoReadMarker>(RULE_AUTO_READ_MARKER_TYPE, {
        ruleRealPath: pendingRule.rule.realPath,
        rulePath: pendingRule.rule.displayPath,
        sourcePath: pendingRule.rule.sourceDisplayPath,
        contentHash: pendingRule.contentHash,
        triggeredByTool: "read",
        targetPath: pendingRule.targetPath,
      });
    }
    activeContextOverview?.refresh();

    return {
      content: [{ type: "text", text: formatReadRulePrefix(rules) }, ...event.content],
    };
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

    const appliedContextReferenceMarkers = getAppliedContextReferenceMarkersFromBranch(ctx.sessionManager);
    const redundantContextReferenceReads = appliedContextReferenceMarkers.filter(
      (marker) => absoluteTargetPath === marker.referenceRealPath || absoluteTargetPath === normalizePath(path.resolve(ctx.cwd, marker.referencePath)),
    );
    if (event.toolName === "read" && redundantContextReferenceReads.length > 0) {
      const referenceLines = redundantContextReferenceReads.map((marker) => `- ${marker.referencePath}`).join("\n");
      return {
        block: true,
        reason: `This Claude context reference file was already auto-read into context for the current branch:\n${referenceLines}\n\nDo not re-read it unless the user explicitly asks.`,
      };
    }

    const appliedRuleMarkers = getAppliedRuleMarkersFromBranch(ctx.sessionManager);
    const redundantRuleReads = appliedRuleMarkers.filter(
      (marker) => absoluteTargetPath === normalizePath(path.resolve(ctx.cwd, marker.rulePath)) || absoluteTargetPath === normalizePath(path.resolve(ctx.cwd, marker.sourcePath)),
    );
    if (event.toolName === "read" && redundantRuleReads.length > 0) {
      const ruleLines = redundantRuleReads.map((marker) => `- ${marker.rulePath}`).join("\n");
      return {
        block: true,
        reason: `This Claude rule file was already auto-read into context for the current branch:\n${ruleLines}\n\nDo not re-read it unless the user explicitly asks.`,
      };
    }

    const matchingRules = getMatchingRules(activeRuleIndex, relativeTargetPath);
    if (matchingRules.length === 0) {
      return;
    }

    const rulesToInject: PendingRuleAutoRead[] = [];
    for (const rule of matchingRules) {
      if (currentTurnPendingRulePaths.has(rule.realPath)) {
        continue;
      }

      const content = await readRuleContent(rule);
      const contentHash = hashRuleContent(content);
      const alreadyApplied = appliedRuleMarkers.some(
        (marker) => marker.ruleRealPath === rule.realPath && (marker.contentHash === undefined || marker.contentHash === contentHash),
      );
      if (alreadyApplied) {
        continue;
      }

      currentTurnPendingRulePaths.add(rule.realPath);
      rulesToInject.push({
        rule,
        content,
        contentHash,
        matchingGlobs: getMatchingRuleGlobs(rule, relativeTargetPath),
        targetPath: relativeTargetPath,
      });
    }

    if (rulesToInject.length === 0) {
      return;
    }

    if (event.toolName === "read") {
      pendingReadRules.set(event.toolCallId, rulesToInject);
      if (DEBUG) {
        console.log(
          `[claude-marketplace-skills] Loading ${rulesToInject.length} Claude rule file${rulesToInject.length === 1 ? "" : "s"} with read: ${rulesToInject.map(({ rule }) => rule.displayPath).join(", ")} for ${relativeTargetPath}\n`,
        );
      }
      return;
    }

    for (const pendingRule of rulesToInject) {
      pi.appendEntry<RuleAutoReadMarker>(RULE_AUTO_READ_MARKER_TYPE, {
        ruleRealPath: pendingRule.rule.realPath,
        rulePath: pendingRule.rule.displayPath,
        sourcePath: pendingRule.rule.sourceDisplayPath,
        contentHash: pendingRule.contentHash,
        triggeredByTool: event.toolName,
        targetPath: relativeTargetPath,
      });
    }
    activeContextOverview?.refresh();

    if (DEBUG) {
      console.log(
        `[claude-marketplace-skills] Auto-read ${rulesToInject.length} Claude rule file${rulesToInject.length === 1 ? "" : "s"} before ${event.toolName}: ${rulesToInject.map(({ rule }) => rule.displayPath).join(", ")} for ${relativeTargetPath}\n`,
      );
    }

    for (const pendingRule of rulesToInject) {
      pi.sendMessage(
        {
          customType: RULE_AUTO_READ_MESSAGE_TYPE,
          content: formatRuleAutoReadContextMessage(
            pendingRule.rule,
            event.toolName,
            relativeTargetPath,
            pendingRule.content,
          ),
          display: false,
          details: {
            rulePath: pendingRule.rule.displayPath,
            sourcePath: pendingRule.rule.sourceDisplayPath,
            targetPath: relativeTargetPath,
            toolName: event.toolName,
          },
        },
        { deliverAs: "steer" },
      );
    }

    const injectedRuleLines = rulesToInject.map(({ rule }) => `- ${rule.displayPath}`).join("\n");
    return {
      block: true,
      reason: `Auto-read Claude rules for ${relativeTargetPath}:\n${injectedRuleLines}\n\nRetry now that these rules are already in context.`,
    };
  });
}
