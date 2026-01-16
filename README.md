# `cco`  Claude Code Orchestrator

> [!NOTE]
> This project is in early development and is not published to npm yet.

Orchestrate multiple Claude Code instances to work collaboratively on software projects. This is intended for **very long horizon tasks** that require parallelization and coordination among AI agents. Tasks like building a full-stack application, refactoring a large codebase, or implementing complex features.

`cco` is designed to be completely hands-off once started, with automatic management of git branches, worktrees, and Claude instances. The only requirement is to provide high-level project goals in `PROJECT_DIRECTION.md`.

## Overview

Spawns parallel Claude Code instances using a hierarchical coordination model:

- **Director** - Coordinates Engineering Managers and merges to main branch
- **Engineering Managers (EMs)** - Lead teams of workers, curate team branches
- **Workers** - Execute tasks in isolated git worktrees

## Installation

Requirements: Node.js 22+, git, [Claude Code CLI](https://github.com/anthropics/claude-code)

```bash
npm install -g @mohsen/claude-code-orchestrator
```

Start an orchestration session using the interactive CLI:

```bash
cco start
```

## Usage with Configuration File

1. Create a configuration directory (e.g., `my-config/`)
2. Add `orchestrator.json` (see Configuration section)
3. (Optional) Add `api-keys.json` for API key authentication
4. Start the orchestrator:
    ```bash
    # Start
    cco start --config ./my-config
    ```

## Configuration

### `orchestrator.json`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `repositoryUrl` | string | required | Git repository URL |
| `branch` | string | `"main"` | Base branch |
| `workerCount` | number | required | Worker instances (1-20) |
| `useRunBranch` | boolean | `false` | Create `run/YYYY-MM-DD-HH-MM` isolation branch |
| `authMode` | string | `"oauth"` | `oauth`, `api-keys-first`, or `api-keys-only` |
| `logDirectory` | string | config path | Log storage location |
| `model` | string | - | Claude model (`haiku`, `sonnet`, `opus`) |
| `engineerManagerGroupSize` | number | `4` | Max workers per EM |
| `maxRunDurationMinutes` | number | `120` | Max run duration |

### `api-keys.json` (optional)

For rate limit rotation cco offers two authentication modes: OAuth and API keys. By default, it uses OAuth (your regular Claude CLI auth). To use API keys, create an `api-keys.json` file with the following structure:

```json
[
  { "name": "key-1", "apiKey": "sk-ant-..." },
  { "name": "key-2", "apiKey": "sk-ant-..." }
]
```

Note: You can include multiple keys for rotation, and cco will switch keys upon hitting rate limits.

## Authentication Modes

| Mode | Description |
|------|-------------|
| `oauth` | Start with CLI auth, rotate to API keys if rate limited |
| `api-keys-first` | Start with API keys, fall back to OAuth |
| `api-keys-only` | Only use API keys |

## Target Repository Setup

Add these files to your target repository:

- `PROJECT_DIRECTION.md` - High-level goals for the Director/Manager
- `TEAM_STRUCTURE.md` - Auto-managed task assignments. cco creates and updates this file.
- `.env` / `.env.local` - Automatically copied to all worktrees

## Logs

Each run creates a timestamped folder with:

- `combined.log` - Orchestrator events and worker outputs

## Pausing and Resuming
Pause the orchestrator (stops all instances):

```bash
cco pause --config ./my-config
``` 
Resume the orchestrator:

```bash
cco resume --config ./my-config
```

## Cleanup

Remove temporary worktrees and workspace files:

```bash
cco cleanup --config ./my-config
```

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for contributing and development setup.

## License

MIT
