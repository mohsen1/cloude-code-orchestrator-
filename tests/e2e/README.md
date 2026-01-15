# End-to-End Tests

This directory contains end-to-end tests that validate the complete orchestration workflow using real Claude instances.

## Overview

The e2e test (`run-e2e.ts`) creates a real orchestration session that:

1. Clones a test repository
2. Starts a manager and worker Claude instances
3. Has workers implement a simple calculator project
4. Validates that commits, files, and branches are created correctly

## Quick Start

```bash
# Run with defaults (5 minutes, 2 workers, haiku model)
npm run test:e2e

# Run for 10 minutes
npm run test:e2e -- --duration 10

# Run with 3 workers
npm run test:e2e -- --workers 3
```

## Prerequisites

1. **Claude Code CLI** - Must be installed and accessible as `claude`
2. **Authentication** - Either:
   - OAuth configured in `~/.claude` (default)
   - API keys in `api-keys.json`
3. **tmux** - Required for running Claude instances
4. **Git SSH access** - Push access to the test repository

## Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--repo` | `-r` | `mohsen1/claude-code-orchestrator-e2e-test` | GitHub repository |
| `--duration` | `-d` | `5` | Test duration in minutes |
| `--workers` | `-w` | `2` | Number of worker instances |
| `--model` | `-m` | `haiku` | Claude model (haiku/sonnet/opus) |
| `--auth-config` | `-a` | - | Path to api-keys.json |
| `--no-cleanup` | - | `false` | Keep tmux sessions after test |

## Test Project

The test uses a simple calculator project defined in `PROJECT_DIRECTION.md`:

```
src/
  calculator.ts    # Main calculator logic
  parser.ts        # Expression parser
  operations.ts    # Math operations
  index.ts         # CLI entry point
tests/
  calculator.test.ts
```

Workers implement different parts of this project and merge their changes.

## Success Criteria

The test **passes** if:
- At least one commit was made to the test branch
- Worker task list files were created

The test **fails** if:
- No commits were made (workers didn't complete any tasks)
- The orchestrator crashes or times out unexpectedly

## Viewing Results

After the test, a GitHub URL is printed where you can see:
- All commits made by workers
- Source files created
- Worker branches (`worker-1`, `worker-2`, etc.)
- Task distribution in `WORKER_*_TASK_LIST.md` files

## Example Output

```
============================================================
E2E TEST RESULTS
============================================================
Status: PASSED
Branch: e2e-1768256359628
Commits: 16
Files Created: 3
  - src/calculator.ts
  - src/operations.ts
  - src/parser.ts
Worker Branches: 2
  - origin/worker-1
  - origin/worker-2
============================================================

View results: https://github.com/mohsen1/claude-code-orchestrator-e2e-test/tree/e2e-1768256359628
```

## Troubleshooting

### "Permission denied" when pushing
Ensure your SSH key has push access to the test repository.

### Claude instances not starting
Check that `claude --dangerously-skip-permissions` works in your terminal.

### Rate limiting
The test uses the Haiku model by default to minimize rate limits. If you hit limits, wait and retry.

### Orphaned tmux sessions
If the test crashes, clean up manually:
```bash
tmux list-sessions | grep claude- | cut -d: -f1 | xargs -I{} tmux kill-session -t {}
```
