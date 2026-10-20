# Automation Builder — Claude Code plugin marketplace

This repository is a Claude Code **plugin marketplace** containing one plugin, `automation-builder`: an agentic
Playwright pipeline. You supply test cases; it checks the environment, asks only for missing setup, explores the app,
generates Playwright tests, reviews and runs them, classifies failures, repairs eligible script defects within strict
limits, and writes an auditable report.

## Install

Push this folder to a git host (e.g. GitHub), then in Claude Code:

```
/plugin marketplace add <owner>/<repo>                 # GitHub
/plugin marketplace add https://gitlab.com/org/repo.git  # any git URL
/plugin marketplace add ./automation-builder-plugin      # local folder (for testing)

/plugin install automation-builder@automation-builder-marketplace
```

Or from a shell: `claude plugin marketplace add <owner>/<repo>` then
`claude plugin install automation-builder@automation-builder-marketplace`.

Teams can auto-offer it by adding to the project's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "automation-builder-marketplace": { "source": { "source": "github", "repo": "<owner>/<repo>" } }
  },
  "enabledPlugins": { "automation-builder@automation-builder-marketplace": true }
}
```

## Use

In the project you want to test (Node 24+ required):

```
/automation-builder:init                                  # scaffold the framework (installs nothing)
/automation-builder:playwright-pipeline input/test-cases/login.md
```

See [plugins/automation-builder/README.md](plugins/automation-builder/README.md) for all commands.

## Layout

```
.claude-plugin/marketplace.json        marketplace catalog
plugins/automation-builder/
  .claude-plugin/plugin.json           plugin manifest
  skills/                              commands (/automation-builder:<name>) + knowledge skills
  agents/                              six stage subagents
  scripts/init.mjs                     project scaffolder used by /automation-builder:init
  template/                            framework files copied into the user's project
```

## Releasing a new version

Bump `version` in both `plugins/automation-builder/.claude-plugin/plugin.json` and the entry in
`.claude-plugin/marketplace.json`, then push. Users get it via `/plugin marketplace update` and run
`/automation-builder:init --update` in their project to refresh the engine files. Validate before pushing:
`claude plugin validate .`
