# CLI Transformation Plan: `cco` (Claude Code Orchestrator)

This document outlines the steps to transform the Claude Code Orchestrator into a user-friendly CLI tool.

## 1. CLI Entry Point & Global Installation ✅
- **Executable**: `cco` (Claude Code Orchestrator).
- **Global Install**: `"bin": { "cco": "dist/index.js" }` in package.json.
- **Permissions**: Hashbang `#!/usr/bin/env node` in `src/index.ts`.
- **Dependencies**: `inquirer`, `commander`, and `chalk` installed.

## 2. Interactive Mode (Default `cco` command)
- If `cco` is run without arguments, trigger an interactive prompt.
- **Questions** (minimal, sufficient):
    - Repository URL
    - Base Branch (default: `main`)
    - Worker Count (default: `2`)
    - Auth Mode (`oauth`, `api-keys-first`, `api-keys-only`)
- **Execution**:
    - Create a unique temporary directory for the run.
    - Generate an `orchestrator.json` in that directory.
    - Automatically set the `workspaceDir` to an isolated path within the temp directory.
    - Start the orchestrator.

## 3. Persistent Workspace Management ✅ (schema done)
- **Schema Update**: Added `workspaceDir` to `OrchestratorConfigSchema`.
- **Isolation**: Stop using the hardcoded `/tmp/orchestrator-workspace`.
- **Dynamic Selection**:
    1. Use `workspaceDir` from `orchestrator.json` if present.
    2. Otherwise, use the `--workspace` flag if provided.
    3. Fallback to a unique path: `/tmp/cco-<reponame>-<timestamp>`.
- **State Location**: State files (`state.json`, queue states) live next to `orchestrator.json`.
- **One Config = One Session**: Each `orchestrator.json` runs exactly one orchestration session.

## 4. `cco view` (The tmux "Cockpit")
- A new command to visualize the entire swarm.
- **Logic**:
    1. Detect all active tmux sessions matching `<reponame>-director`, `<reponame>-worker-*`, etc.
    2. Create a new tmux window named `cco-view-<reponame>`.
    3. If window already exists, reuse it (switch to it).
    4. Tile panes using `tmux split-window` to show Director, EMs, and Workers simultaneously.
    5. Provide labels for each pane via pane titles.

## 5. Session Naming (Multi-Orchestration Support)
- **Prefix**: Use git repo name extracted from `repositoryUrl`.
- **Format**: `<reponame>-director`, `<reponame>-em-1`, `<reponame>-worker-1`, etc.
- **Example**: For `https://github.com/org/my-app.git`:
    - `my-app-director`
    - `my-app-em-1`
    - `my-app-worker-1`

## 6. `cco pause` & `cco resume`
- **`cco pause`**:
    - Signals managers and directors that we are wrapping up.
    - Stops automatic pokes, reconcile loops, and queue processing.
    - Workers finish their current tool call/task and then idle.
    - Saves state to `state.json` next to `orchestrator.json`.
- **`cco resume`**:
    - Replaces the broken `--resume` flag (will be removed).
    - Loads `state.json` from the config directory.
    - Restarts scheduler and resumes from saved state.

## 7. Implementation Stages
1. ✅ **Infrastructure**: `package.json` bin, hashbang, dependencies.
2. **CLI Commands**: Implement `cco`, `cco view`, `cco pause`, `cco resume` using commander.
3. **Interactive Logic**: Build the inquirer flow and temp dir generator.
4. **Session Naming**: Update TmuxManager and instance creation to use repo-prefixed names.
5. **Workspace Refactor**: Replace hardcoded `/tmp/orchestrator-workspace` everywhere.
6. **Pause/Resume System**: Implement state serialization and scheduler control.
7. **View Magic**: Build the tmux layout generator.
8. **Cleanup**: Remove `--resume` flag, update help text, polish output.
