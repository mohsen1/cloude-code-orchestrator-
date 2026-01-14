# Claude Code Orchestrator

A distributed system for orchestrating multiple Claude Code instances to work collaboratively on software projects.

## Overview

The orchestrator spawns multiple Claude Code instances that work in parallel on a shared codebase. A Director coordinates Engineering Managers (EMs), and each EM commands a team of Workers operating in isolated git worktrees. Workers complete tasks, push to their branches, EMs curate their team branches, and the Director merges strategic changes back to the main branch.

## Features

- Director/Engineering Manager/Worker hierarchy with event-driven coordination
- Git worktree isolation for parallel development
- Automatic rate limit detection and config rotation
- OAuth and API key authentication support
- Health monitoring and stuck detection
- Cost tracking and usage limits

## Quick Start

```bash
# Install dependencies
npm install

# Run (npm start auto-builds the orchestrator + web UI)
npm start -- --config ./config
```

## Web Dashboard (Next.js)

The orchestrator now serves a Tailwind + shadcn/ui dashboard at `http://localhost:<serverPort>/ui`, so you can inspect the live Claude hierarchy without attaching to tmux.

1. Install the web workspace deps once:
  ```bash
  cd web && npm install
  ```
2. Develop the UI with hot reload on an alternate port to avoid clashing with the hook server:
  ```bash
  NEXT_PUBLIC_ORCHESTRATOR_API=http://localhost:3000 npm run dev:web -- --port 4000
  ```
  The env var teaches the Next dev server where to fetch `/api/session/current`. The hook server allows cross-origin GETs, so browser requests from port 4000 succeed.
3. Build the static assets so the orchestrator can serve them:
  ```bash
  npm run build:web
  ```
  This runs `next build && next export` and writes to `web/out/ui`. The hook server automatically serves those files at `/ui` the next time you start `npm start`.
  (Optional) `npm start` now runs this export step automatically; invoke it manually only when iterating on the UI without starting the orchestrator.
4. (Optional) Point the orchestrator at a different export folder by setting `ORCHESTRATOR_UI_DIR=/abs/path/to/out/ui` before launching.

The dashboard consumes the new `/api/session/current` endpoint (served by the hook server) to stream instance status, team queues, auth rotation state, and recent log file paths.

## Configuration

Create a config directory with the following files:

### orchestrator.json (required)

```json
{
  "repositoryUrl": "https://github.com/org/repo.git",
  "branch": "main",
  "workerCount": 2
}
```

### Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `repositoryUrl` | string | *required* | URL of the git repository to work on |
| `branch` | string | `"main"` | Branch to check out and work from |
| `logDirectory` | string | `config directory` | Where per-run logs are stored. Paths are resolved relative to the config directory. Each orchestrator launch creates a timestamped folder that captures orchestrator logs plus tmux session output. |
| `cloneDepth` | number | *none* | Shallow clone depth (e.g., `1` for latest commit only) |
| `model` | string | *none* | Claude model to use (`haiku`, `sonnet`, `opus`) |
| `authMode` | string | `"oauth"` | Auth startup mode: `oauth`, `api-keys-first`, or `api-keys-only` |
| `envFiles` | string[] | *none* | Paths to env files to copy to each worktree (see [Environment Files](#environment-files)) |
| `workerCount` | number | *required* | Number of worker instances (1-20) |
| `engineerManagerGroupSize` | number | `4` | Maximum workers per Engineering Manager team (1-8). If `workerCount` exceeds this value the Director/EM hierarchy is enabled; otherwise the legacy manager→worker flow runs. |
| `serverPort` (`hookServerPort`) | number | `3000` | Port for the internal hook server (1024-65535). `hookServerPort` is kept for backward compatibility. |
| `healthCheckIntervalMs` | number | `30000` | Health check polling interval in milliseconds (min: 5000) |
| `rateLimitCheckIntervalMs` | number | `10000` | Rate limit detection interval in milliseconds (min: 5000) |
| `stuckThresholdMs` | number | `300000` | Time without tool use before instance is considered stuck (min: 60000) |
| `managerHeartbeatIntervalMs` | number | `600000` | Director heartbeat interval in milliseconds (min: 60000, default: 10 min) |
| `maxToolUsesPerInstance` | number | `500` | Maximum tool invocations per instance before stopping (min: 100) |
| `maxTotalToolUses` | number | `2000` | Maximum total tool invocations across all instances (min: 500) |
| `maxRunDurationMinutes` | number | `120` | Maximum orchestrator run time in minutes (min: 10) |

### Run Logs

Set `logDirectory` to control where the orchestrator writes logs. If omitted, the config directory is used. Every launch creates a timestamped folder (for example, `run-2026-01-14T06-59-00Z/`) that captures:

- `combined.log` / `error.log` from the orchestrator and hook server
- One file per tmux session (e.g., `session-director.log`, `session-worker-1.log`)

These files grow for the lifetime of the run so you can audit every command Claude executed.

### Director/Engineering Manager hierarchy

Set `engineerManagerGroupSize` to control how many workers each EM may supervise. When `workerCount` is greater than this cap, the Director automatically creates enough EM teams to cover `workerCount`, resizes rosters after every escalation, and can kill or respawn teams when they underperform. When `workerCount` is less than or equal to the cap, the orchestrator remains in the simpler Manager/Worker mode. Each EM-enabled team owns an EM-specific branch (e.g., `team-1-main`) plus worker branches (`worker-1`, `worker-2`, ...). Keep `TEAM_STRUCTURE.md`, `EM_<id>_TASKS.md`, and `WORKER_<id>_TASK_LIST.md` in your repo so Claude can coordinate work between layers.

### auth-configs.json (optional, for rate limit rotation)

Configure API keys for rate limit rotation. Legacy name `api-keys.json` is still accepted. Each entry specifies environment variables to apply.

```json
[
  { "name": "key-1", "env": { "ANTHROPIC_API_KEY": "sk-ant-..." } },
  { "name": "z.ai-1", "env": { "ANTHROPIC_AUTH_TOKEN": "...", "ANTHROPIC_BASE_URL": "..." } }
]
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Identifier for this API key config |
| `env` | Yes | Environment variables to apply (e.g., `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`) |

### Authentication modes

Control how the orchestrator starts and rotates auth:

- `oauth` (default): Start with OAuth, rotate to API keys on rate limits.
- `api-keys-first`: Start with the first entry in `auth-configs.json`, fall back to OAuth when the pool wraps.
- `api-keys-only`: Always use API keys. Requires `auth-configs.json`; the orchestrator will exit if none are provided.

Example `orchestrator.json` using keys first:

```json
{
  "repositoryUrl": "https://github.com/org/repo.git",
  "branch": "main",
  "workerCount": 2,
  "authMode": "api-keys-first"
}
```

Example `auth-configs.json`:

```json
[
  { "name": "primary-key", "env": { "ANTHROPIC_API_KEY": "sk-ant-..." } },
  { "name": "zai", "env": { "ANTHROPIC_AUTH_TOKEN": "...", "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic" } }
]
```

## Architecture

```
Orchestrator (Node.js)
    |
    +-- Hook Server (Express) <-- receives events from Claude instances
    |
    +-- Director Instance (tmux + claude)
    |       +-- Sets strategy, merges EM branches, resizes teams
    |
    +-- Engineering Manager 1 (worktree: team-1)
    |       +-- Manages workers 1-4, maintains EM_1_TASKS.md, merges worker branches
    |
    +-- Engineering Manager 2 (worktree: team-2)
        +-- Manages workers 5-8 (etc.)

  Workers (tmux + claude, worktrees worker-N)
    +-- Read WORKER_N_TASK_LIST.md, execute tasks, commit, push
```

## Rate Limit Rotation

When running locally, the orchestrator automatically rotates authentication when rate limited:

1. OAuth (default, uses ~/.claude/settings.json)
2. API Key 1 from api-keys.json
3. API Key 2 from api-keys.json
4. Back to OAuth (after cooldown)

## Repository Setup

Your target repository should include a `PROJECT_DIRECTION.md` file that describes what to build. The Manager reads this file and creates task lists for workers.

### Environment Files

The orchestrator copies environment files to the main workspace and each worker's worktree. This ensures secrets and environment variables are available in all parallel workspaces without being committed to git.

**Automatic copying from workspace:**
- `.env` - Main environment variables
- `.env.local` - Local overrides

**External files via config:**

Use `envFiles` in your orchestrator.json to copy secrets from outside the repository:

```json
{
  "repositoryUrl": "https://github.com/org/repo.git",
  "branch": "main",
  "workerCount": 4,
  "envFiles": [
    "/Users/me/secrets/.env.local",
    "/Users/me/secrets/database.env"
  ]
}
```

This copies the specified files to:
- Main workspace (for Manager)
- Each worker worktree (worker-1, worker-2, etc.)

Files are copied (not symlinked) to maintain isolation between worktrees.

Example PROJECT_DIRECTION.md:

```markdown
# Project Direction

Build a REST API with the following endpoints:
- GET /users - list all users
- POST /users - create a user
- GET /users/:id - get a user

Use Express.js and TypeScript. Include tests.
```

## Commands

```bash
npm start       # Run orchestrator
npm run dev     # Run with tsx (no build needed)
npm run build   # Compile TypeScript
npm test        # Run tests
```

## Scripts

```bash
./scripts/cleanup.sh    # Clean orphaned tmux sessions and workspace
```

## Requirements

- Node.js 22+
- tmux
- git
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)

## License

MIT
