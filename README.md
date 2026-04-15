# pi-claude-plugins

A [pi](https://github.com/badlogic/pi-mono) extension that imports **enabled Claude plugin resources, Claude skills, Claude commands, and Claude path rules** into the current pi session.

It bridges Claude resources into pi by exposing:

- **skills** as pi skills
- **command markdown files** as pi prompt templates / slash commands
- **Claude rules** as deterministic pre-read context for matching file paths

The extension only loads plugins that are currently enabled in Claude after checking both:

- `~/.claude/plugins/installed_plugins.json`
- `~/.claude/settings.json`

It can also filter bridged plugins and resources with a package-local config file:

- `claude-plugin-bridge.json`

## What gets loaded

### Skills

The extension loads skill files from both enabled Claude plugin install paths and standalone Claude skill folders matching:

- enabled plugin install paths: `**/skills/*/SKILL.md`
- user Claude skills: `~/.claude/skills/*/SKILL.md`
- project Claude skills: `<cwd>/.claude/skills/*/SKILL.md`

These are returned to pi as `skillPaths` through the `resources_discover` hook.

### Command markdown files

The extension also loads command markdown files from:

- enabled plugin install paths: `**/commands/*.md`
- user Claude commands: `~/.claude/commands/*.md`
- project Claude commands: `<cwd>/.claude/commands/*.md`

These are returned to pi as `promptPaths`, so they show up like pi prompt templates / slash commands.

Before exposing Claude commands to pi, the extension writes sanitized temporary copies with pi-compatible frontmatter. This preserves Claude-specific command files while avoiding prompt-template parse failures from Claude-only frontmatter syntax.

### Claude rules

The extension scans project Claude rules from:

- `<cwd>/.claude/rules/**/*.md`

Rule files can be symlinked files. Their markdown frontmatter may declare:

```yaml
paths:
  - "flow/**/*.py"
  - "tests/**"
```

When the model uses `read`, `edit`, or `write` on a matching file path, the extension auto-reads each matching rule into context before the file operation proceeds.

- rule file discovery and frontmatter path indexing refresh on `/reload`
- rule markdown content itself is read fresh at trigger time, so content-only edits do not require `/reload`

## Install

```bash
pi install npm:pi-claude-plugins
```

## Remove

```bash
pi remove npm:pi-claude-plugins
```

## How plugin enablement works

The extension does **not** load every plugin found on disk.
It first reads:

- `~/.claude/plugins/installed_plugins.json`
- `~/.claude/settings.json`

A plugin is loaded only if:

- it exists in `installed_plugins.json`
- it matches the current scope (`user` or current project)
- it is **not** explicitly disabled in `settings.json`

If `~/.claude/settings.json` contains:

```json
{
  "enabledPlugins": {
    "playwright-cli@playwright-cli": false
  }
}
```

then that plugin is ignored completely, even if it is installed.

### Plugin key format

Claude's installed plugins file uses keys like:

- `planning-with-files@planning-with-files`
- `frontend-design@claude-plugins-official`
- `playwright-cli@playwright-cli`

This extension uses `installed_plugins.json` as the source of truth. If a plugin key is enabled for the current scope, the extension scans that install entry's `installPath` directly, then applies any filters from `claude-plugin-bridge.json`.

This makes it work for:

- official marketplace plugins
- git-based or private marketplaces
- cached plugin installs
- project-scoped installs with nonstandard marketplace directory names

## Bridge config

You can commit a `claude-plugin-bridge.json` file in the package root to whitelist or blacklist bridged Claude plugins and individual resources.

Example:

```json
{
  "mode": "allow-all",
  "allowPlugins": [],
  "denyPlugins": ["superpowers@claude-plugins-official"],
  "allowResources": [],
  "denyResources": ["subagent-driven-development"]
}
```

### Config fields

- `mode`
  - `allow-all` → load everything by default, then apply deny lists
  - `deny-all` → load nothing by default, then only load explicit allow-list matches
- `allowPlugins`
  - plugin keys such as `in-the-loop-tools@in-the-loop-tools`
- `denyPlugins`
  - plugin keys such as `superpowers@claude-plugins-official`
- `allowResources`
  - skill names like `brainstorming`
  - command names like `gc`
  - command filenames like `gc.md`
- `denyResources`
  - same matching rules as `allowResources`

### Precedence

- explicit allow beats explicit deny
- plugin filtering happens before resource discovery within that plugin install
- resource filtering applies to discovered skills, commands, and Claude rule filenames

## Scope rules

`installed_plugins.json` can contain both user-scoped and project-scoped plugin installs.

This extension respects that:

- **user** scope → always loaded
- **project** scope → only loaded when the current pi working directory is inside that `projectPath`

So if a Claude plugin is enabled only for one project, this extension will only expose it in pi when you are inside that same project tree.

## Ignored paths

The extension intentionally ignores:

- hidden files and directories (`.`-prefixed)
- `node_modules/`
- `build/`
- `dist/`
- `out/`
- symlinked directories
- symlinked files during plugin / skill / command discovery

Exception: project Claude rule files under `.claude/rules/` may be symlinked files and are followed intentionally.

This avoids duplicate, generated, or unrelated content being imported while still supporting symlink-based rule workflows.

## Runtime behavior

On startup and on `/reload`, the extension:

1. reads `~/.claude/plugins/installed_plugins.json`
2. reads `~/.claude/settings.json`
3. determines which Claude plugins are enabled for the current pi cwd
4. loads `claude-plugin-bridge.json` from the package root
5. scans each enabled plugin install path for supported skill and command files
6. scans standalone Claude skill folders from `~/.claude/skills` and `<cwd>/.claude/skills`
7. scans standalone Claude command folders from `~/.claude/commands` and `<cwd>/.claude/commands`
8. indexes project Claude rule files from `<cwd>/.claude/rules`
9. filters out anything blocked by Claude settings or the bridge config
10. returns the remaining skills / commands to pi via `resources_discover`

For Claude rules, the extension also intercepts `read`, `edit`, and `write` tool calls. If a target path matches a rule's frontmatter `paths` globs, the extension:

1. emits one chat-visible audit message per matched rule file
2. injects the rule markdown into model context as a hidden context message
3. explicitly frames that injected content as rule/context material rather than a new user request
4. blocks the current file operation once
5. lets the agent retry with the rules already in context

Rule auto-reads are deduplicated per active branch, so rewinding to earlier history can re-trigger them when appropriate. If the model later tries to `read` a rule file that was already auto-read in the current branch, the extension blocks that redundant read and points back to the already-applied rule paths.

The extension also prints and notifies a summary like:

- number of loaded skill files
- number of loaded command markdown files

## Why some Claude resources may still not appear

Even when a file exists on disk, it will not be loaded if:

- the plugin is not present / enabled in `installed_plugins.json`
- the plugin is explicitly disabled in `~/.claude/settings.json`
- the plugin is project-scoped for a different project
- the file is outside the supported `skills/*/SKILL.md` or `commands/*.md` path patterns within an installed plugin
- the standalone Claude skill is outside `~/.claude/skills/*/SKILL.md` or `<cwd>/.claude/skills/*/SKILL.md`
- the standalone Claude command is outside `~/.claude/commands/*.md` or `<cwd>/.claude/commands/*.md`
- the file is blocked by `claude-plugin-bridge.json`
- the file is inside a hidden/ignored directory
- a Claude rule exists but its `paths` globs do not match the file being read or modified

## Skill collisions and validation warnings

This extension forwards Claude plugin resources into pi, but **pi still applies its own resource rules**.

That means:

- pi skill names must still be unique within the session
- pi may skip colliding skills if multiple files declare the same `name:` in frontmatter
- pi may emit warnings if a skill's `name` does not match its parent directory

These warnings come from pi's skill loader, not from this extension itself.

## Limitations

- This extension does not execute Claude plugin hooks or plugin runtime logic
- It imports filesystem resources that map cleanly into pi:
  - skills (`SKILL.md`)
  - command markdown files (`*.md` in `commands/`)
  - project Claude rules (`.claude/rules/**/*.md`) as extension-managed context injections
- It does not import arbitrary plugin code, agents, hooks, or non-markdown command formats
- Claude rule auto-read currently triggers only for `read`, `edit`, and `write` tool calls
- It does not attempt to infer rule triggers from `bash`, `grep`, `find`, or `ls`
- It does not import or bridge Claude plugin MCP integrations / MCP servers

## When to reload

Run `/reload` in pi after:

- editing `claude-plugin-bridge.json`
- enabling or disabling Claude plugins
- changing `~/.claude/plugins/installed_plugins.json`
- changing `~/.claude/settings.json`
- installing or updating Claude plugins
- adding or removing skill / command markdown files in installed Claude plugins
- adding or removing standalone skills under `~/.claude/skills` or project `.claude/skills`
- adding or removing standalone commands under `~/.claude/commands` or project `.claude/commands`
- editing project Claude rules under `<cwd>/.claude/rules`

Rule of thumb:
- changed rule file set, symlinks, or frontmatter `paths` → run `/reload`
- changed only rule body content → no reload needed; the next trigger reads the latest file contents

## Files

- Extension entry point: `extensions/index.ts`
- Package manifest: `package.json`
- Bridge config: `claude-plugin-bridge.json`

## License

MIT
