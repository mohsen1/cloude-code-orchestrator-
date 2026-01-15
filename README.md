# Claude Code Orchestrator

A distributed system for orchestrating multiple Claude Code instances to work collaboratively on software projects.

## 🚀 Overview

The orchestrator spawns multiple Claude Code instances that work in parallel on a shared codebase using a hierarchical coordination model.

### Hierarchy
- **Director**: Coordinates Engineering Managers (EMs) and makes strategic merges to the main branch.
- **Engineering Managers (EMs)**: Command teams of workers, curate team branches, and maintain task lists.
- **Workers**: Operate in isolated **git worktrees**, complete specific tasks, and push to worker-specific branches.

## ✨ Features

- **Hierarchical Coordination**: Scalable Director/EM/Worker event-driven architecture.
- **Isolation**: Git worktree isolation ensures parallel development without file conflicts.
- **Reliability**: Automatic rate limit detection, stuck instance detection, and health monitoring.
- **Auth Rotation**: Seamlessly rotates between OAuth and a pool of API keys.
- **Visibility**: Detailed per-instance tmux logs, cost tracking, and usage limits.

---

## 🚦 Quick Start

### 1. Requirements
- Node.js 22+
- `tmux`
- `git`
- [Claude Code CLI](https://github.com/anthropics/claude-code) (`npm install -g @anthropic-ai/claude-code`)

### 2. Installation
```bash
npm install
npm run build
```

### 3. Basic Run
```bash
# Create a config directory with orchestrator.json
mkdir my-config
echo '{"repositoryUrl": "https://github.com/org/repo.git", "workerCount": 2}' > my-config/orchestrator.json

# Start orchestrating
npm start -- --config ./my-config
```

---

## ⚙️ Configuration

The orchestrator looks for configuration files in the directory specified by `--config`.

### `orchestrator.json` (Required)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `repositoryUrl` | `string` | *required* | URL of the git repository to work on. |
| `branch` | `string` | `"main"` | Base branch to check out. |
| `workerCount` | `number` | *required* | Total number of worker instances (1-20). |
| `useRunBranch` | `boolean` | `false` | If `true`, creates a `run/YYYY-MM-DD-HH-MM` isolation branch for the run. |
| `authMode` | `string` | `"oauth"` | `oauth`, `api-keys-first`, or `api-keys-only`. |
| `logDirectory` | `string` | `config path` | Where per-run logs are stored. |
| `model` | `string` | *none* | Claude model to use (`haiku`, `sonnet`, `opus`). |
| `engineerManagerGroupSize` | `number` | `4` | Max workers per EM team. Triggers Director mode if exceeded. |
| `maxRunDurationMinutes` | `number` | `120` | Maximum orchestrator run time. |

### `api-keys.json` (Optional)

Used for rate limit rotation. The orchestrator will rotate through these keys when Claude hits "429 Too Many Requests".

```json
[
  { "name": "key-1", "env": { "ANTHROPIC_API_KEY": "sk-ant-..." } },
  { "name": "base-alt", "env": { "ANTHROPIC_AUTH_TOKEN": "...", "ANTHROPIC_BASE_URL": "..." } }
]
```

---

## 🔐 Authentication Modes

- **`oauth` (Default)**: Starts with your local `claude` CLI auth. Rotates to `api-keys.json` if rate limited.
- **`api-keys-first`**: Starts with the first key in `api-keys.json`. Falls back to OAuth after seeking through all keys.
- **`api-keys-only`**: Only uses keys from `api-keys.json`. Exits if no keys are available.

---

## 📁 Repository Structure

The target repository should contain instructions for the orchestrator:

- **`PROJECT_DIRECTION.md`**: High-level goals. The Director/Manager reads this to initialize the project.
- **`TEAM_STRUCTURE.md`**: (Auto-managed) Tracks which EMs and Workers are assigned to which tasks.
- **`Environment Files`**: `.env` or `.env.local` in the target repo are automatically copied to all worktrees.

---

## 📊 Monitoring & Logs

Every launch creates a timestamped folder in your `logDirectory`:
- `combined.log`: Orchestrator event stream.
- `session-director.log`: Full terminal output from the Director tmux session.
- `session-worker-N.log`: Full terminal output from worker sessions.

---

## 🛠 Commands

```bash
npm start       # Run using built files
npm run dev     # Run directly with tsx
npm run build   # Compile source to dist/
npm test        # Run unit & integration tests
```

---

## 🧹 Maintenance

If the orchestrator crashes or is interrupted, use the cleanup script to kill orphaned tmux sessions and remove temporary worktrees:

```bash
./scripts/cleanup.sh
```

## 📄 License
MIT
