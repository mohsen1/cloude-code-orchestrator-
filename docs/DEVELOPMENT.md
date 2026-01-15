# Development Guide

This guide covers setting up and contributing to the Claude Code Orchestrator project.

## Prerequisites

- Node.js 22+
- `tmux`
- `git`
- [Claude Code CLI](https://github.com/anthropics/claude-code) (`npm install -g @anthropic-ai/claude-code`)

## Setup

```bash
git clone https://github.com/mohsen/claude-code-orchestrator.git
cd claude-code-orchestrator
npm install
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Run directly with tsx (development mode) |
| `npm run build` | Compile TypeScript to dist/ |
| `npm start` | Run using compiled files |
| `npm test` | Run unit and integration tests |

## Project Structure

```
src/
├── index.ts              # Main entry point
├── server.ts             # Hook server for Claude communication
├── cli/                  # CLI commands (start, pause, resume, view)
├── claude/               # Claude instance management
│   ├── hooks.ts          # Hook event handling
│   ├── instance.ts       # Instance lifecycle
│   └── rate-limit-detector.ts
├── config/               # Configuration loading and validation
├── git/                  # Git operations (worktrees, merge, safety)
├── orchestrator/         # Core orchestration logic
│   ├── manager.ts        # Main orchestrator manager
│   ├── scheduler.ts      # Task scheduling
│   ├── worker.ts         # Worker management
│   ├── cost-tracker.ts   # Usage and cost tracking
│   └── stuck-detector.ts # Stuck instance detection
├── tmux/                 # Tmux session management
└── utils/                # Logging and utilities
```

## Testing

```bash
# Run all tests
npm test

# Run specific test file
npx vitest run tests/unit/config-loader.test.ts

# Run tests in watch mode
npx vitest watch

# Run with coverage
npx vitest run --coverage
```

## Maintenance Scripts

Located in `scripts/`:

- `cleanup.sh` - Kill orphaned tmux sessions and remove temporary worktrees
- `hard-reset.sh` - Full cleanup including logs
- `setup.sh` - Initial project setup

## Architecture

### Hierarchy Model

The orchestrator uses a hierarchical coordination model:

1. **Director** - Top-level coordinator (spawned when worker count exceeds EM capacity)
2. **Engineering Managers (EMs)** - Coordinate teams of workers, curate branches
3. **Workers** - Execute tasks in isolated git worktrees

### Key Concepts

- **Git Worktrees**: Each worker operates in an isolated worktree to prevent conflicts
- **Rate Limit Rotation**: Automatic rotation through OAuth and API keys on 429 errors
- **Stuck Detection**: Monitors instances for inactivity and restarts them
- **Hook Server**: HTTP server that receives events from Claude instances

## Debugging

Logs are stored in the configured `logDirectory`:

- `combined.log` - Orchestrator event stream
- `session-director.log` - Director tmux output
- `session-worker-N.log` - Worker tmux outputs

Use tmux to attach to running sessions:

```bash
tmux list-sessions
tmux attach -t <session-name>
```
