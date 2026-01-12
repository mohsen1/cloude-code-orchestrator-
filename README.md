# Claude Code Orchestrator

A distributed system for orchestrating multiple Claude Code instances to work collaboratively on software projects.

## Overview

The orchestrator spawns multiple Claude Code instances that work in parallel on a shared codebase. A Manager instance delegates tasks to Worker instances, each operating in isolated git worktrees. Workers complete tasks, push to their branches, and the Manager merges changes back to main.

## Features

- Manager/Worker architecture with event-driven coordination
- Git worktree isolation for parallel development
- Automatic rate limit detection and config rotation
- OAuth and API key authentication support
- Health monitoring and stuck detection
- Cost tracking and usage limits

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run (uses host OAuth by default, or auth-configs.json for rotation)
npm start -- --config ./config
```

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
| `cloneDepth` | number | *none* | Shallow clone depth (e.g., `1` for latest commit only) |
| `workerCount` | number | *required* | Number of worker instances (1-20) |
| `hookServerPort` | number | `3000` | Port for the internal hook server (1024-65535) |
| `healthCheckIntervalMs` | number | `30000` | Health check polling interval in milliseconds (min: 5000) |
| `rateLimitCheckIntervalMs` | number | `10000` | Rate limit detection interval in milliseconds (min: 5000) |
| `stuckThresholdMs` | number | `300000` | Time without tool use before instance is considered stuck (min: 60000) |
| `managerHeartbeatIntervalMs` | number | `600000` | Manager heartbeat interval in milliseconds (min: 60000, default: 10 min) |
| `maxToolUsesPerInstance` | number | `500` | Maximum tool invocations per instance before stopping (min: 100) |
| `maxTotalToolUses` | number | `2000` | Maximum total tool invocations across all instances (min: 500) |
| `maxRunDurationMinutes` | number | `120` | Maximum orchestrator run time in minutes (min: 10) |

### api-keys.json (optional, for rate limit rotation)

Configure API keys for rate limit rotation. Each entry specifies environment variables to apply.

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

## Architecture

```
Orchestrator (Node.js)
    |
    +-- Hook Server (Express) <-- receives events from Claude instances
    |
    +-- Manager Instance (tmux + claude)
    |       |
    |       +-- Reads PROJECT_DIRECTION.md
    |       +-- Creates WORKER_N_TASK_LIST.md files
    |       +-- Merges worker branches
    |
    +-- Worker 1 (tmux + claude, worktree: worker-1)
    |       +-- Reads task list, executes, commits, pushes
    |
    +-- Worker 2 (tmux + claude, worktree: worker-2)
            +-- Reads task list, executes, commits, pushes
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

The orchestrator automatically copies `.env` and `.env.local` files from the main repository to each worker's worktree. This ensures environment variables are available in all parallel workspaces.

Supported env files:
- `.env` - Main environment variables
- `.env.local` - Local overrides (not committed to git)

These files are copied (not symlinked) to maintain isolation between worktrees.

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
