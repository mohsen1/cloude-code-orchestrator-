# Implementation Plan

> Detailed technical implementation guide for the Claude Code Orchestrator

---

## Table of Contents

0. [Phase 0: Feasibility Prototype](#phase-0-feasibility-prototype)
1. [Phase 1: Project Foundation](#phase-1-project-foundation)
2. [Phase 2: Configuration System](#phase-2-configuration-system)
3. [Phase 3: Docker Infrastructure](#phase-3-docker-infrastructure)
4. [Phase 4: tmux Session Management](#phase-4-tmux-session-management)
5. [Phase 5: Claude Code Integration](#phase-5-claude-code-integration)
6. [Phase 6: Hook System](#phase-6-hook-system)
7. [Phase 7: Manager Instance](#phase-7-manager-instance)
8. [Phase 8: Worker Instances](#phase-8-worker-instances)
9. [Phase 9: Rate Limit & Config Rotation](#phase-9-rate-limit--config-rotation)
10. [Phase 10: Health Monitoring & Recovery](#phase-10-health-monitoring--recovery)
11. [Phase 11: Testing & Documentation](#phase-11-testing--documentation)

---

## Known Risks & Mitigations

### Risk 1: Interactive Permission Blocking (RESOLVED)

**Problem**: Claude Code defaults to asking for permission before executing shell commands or file edits (e.g., "Run this command? [y/N]"). Without handling this, workers will hang indefinitely.

**Solution**: Use `--dangerously-skip-permissions` flag. This is **safe in our architecture** because:
- All Claude Code instances run inside isolated Docker containers
- Containers are disposable and have no access to host system
- The "dangerous" label assumes running on a developer's local machine with access to sensitive files
- In containerized orchestration, auto-approve is the correct behavior

### Risk 2: Terminal Scraping Reliability (MEDIUM)

**Problem**: ANSI escape codes, spinners, and progress bars make raw text capture unreliable for control flow.

**Mitigation**: 
- **Do NOT** use `getOutput()` for control flow logic
- **Only** use hooks for state changes
- Use `getOutput()` strictly for logging/debugging

### Risk 3: Context Loss on Config Rotation (MEDIUM)

**Problem**: Restarting Claude process wipes conversation history and in-memory context.

**Mitigation**: 
- Snapshot `currentTask` before restart
- Re-feed context summary prompt after rotation

### Risk 4: Authentication Portability (CRITICAL - Validate in Phase 0)

**Problem**: Many CLIs use OS-native keychain (libsecret, Keychain Access) to store tokens. If `claude-code` does this, copying `settings.json` into a headless Docker container will fail because the keychain service is missing.

**Validation Required**:
1. Test if `ANTHROPIC_API_KEY` environment variable works (preferred)
2. Test if config file can be copied to a fresh container without re-auth
3. If neither works, authentication strategy needs redesign

**Mitigation Options** (in order of preference):
- **Option A**: Use `ANTHROPIC_API_KEY` env var per container (simplest)
- **Option B**: Use plaintext config file if CLI supports it
- **Option C**: OAuth token injection if API key not supported

### Risk 5: Rate Limit Detection (MEDIUM)

**Problem**: The plan assumes a `rate_limit` hook exists, but Claude Code may not emit hooks for API errors. It likely just prints "Rate limit exceeded" or "429" to stdout.

**Mitigation**:
- Do NOT rely on a `rate_limit` hook
- Implement regex scraping of tmux output for rate limit strings
- Trigger rotation manually when detected
- Capture exact error strings during Phase 0 testing

### Risk 6: Git Race Conditions (LOW)

**Problem**: Worker pushes to branch → Manager starts merge → Worker pushes another commit → Merge state is inconsistent.

**Mitigation**:
- "Lock" worker instance during merge (pause container or mark status as `merging`)
- Manager must complete merge before worker can resume
- Use `git fetch` + `git merge` instead of assuming local branch is current

---

## Phase 0: Feasibility Prototype

> **CRITICAL**: Complete this phase before proceeding. This validates core assumptions about Claude Code interaction.

### 0.1 Objectives

1. Verify Claude Code can run non-interactively (auto-approve permissions)
2. Validate tmux + Docker interaction model
3. Test hook system connectivity from container to host

### 0.2 Manual Test Steps

```bash
# Step 1: Build a minimal test container
docker run -it --name claude-test node:24-bookworm bash

# Inside container:
npm install -g @anthropic-ai/claude-code
mkdir -p ~/.claude

# Step 2: Test permission bypass (safe in Docker isolation)
claude --dangerously-skip-permissions

# Test prompt: "Create a file called test.txt with 'hello world'"
# EXPECTED: File created without Y/N prompt
# ACTUAL: _______________
```

### 0.3 tmux + Docker Validation

```bash
# On host machine:

# Create tmux session that runs docker exec directly
tmux new-session -d -s claude-test "docker exec -it claude-test claude --dangerously-skip-permissions"

# Attach to verify it works
tmux attach -t claude-test

# Test sending keys from another terminal
tmux send-keys -t claude-test "create a file test.txt" Enter

# Capture output
tmux capture-pane -t claude-test -p
```

### 0.4 Hook Connectivity Test

```bash
# On host: Start a simple listener
nc -l 3000

# In container: Test curl to host
curl -X POST http://host.docker.internal:3000/hooks/test \
  -H "Content-Type: application/json" \
  -d '{"test": "hello"}'

# Verify host received the request
```

### 0.5 Authentication Portability Test (CRITICAL)

```bash
# Test 1: Environment variable authentication (PREFERRED)
docker run -it --rm \
  -e ANTHROPIC_API_KEY="sk-ant-..." \
  node:24-bookworm bash

# Inside container:
npm install -g @anthropic-ai/claude-code
claude --dangerously-skip-permissions
# Test prompt: "What is 2+2?"
# EXPECTED: Response without login prompt
# ACTUAL: _______________

# Test 2: Config file portability (if env var doesn't work)
# On host: Copy your ~/.claude folder
docker cp ~/.claude claude-test:/root/.claude

# In container: Try to use Claude
claude --dangerously-skip-permissions
# Does it work without re-authentication?
# ACTUAL: _______________
```

### 0.6 Rate Limit Error Capture

```bash
# Force a rate limit by making many rapid requests
# Or temporarily use an invalid/exhausted API key
# Capture the EXACT error message:

# Expected patterns to capture:
# - "Rate limit exceeded"
# - "429"
# - "Too many requests"
# - "Please try again in X seconds"

# ACTUAL ERROR STRING: _______________
# This will be used for regex detection in the orchestrator
```

### 0.7 Go/No-Go Criteria

| Test | Pass Criteria | Result |
|------|---------------|--------|
| Permission bypass | Commands execute without Y/N prompt | ⬜ |
| tmux send-keys | Prompts received by Claude | ⬜ |
| tmux capture-pane | Output readable (ignore ANSI codes) | ⬜ |
| Hook connectivity | Host receives curl from container | ⬜ |
| **Auth: Env var** | `ANTHROPIC_API_KEY` works in container | ⬜ |
| **Auth: Config file** | Copied config works without re-login | ⬜ |
| **Rate limit string** | Captured exact error message | ⬜ |

**Decision**:
- ✅ All pass → Proceed to Phase 1
- ❌ Both auth methods fail → Need to investigate Claude Code auth flow (blocker)
- ❌ Hook connectivity fails → Switch to file-based IPC (add 1 day)

**Auth Strategy Decision**:
- If env var works → Use `ANTHROPIC_API_KEY` per container (simplest)
- If only config works → Mount config files read-only
- Document which method to use in Phase 2

---

## Phase 1: Project Foundation

### 1.1 Initialize Node.js Project

```bash
mkdir -p ~/code/claude-code-orchestrator
cd ~/code/claude-code-orchestrator
npm init -y
```

### 1.2 Project Structure

```
claude-code-orchestrator/
├── src/
│   ├── index.ts                    # Entry point
│   ├── server.ts                   # HTTP server for hooks
│   ├── cleanup.ts                  # Graceful shutdown & zombie cleanup
│   ├── config/
│   │   ├── loader.ts               # Config file loading & validation
│   │   ├── schema.ts               # Zod schemas for config validation
│   │   └── validator.ts            # Claude config file validation
│   ├── docker/
│   │   ├── manager.ts              # Docker container lifecycle
│   │   ├── compose.ts              # Docker Compose file generation
│   │   └── health.ts               # Container health checks
│   ├── tmux/
│   │   ├── session.ts              # tmux session management
│   │   └── commands.ts             # tmux command execution
│   ├── claude/
│   │   ├── instance.ts             # Claude Code instance abstraction
│   │   ├── config-rotator.ts       # API key rotation logic
│   │   ├── hooks.ts                # Hook handlers
│   │   └── context-manager.ts      # Task context preservation
│   ├── orchestrator/
│   │   ├── manager.ts              # Manager instance logic
│   │   ├── worker.ts               # Worker instance logic
│   │   ├── scheduler.ts            # Task scheduling
│   │   └── cost-tracker.ts         # Token/tool usage monitoring
│   ├── git/
│   │   ├── worktree.ts             # Git worktree management
│   │   └── merge.ts                # Branch merging logic
│   └── utils/
│       ├── logger.ts               # Structured logging
│       ├── process.ts              # Child process utilities
│       └── glob.ts                 # Glob pattern utilities
├── docker/
│   ├── Dockerfile                  # Claude Code container image
│   └── docker-compose.template.yml # Compose template
├── scripts/
│   ├── setup.sh                    # Initial setup script
│   └── cleanup.sh                  # Force cleanup of orphaned resources
├── tests/
│   ├── unit/
│   └── integration/
├── package.json
├── tsconfig.json
└── README.md
```

### 1.3 Dependencies

```json
{
  "dependencies": {
    "express": "^4.18.0",
    "zod": "^3.22.0",
    "glob": "^10.3.0",
    "yaml": "^2.3.0",
    "winston": "^3.11.0",
    "dockerode": "^4.0.0",
    "simple-git": "^3.22.0",
    "execa": "^8.0.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "@types/node": "^20.10.0",
    "@types/express": "^4.17.0",
    "vitest": "^1.0.0",
    "tsx": "^4.7.0"
  }
}
```

### 1.4 TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

---

## Phase 2: Configuration System

### 2.1 Config Schema (`src/config/schema.ts`)

```typescript
import { z } from 'zod';

export const OrchestratorConfigSchema = z.object({
  repositoryUrl: z.string().url(),
  branch: z.string().default('main'),
  workerCount: z.number().int().min(1).max(20),
  claudeConfigs: z.string(), // Glob pattern
});

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

export const ClaudeConfigSchema = z.object({
  // Schema depends on Claude Code config format
  // Will be validated at runtime when loading
});
```

### 2.2 Config Loader (`src/config/loader.ts`)

```typescript
import { glob } from 'glob';
import { readFile } from 'fs/promises';
import { OrchestratorConfigSchema, OrchestratorConfig } from './schema';

export class ConfigLoader {
  private configDir: string;
  
  constructor(configDir: string) {
    this.configDir = configDir;
  }

  async loadOrchestratorConfig(): Promise<OrchestratorConfig> {
    const configPath = `${this.configDir}/orchestrator.json`;
    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return OrchestratorConfigSchema.parse(parsed);
  }

  async loadClaudeConfigs(): Promise<string[]> {
    const config = await this.loadOrchestratorConfig();
    const pattern = config.claudeConfigs.replace('~', process.env.HOME!);
    return glob(pattern);
  }

  async validateClaudeConfigs(paths: string[]): Promise<void> {
    for (const path of paths) {
      try {
        const raw = await readFile(path, 'utf-8');
        JSON.parse(raw); // Validate JSON syntax
        logger.info(`Validated Claude config: ${path}`);
      } catch (err) {
        throw new Error(`Invalid Claude config at ${path}: ${err}`);
      }
    }
  }
}
```

### 2.3 CLI Entry Point (`src/index.ts`)

```typescript
import { parseArgs } from 'node:util';
import { Orchestrator } from './orchestrator/manager';
import { ConfigLoader } from './config/loader';
import { logger } from './utils/logger';

const { values } = parseArgs({
  options: {
    config: { type: 'string', short: 'c' },
  },
});

if (!values.config) {
  console.error('Usage: node server.js --config /path/to/config-dir');
  process.exit(1);
}

async function main() {
  const loader = new ConfigLoader(values.config!);
  const config = await loader.loadOrchestratorConfig();
  const claudeConfigPaths = await loader.loadClaudeConfigs();

  // Validate Claude configs before starting
  await loader.validateClaudeConfigs(claudeConfigPaths);

  if (claudeConfigPaths.length < config.workerCount + 1) {
    logger.warn('Fewer Claude configs than instances - rate limit rotation may fail');
  }

  const orchestrator = new Orchestrator(config, claudeConfigPaths);
  
  // Register cleanup handlers
  setupCleanupHandlers(orchestrator);
  
  await orchestrator.start();
}

function setupCleanupHandlers(orchestrator: Orchestrator): void {
  const cleanup = async (signal: string) => {
    logger.info(`Received ${signal}, initiating graceful shutdown...`);
    await orchestrator.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('uncaughtException', async (err) => {
    logger.error('Uncaught exception', err);
    await orchestrator.shutdown();
    process.exit(1);
  });
}

main().catch((err) => {
  logger.error('Fatal error', err);
  process.exit(1);
});
```

---

## Phase 3: Docker Infrastructure

### 3.1 Dockerfile (`docker/Dockerfile`)

```dockerfile
FROM node:24-bookworm

# Install dependencies
RUN apt-get update && apt-get install -y \
    git \
    tmux \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Create workspace directory
WORKDIR /workspace

# Create claude config directory
RUN mkdir -p /root/.claude

# Environment variables (overridden at runtime)
ENV WORKER_ID=""
ENV TOTAL_WORKERS=""
ENV INSTANCE_TYPE=""
ENV ORCHESTRATOR_URL=""

# Entry point script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
```

### 3.2 Entrypoint Script (`docker/entrypoint.sh`)

```bash
#!/bin/bash
set -e

echo "Starting Claude Code instance..."
echo "  WORKER_ID: $WORKER_ID"
echo "  INSTANCE_TYPE: $INSTANCE_TYPE"
echo "  ORCHESTRATOR_URL: $ORCHESTRATOR_URL"

# Copy Claude config if mounted
if [ -f /claude-config/config.json ]; then
    cp /claude-config/config.json /root/.claude/settings.json
fi

# Navigate to the appropriate worktree directory
if [ "$INSTANCE_TYPE" = "manager" ]; then
    cd /repo
else
    cd /repo/worktrees/worker-$WORKER_ID
fi

# Start Claude Code with permission bypass (CRITICAL for non-interactive use)
exec claude --dangerously-skip-permissions
```

### 3.3 Docker Compose Generator (`src/docker/compose.ts`)

```typescript
import { dump } from 'yaml';
import { writeFile } from 'fs/promises';

interface ComposeService {
  image: string;
  container_name: string;
  environment: Record<string, string>;
  volumes: string[];
  networks: string[];
  labels: Record<string, string>;
}

export class ComposeGenerator {
  generateCompose(
    workerCount: number,
    orchestratorUrl: string,
    repoUrl: string,
    branch: string
  ): object {
    const services: Record<string, ComposeService> = {};

    // Manager service
    services['manager'] = this.createService({
      name: 'manager',
      workerId: '0',
      instanceType: 'manager',
      totalWorkers: workerCount.toString(),
      orchestratorUrl,
      repoUrl,
      branch,
    });

    // Worker services
    for (let i = 1; i <= workerCount; i++) {
      services[`worker-${i}`] = this.createService({
        name: `worker-${i}`,
        workerId: i.toString(),
        instanceType: 'worker',
        totalWorkers: workerCount.toString(),
        orchestratorUrl,
        repoUrl,
        branch,
      });
    }

    return {
      version: '3.8',
      services,
      networks: {
        orchestrator: {
          driver: 'bridge',
        },
      },
      // Named volume for shared git repository
      volumes: {
        'repo-data': {},
      },
    };
  }

  private createService(opts: {
    name: string;
    workerId: string;
    instanceType: string;
    totalWorkers: string;
    orchestratorUrl: string;
    repoUrl: string;
    branch: string;
  }): ComposeService {
    return {
      image: 'claude-code-orchestrator:latest',
      container_name: `claude-${opts.name}`,
      environment: {
        WORKER_ID: opts.workerId,
        INSTANCE_TYPE: opts.instanceType,
        TOTAL_WORKERS: opts.totalWorkers,
        ORCHESTRATOR_URL: opts.orchestratorUrl,
        REPO_URL: opts.repoUrl,
        BRANCH: opts.branch,
      },
      // FIXED: Mount shared repo volume so git worktrees work correctly
      // The .git directory must be accessible to all containers
      volumes: [
        'repo-data:/repo',                                    // Shared repo with .git
        `./claude-configs/${opts.workerId}:/claude-config:ro`, // Config (read-only)
      ],
      networks: ['orchestrator'],
      labels: {
        'orchestrator.instance': opts.name,
        'orchestrator.type': opts.instanceType,
      },
      // Keep container running even if Claude exits
      restart: 'unless-stopped',
      // Required for tmux to work properly
      tty: true,
      stdin_open: true,
    };
  }

  async writeComposeFile(path: string, config: object): Promise<void> {
    const yaml = dump(config);
    await writeFile(path, yaml);
  }
}
```

### 3.4 Docker Manager (`src/docker/manager.ts`)

```typescript
import Docker from 'dockerode';
import { logger } from '../utils/logger';

export class DockerManager {
  private docker: Docker;
  private containers: Map<string, Docker.Container> = new Map();

  constructor() {
    this.docker = new Docker();
  }

  async startContainers(composeFile: string): Promise<void> {
    // Use docker-compose up via execa
    const { execa } = await import('execa');
    await execa('docker-compose', ['-f', composeFile, 'up', '-d']);
    
    // Track containers
    const containers = await this.docker.listContainers({
      filters: { label: ['orchestrator.instance'] },
    });
    
    for (const info of containers) {
      const container = this.docker.getContainer(info.Id);
      const name = info.Labels['orchestrator.instance'];
      this.containers.set(name, container);
      logger.info(`Tracking container: ${name}`);
    }
  }

  async stopContainer(name: string): Promise<void> {
    const container = this.containers.get(name);
    if (container) {
      await container.stop();
      logger.info(`Stopped container: ${name}`);
    }
  }

  async restartContainer(name: string): Promise<void> {
    const container = this.containers.get(name);
    if (container) {
      await container.restart();
      logger.info(`Restarted container: ${name}`);
    }
  }

  async getContainerStatus(name: string): Promise<'running' | 'stopped' | 'unknown'> {
    const container = this.containers.get(name);
    if (!container) return 'unknown';
    
    const info = await container.inspect();
    return info.State.Running ? 'running' : 'stopped';
  }

  async execInContainer(name: string, command: string[]): Promise<string> {
    const container = this.containers.get(name);
    if (!container) throw new Error(`Container ${name} not found`);

    const exec = await container.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    // Collect output...
    return ''; // Simplified
  }
}
```

---

## Phase 4: tmux Session Management

### 4.1 tmux Session Manager (`src/tmux/session.ts`)

```typescript
import { execa } from 'execa';
import { logger } from '../utils/logger';

export class TmuxManager {
  private sessions: Map<string, string> = new Map();

  // FIXED: Create session with docker exec as the initial command
  // This avoids the fragility of docker attach
  async createSessionWithContainer(name: string, containerName: string): Promise<void> {
    try {
      // Run docker exec directly as the tmux command
      // This is more robust than attaching after session creation
      await execa('tmux', [
        'new-session',
        '-d',
        '-s', name,
        `docker exec -it ${containerName} /bin/bash -c "claude --dangerously-skip-permissions"`
      ]);
      this.sessions.set(name, name);
      logger.info(`Created tmux session: ${name} (attached to ${containerName})`);
    } catch (err) {
      logger.error(`Failed to create tmux session: ${name}`, err);
      throw err;
    }
  }

  async createSession(name: string): Promise<void> {
    try {
      await execa('tmux', ['new-session', '-d', '-s', name]);
      this.sessions.set(name, name);
      logger.info(`Created tmux session: ${name}`);
    } catch (err) {
      logger.error(`Failed to create tmux session: ${name}`, err);
      throw err;
    }
  }

  // DEPRECATED: Use createSessionWithContainer instead
  async attachToContainer(sessionName: string, containerName: string): Promise<void> {
    // Using docker exec instead of docker attach to avoid detach issues
    await this.sendKeys(sessionName, `docker exec -it ${containerName} claude --dangerously-skip-permissions`);
  }

  async sendKeys(sessionName: string, keys: string): Promise<void> {
    await execa('tmux', ['send-keys', '-t', sessionName, keys, 'Enter']);
    logger.debug(`Sent keys to ${sessionName}: ${keys}`);
  }

  async capturePane(sessionName: string, lines: number = 100): Promise<string> {
    const { stdout } = await execa('tmux', [
      'capture-pane',
      '-t', sessionName,
      '-p',
      '-S', `-${lines}`,
    ]);
    return stdout;
  }

  async killSession(sessionName: string): Promise<void> {
    await execa('tmux', ['kill-session', '-t', sessionName]);
    this.sessions.delete(sessionName);
    logger.info(`Killed tmux session: ${sessionName}`);
  }

  async listSessions(): Promise<string[]> {
    const { stdout } = await execa('tmux', ['list-sessions', '-F', '#{session_name}']);
    return stdout.split('\n').filter(Boolean);
  }

  async killAllOrchestratorSessions(): Promise<void> {
    const sessions = await this.listSessions();
    const orchestratorSessions = sessions.filter(s => s.startsWith('claude-'));
    
    for (const session of orchestratorSessions) {
      await this.killSession(session);
    }
    logger.info(`Killed ${orchestratorSessions.length} orchestrator sessions`);
  }
}
```

### 4.2 tmux Commands Helper (`src/tmux/commands.ts`)

```typescript
import { TmuxManager } from './session';

export class TmuxCommands {
  constructor(private tmux: TmuxManager) {}

  async sendClaudePrompt(sessionName: string, prompt: string): Promise<void> {
    // Escape special characters for tmux
    const escaped = prompt.replace(/'/g, "'\\''");
    await this.tmux.sendKeys(sessionName, escaped);
  }

  async interruptClaude(sessionName: string): Promise<void> {
    // Send Ctrl+C to interrupt current operation
    await this.tmux.sendKeys(sessionName, 'C-c');
  }

  async scrollUp(sessionName: string): Promise<void> {
    await this.tmux.sendKeys(sessionName, 'C-b [');
  }
}
```

---

## Phase 5: Claude Code Integration

### 5.1 Claude Instance Abstraction (`src/claude/instance.ts`)

```typescript
import { TmuxManager } from '../tmux/session';
import { DockerManager } from '../docker/manager';
import { logger } from '../utils/logger';

export type InstanceType = 'manager' | 'worker';
export type InstanceStatus = 'starting' | 'ready' | 'busy' | 'idle' | 'error' | 'stopped';

export interface ClaudeInstance {
  id: string;
  type: InstanceType;
  workerId: number;
  containerName: string;
  sessionName: string;
  status: InstanceStatus;
  currentTask?: string;
  currentTaskFull?: string;  // Full task description for context restoration
  configPath: string;
  lastToolUse?: Date;        // For heartbeat/stuck detection
  toolUseCount: number;      // For cost tracking
}

export class ClaudeInstanceManager {
  private instances: Map<string, ClaudeInstance> = new Map();

  constructor(
    private docker: DockerManager,
    private tmux: TmuxManager
  ) {}

  async createInstance(opts: {
    id: string;
    type: InstanceType;
    workerId: number;
    configPath: string;
  }): Promise<ClaudeInstance> {
    const containerName = `claude-${opts.type}-${opts.workerId}`;
    const sessionName = `claude-${opts.id}`;

    const instance: ClaudeInstance = {
      id: opts.id,
      type: opts.type,
      workerId: opts.workerId,
      containerName,
      sessionName,
      status: 'starting',
      configPath: opts.configPath,
      toolUseCount: 0,
    };

    // FIXED: Create tmux session with docker exec directly
    await this.tmux.createSessionWithContainer(sessionName, containerName);

    instance.status = 'ready';
    this.instances.set(opts.id, instance);
    
    logger.info(`Created Claude instance: ${opts.id}`);
    return instance;
  }

  async sendPrompt(instanceId: string, prompt: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`Instance ${instanceId} not found`);

    instance.status = 'busy';
    instance.currentTask = prompt.substring(0, 100);
    instance.currentTaskFull = prompt;  // Store full task for context restoration

    await this.tmux.sendKeys(instance.sessionName, prompt);
  }

  // WARNING: Do NOT use this for control flow decisions
  // Use hooks for state changes. This is for logging/debugging only.
  async getOutput(instanceId: string): Promise<string> {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`Instance ${instanceId} not found`);

    return this.tmux.capturePane(instance.sessionName, 500);
  }

  getInstance(instanceId: string): ClaudeInstance | undefined {
    return this.instances.get(instanceId);
  }

  getAllInstances(): ClaudeInstance[] {
    return Array.from(this.instances.values());
  }

  getIdleWorkers(): ClaudeInstance[] {
    return this.getAllInstances().filter(
      (i) => i.type === 'worker' && i.status === 'idle'
    );
  }

  // Lock a worker during merge operations to prevent race conditions
  async lockWorker(workerId: number): Promise<void> {
    const instance = this.instances.get(`worker-${workerId}`);
    if (instance) {
      instance.status = 'merging' as InstanceStatus;
      logger.info(`Locked worker ${workerId} for merge`);
    }
  }

  async unlockWorker(workerId: number): Promise<void> {
    const instance = this.instances.get(`worker-${workerId}`);
    if (instance && instance.status === ('merging' as InstanceStatus)) {
      instance.status = 'idle';
      logger.info(`Unlocked worker ${workerId}`);
    }
  }
}
```

### 5.2 Rate Limit Detector (`src/claude/rate-limit-detector.ts`)

> **Note**: Claude Code may not emit a `rate_limit` hook. This detector scrapes tmux output.

```typescript
import { TmuxManager } from '../tmux/session';
import { ClaudeInstanceManager } from './instance';
import { logger } from '../utils/logger';

// Patterns captured during Phase 0 testing - UPDATE THESE with actual strings
const RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /429/,
  /too many requests/i,
  /please try again/i,
  /exceeded.*quota/i,
];

export class RateLimitDetector {
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(
    private tmux: TmuxManager,
    private instanceManager: ClaudeInstanceManager,
    private onRateLimitDetected: (instanceId: string) => Promise<void>
  ) {}

  start(intervalMs: number = 10000): void {
    this.checkInterval = setInterval(() => this.checkAll(), intervalMs);
    logger.info('Rate limit detector started');
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  private async checkAll(): Promise<void> {
    const instances = this.instanceManager.getAllInstances();

    for (const instance of instances) {
      if (instance.status !== 'busy') continue;

      try {
        const output = await this.tmux.capturePane(instance.sessionName, 50);
        
        for (const pattern of RATE_LIMIT_PATTERNS) {
          if (pattern.test(output)) {
            logger.warn(`Rate limit detected for ${instance.id}`, { pattern: pattern.toString() });
            await this.onRateLimitDetected(instance.id);
            break;
          }
        }
      } catch (err) {
        logger.debug(`Failed to check rate limit for ${instance.id}`, err);
      }
    }
  }
}
```

---

## Phase 6: Hook System

### 6.1 Hook Server (`src/server.ts`)

```typescript
import express from 'express';
import { logger } from './utils/logger';

export interface HookPayload {
  hook_name: string;
  instance_id: string;
  worker_id: number;
  instance_type: 'manager' | 'worker';
  data: Record<string, unknown>;
}

type HookHandler = (payload: HookPayload) => Promise<void>;

export class HookServer {
  private app: express.Application;
  private handlers: Map<string, HookHandler[]> = new Map();

  constructor(private port: number = 3000) {
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Main hook endpoint
    this.app.post('/hooks/:hookName', async (req, res) => {
      const hookName = req.params.hookName;
      const payload: HookPayload = {
        hook_name: hookName,
        instance_id: req.body.instance_id,
        worker_id: req.body.worker_id,
        instance_type: req.body.instance_type,
        data: req.body.data || {},
      };

      logger.info(`Received hook: ${hookName}`, { payload });

      const handlers = this.handlers.get(hookName) || [];
      for (const handler of handlers) {
        try {
          await handler(payload);
        } catch (err) {
          logger.error(`Hook handler error: ${hookName}`, err);
        }
      }

      res.json({ status: 'ok' });
    });

    // Health check
    this.app.get('/health', (_, res) => {
      res.json({ status: 'healthy' });
    });

    // Status endpoint
    this.app.get('/status', (_, res) => {
      // Return orchestrator status
      res.json({ status: 'running' });
    });
  }

  on(hookName: string, handler: HookHandler): void {
    const handlers = this.handlers.get(hookName) || [];
    handlers.push(handler);
    this.handlers.set(hookName, handlers);
  }

  start(): void {
    this.app.listen(this.port, () => {
      logger.info(`Hook server listening on port ${this.port}`);
    });
  }
}
```

### 6.2 Claude Code Hook Configuration

Each Claude Code instance needs hooks configured in its settings. The orchestrator generates this configuration:

```typescript
// src/claude/hooks.ts

export interface ClaudeHooksConfig {
  hooks: {
    Stop?: HookDefinition[];
    // Add other hooks as needed
  };
}

interface HookDefinition {
  matcher: string;
  command: string[];
}

export function generateHooksConfig(
  orchestratorUrl: string,
  instanceId: string,
  workerId: number,
  instanceType: 'manager' | 'worker'
): ClaudeHooksConfig {
  const basePayload = JSON.stringify({
    instance_id: instanceId,
    worker_id: workerId,
    instance_type: instanceType,
  });

  return {
    hooks: {
      Stop: [
        {
          matcher: '*',
          command: [
            'curl', '-s',
            '-X', 'POST',
            '-H', 'Content-Type: application/json',
            '-d', basePayload,
            `${orchestratorUrl}/hooks/stop`,
          ],
        },
      ],
      // ToolUse hook for heartbeat/activity tracking
      ToolUse: [
        {
          matcher: '*',
          command: [
            'curl', '-s',
            '-X', 'POST',
            '-H', 'Content-Type: application/json',
            '-d', basePayload,
            `${orchestratorUrl}/hooks/tool_use`,
          ],
        },
      ],
    },
  };
}
```

### 6.3 Hook Handlers (`src/claude/hook-handlers.ts`)

```typescript
import { HookPayload, HookServer } from '../server';
import { ClaudeInstanceManager } from './instance';
import { logger } from '../utils/logger';

export function registerHookHandlers(
  server: HookServer,
  instanceManager: ClaudeInstanceManager,
  onTaskComplete: (workerId: number) => void
): void {
  // Stop hook - instance finished its task
  server.on('stop', async (payload: HookPayload) => {
    logger.info(`Instance ${payload.instance_id} stopped`);
    
    const instance = instanceManager.getInstance(payload.instance_id);
    if (instance) {
      instance.status = 'idle';
      instance.currentTask = undefined;
    }

    if (payload.instance_type === 'worker') {
      onTaskComplete(payload.worker_id);
    }
  });

  // Error hook - instance encountered an error
  server.on('error', async (payload: HookPayload) => {
    logger.error(`Instance ${payload.instance_id} error`, payload.data);
    
    const instance = instanceManager.getInstance(payload.instance_id);
    if (instance) {
      instance.status = 'error';
    }
  });

  // Rate limit hook - need to rotate config
  server.on('rate_limit', async (payload: HookPayload) => {
    logger.warn(`Instance ${payload.instance_id} hit rate limit`);
    // Trigger config rotation (handled elsewhere)
  });

  // ToolUse hook - heartbeat/activity tracking
  server.on('tool_use', async (payload: HookPayload) => {
    const instance = instanceManager.getInstance(payload.instance_id);
    if (instance) {
      instance.lastToolUse = new Date();
      instance.toolUseCount++;
      logger.debug(`Instance ${payload.instance_id} tool use (count: ${instance.toolUseCount})`);
    }
  });
}
```

---

## Phase 7: Manager Instance

### 7.1 Manager Logic (`src/orchestrator/manager.ts`)

```typescript
import { ClaudeInstanceManager, ClaudeInstance } from '../claude/instance';
import { HookServer } from '../server';
import { DockerManager } from '../docker/manager';
import { TmuxManager } from '../tmux/session';
import { GitManager } from '../git/worktree';
import { logger } from '../utils/logger';
import { OrchestratorConfig } from '../config/schema';

export class Orchestrator {
  private hookServer: HookServer;
  private docker: DockerManager;
  private tmux: TmuxManager;
  private instanceManager: ClaudeInstanceManager;
  private git: GitManager;
  private managerInstance?: ClaudeInstance;

  constructor(
    private config: OrchestratorConfig,
    private claudeConfigPaths: string[]
  ) {
    this.hookServer = new HookServer(3000);
    this.docker = new DockerManager();
    this.tmux = new TmuxManager();
    this.instanceManager = new ClaudeInstanceManager(this.docker, this.tmux);
    this.git = new GitManager();
  }

  async start(): Promise<void> {
    logger.info('Starting orchestrator...');

    // 1. Start hook server
    this.hookServer.start();

    // 2. Clone repository and setup worktrees
    await this.git.clone(this.config.repositoryUrl, this.config.branch);

    // 3. Generate and start Docker containers
    await this.startContainers();

    // 4. Create Claude instances
    await this.createInstances();

    // 5. Register hook handlers
    this.registerHandlers();

    // 6. Initialize manager with project direction
    await this.initializeManager();

    logger.info('Orchestrator started successfully');
  }

  private async startContainers(): Promise<void> {
    const { ComposeGenerator } = await import('../docker/compose');
    const generator = new ComposeGenerator();
    
    const compose = generator.generateCompose(
      this.config.workerCount,
      'http://host.docker.internal:3000',
      this.config.repositoryUrl,
      this.config.branch
    );

    await generator.writeComposeFile('./docker-compose.yml', compose);
    await this.docker.startContainers('./docker-compose.yml');
  }

  private async createInstances(): Promise<void> {
    // Create manager instance
    this.managerInstance = await this.instanceManager.createInstance({
      id: 'manager',
      type: 'manager',
      workerId: 0,
      configPath: this.claudeConfigPaths[0],
    });

    // Create worker instances
    for (let i = 1; i <= this.config.workerCount; i++) {
      await this.instanceManager.createInstance({
        id: `worker-${i}`,
        type: 'worker',
        workerId: i,
        configPath: this.claudeConfigPaths[i] || this.claudeConfigPaths[0],
      });
    }
  }

  private registerHandlers(): void {
    const { registerHookHandlers } = require('../claude/hook-handlers');
    registerHookHandlers(
      this.hookServer,
      this.instanceManager,
      (workerId) => this.onWorkerTaskComplete(workerId)
    );
  }

  private async initializeManager(): Promise<void> {
    if (!this.managerInstance) return;

    // Manager is EVENT-DRIVEN, not polling-based
    // It only acts when the Orchestrator sends it a prompt
    const prompt = `
You are the Manager instance of a Claude Code Orchestrator.

## Your Environment
- Working directory: /repo (main branch)
- Worker instances available: ${this.config.workerCount}
- Workers have their own worktrees at /repo/worktrees/worker-{N}

## IMPORTANT: You are EVENT-DRIVEN
- You will receive prompts from the Orchestrator when workers finish tasks
- Do NOT poll or "monitor" - just wait for the next prompt
- Each prompt will tell you exactly what happened and what to do

## Your Initial Task
1. Read PROJECT_DIRECTION.md to understand project goals
2. Break down the project into discrete, parallelizable tasks
3. **IMPORTANT**: Use the file_edit tool to create task files for each worker:
   - Create WORKER_1_TASK_LIST.md for worker 1
   - Create WORKER_2_TASK_LIST.md for worker 2
   - etc.
4. Each task file should contain a numbered list of specific tasks
5. Commit and push the task files so workers can see them
6. **THEN STOP** - Workers will start automatically. You'll be notified when they finish.

## Task File Format
Each WORKER_N_TASK_LIST.md should have this format:
\`\`\`markdown
# Worker N Task List

## Current Task
- [ ] Task description here

## Queue
- [ ] Next task
- [ ] Another task

## Completed
(empty initially)
\`\`\`

## Start Now
1. Read PROJECT_DIRECTION.md
2. Create task lists for all ${this.config.workerCount} workers
3. Commit the task files
4. Stop and wait for worker completion notifications
    `.trim();

    await this.instanceManager.sendPrompt('manager', prompt);
  }

  // EVENT-DRIVEN: Called by Orchestrator when worker finishes (via hook)
  private onWorkerTaskComplete(workerId: number): void {
    logger.info(`Worker ${workerId} completed task`);
    this.notifyManagerOfCompletion(workerId);
  }

  private async notifyManagerOfCompletion(workerId: number): Promise<void> {
    if (!this.managerInstance) return;

    // Lock the worker to prevent race conditions during merge
    await this.instanceManager.lockWorker(workerId);

    const prompt = `
## Event: Worker ${workerId} Task Complete

Worker ${workerId} has finished their current task and pushed to branch \`worker-${workerId}\`.

### Your Actions (in order):
1. **Fetch latest**: Run \`git fetch origin worker-${workerId}\`
2. **Review changes**: Check the diff with \`git diff main...origin/worker-${workerId}\`
3. **Merge if good**: 
   \`\`\`bash
   git checkout main
   git merge origin/worker-${workerId} --no-ff -m "Merge worker-${workerId} task completion"
   git push origin main
   \`\`\`
4. **Handle conflicts** (if any): Resolve them, then complete the merge
5. **Update task file**: Edit WORKER_${workerId}_TASK_LIST.md:
   - Move completed task to "Completed" section
   - Move next task from "Queue" to "Current Task"
   - If queue is empty, add a note that worker is done
6. **Commit task file**: Push the updated task file
7. **STOP**: The Orchestrator will notify the worker to continue

### After you're done
Just stop. The Orchestrator will:
- Unlock Worker ${workerId}
- Tell Worker ${workerId} to pull main and start their next task
    `.trim();
    
    await this.instanceManager.sendPrompt('manager', prompt);
  }

  // Called after Manager finishes merge (detected via Manager's Stop hook)
  private async onManagerMergeComplete(workerId: number): Promise<void> {
    // Unlock the worker
    await this.instanceManager.unlockWorker(workerId);

    // Tell worker to continue with next task
    const workerPrompt = `
## Event: Merge Complete

The Manager has merged your work into main and updated your task list.

### Your Actions:
1. Pull latest main: \`git pull origin main\`
2. Read your updated WORKER_${workerId}_TASK_LIST.md
3. Start working on your "Current Task"
4. When done, commit, push to your branch, and stop

If your task list shows you're done, just stop.
    `.trim();

    await this.instanceManager.sendPrompt(`worker-${workerId}`, workerPrompt);
  }
  }

  private async notifyManager(message: string): Promise<void> {
    if (this.managerInstance) {
      await this.instanceManager.sendPrompt('manager', message);
    }
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down orchestrator...');

    // Kill all tmux sessions
    await this.tmux.killAllOrchestratorSessions();

    // Stop all containers
    const { execa } = await import('execa');
    await execa('docker-compose', ['-f', './docker-compose.yml', 'down']);

    logger.info('Orchestrator shutdown complete');
  }
}
```

### 7.2 Task Scheduler (`src/orchestrator/scheduler.ts`)

```typescript
import { logger } from '../utils/logger';

export interface Task {
  id: string;
  description: string;
  priority: number;
  assignedTo?: number;
  status: 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
}

export class TaskScheduler {
  private tasks: Map<string, Task> = new Map();
  private taskQueue: string[] = [];

  addTask(task: Omit<Task, 'status' | 'createdAt'>): Task {
    const fullTask: Task = {
      ...task,
      status: 'pending',
      createdAt: new Date(),
    };
    
    this.tasks.set(task.id, fullTask);
    this.taskQueue.push(task.id);
    this.sortQueue();
    
    logger.info(`Task added: ${task.id}`);
    return fullTask;
  }

  getNextTask(): Task | undefined {
    const taskId = this.taskQueue.find(
      (id) => this.tasks.get(id)?.status === 'pending'
    );
    return taskId ? this.tasks.get(taskId) : undefined;
  }

  assignTask(taskId: string, workerId: number): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.assignedTo = workerId;
      task.status = 'assigned';
      logger.info(`Task ${taskId} assigned to worker ${workerId}`);
    }
  }

  completeTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'completed';
      task.completedAt = new Date();
      logger.info(`Task ${taskId} completed`);
    }
  }

  failTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'failed';
      task.assignedTo = undefined;
      logger.warn(`Task ${taskId} failed, returning to queue`);
    }
  }

  private sortQueue(): void {
    this.taskQueue.sort((a, b) => {
      const taskA = this.tasks.get(a)!;
      const taskB = this.tasks.get(b)!;
      return taskB.priority - taskA.priority;
    });
  }

  getPendingCount(): number {
    return Array.from(this.tasks.values()).filter(
      (t) => t.status === 'pending'
    ).length;
  }

  getStats(): { pending: number; inProgress: number; completed: number; failed: number } {
    const tasks = Array.from(this.tasks.values());
    return {
      pending: tasks.filter((t) => t.status === 'pending').length,
      inProgress: tasks.filter((t) => t.status === 'in_progress').length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
    };
  }
}
```

---

## Phase 8: Worker Instances

### 8.1 Worker Logic (`src/orchestrator/worker.ts`)

```typescript
import { ClaudeInstanceManager } from '../claude/instance';
import { GitManager } from '../git/worktree';
import { logger } from '../utils/logger';

export class WorkerController {
  constructor(
    private instanceManager: ClaudeInstanceManager,
    private git: GitManager
  ) {}

  async initializeWorker(workerId: number): Promise<void> {
    const instanceId = `worker-${workerId}`;
    
    // Create worker branch and worktree
    const branchName = `worker-${workerId}`;
    await this.git.createWorktree(branchName, `/workspace/worker-${workerId}`);

    const prompt = `
You are Worker ${workerId} in a Claude Code Orchestrator.
Your work directory is /workspace/worker-${workerId}
Your branch is: ${branchName}

Your responsibilities:
1. Read WORKER_${workerId}_TASK_LIST.md for your assigned tasks
2. Complete tasks one by one
3. Commit your work frequently with clear messages
4. Push your branch when a task is complete

Start by reading your task list and beginning work on the first task.
    `.trim();

    await this.instanceManager.sendPrompt(instanceId, prompt);
    logger.info(`Worker ${workerId} initialized`);
  }

  async assignTask(workerId: number, taskDescription: string): Promise<void> {
    const instanceId = `worker-${workerId}`;
    
    const prompt = `
New task assigned:
${taskDescription}

Please complete this task, commit your changes, and push to your branch.
    `.trim();

    await this.instanceManager.sendPrompt(instanceId, prompt);
    logger.info(`Task assigned to worker ${workerId}`);
  }

  async checkProgress(workerId: number): Promise<string> {
    const instanceId = `worker-${workerId}`;
    return this.instanceManager.getOutput(instanceId);
  }
}
```

### 8.2 Git Worktree Manager (`src/git/worktree.ts`)

```typescript
import { simpleGit, SimpleGit } from 'simple-git';
import { logger } from '../utils/logger';

export class GitManager {
  private git: SimpleGit;
  private baseDir: string = '/workspace';

  constructor() {
    this.git = simpleGit();
  }

  async clone(repoUrl: string, branch: string): Promise<void> {
    await this.git.clone(repoUrl, this.baseDir, ['--branch', branch]);
    this.git.cwd(this.baseDir);
    logger.info(`Cloned ${repoUrl} to ${this.baseDir}`);
  }

  async createWorktree(branchName: string, path: string): Promise<void> {
    // Create new branch from current HEAD
    await this.git.checkoutBranch(branchName, 'HEAD');
    
    // Create worktree
    await this.git.raw(['worktree', 'add', path, branchName]);
    logger.info(`Created worktree at ${path} for branch ${branchName}`);
  }

  async removeWorktree(path: string): Promise<void> {
    await this.git.raw(['worktree', 'remove', path, '--force']);
    logger.info(`Removed worktree at ${path}`);
  }

  async listWorktrees(): Promise<string[]> {
    const result = await this.git.raw(['worktree', 'list', '--porcelain']);
    const worktrees = result
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.replace('worktree ', ''));
    return worktrees;
  }

  async getBranchStatus(branchName: string): Promise<{ ahead: number; behind: number }> {
    const result = await this.git.raw([
      'rev-list',
      '--left-right',
      '--count',
      `main...${branchName}`,
    ]);
    const [behind, ahead] = result.trim().split('\t').map(Number);
    return { ahead, behind };
  }
}
```

### 8.3 Branch Merger (`src/git/merge.ts`)

```typescript
import { simpleGit, SimpleGit } from 'simple-git';
import { logger } from '../utils/logger';

export class BranchMerger {
  private git: SimpleGit;

  constructor(workDir: string) {
    this.git = simpleGit(workDir);
  }

  async mergeBranch(
    sourceBranch: string,
    targetBranch: string = 'main'
  ): Promise<{ success: boolean; conflicts?: string[] }> {
    try {
      await this.git.checkout(targetBranch);
      await this.git.merge([sourceBranch, '--no-ff', '-m', `Merge ${sourceBranch}`]);
      
      logger.info(`Successfully merged ${sourceBranch} into ${targetBranch}`);
      return { success: true };
    } catch (err: any) {
      if (err.message.includes('CONFLICT')) {
        const status = await this.git.status();
        const conflicts = status.conflicted;
        
        logger.warn(`Merge conflicts in ${sourceBranch}`, { conflicts });
        
        // Abort the merge to leave clean state
        await this.abortMerge();
        
        return { success: false, conflicts };
      }
      throw err;
    }
  }

  // Called when Manager needs to handle a merge conflict
  async notifyManagerOfConflict(
    workerId: number,
    sourceBranch: string,
    conflicts: string[]
  ): string {
    return `
Merge failed for worker ${workerId} (branch: ${sourceBranch}).

Conflicting files:
${conflicts.map(f => `- ${f}`).join('\n')}

Options:
1. Manually resolve conflicts in the files listed above
2. Instruct Worker ${workerId} to rebase their branch on main and fix conflicts
3. Use \`git checkout --ours <file>\` or \`git checkout --theirs <file>\` for simple resolutions

After resolving, run \`git add <files>\` and \`git commit\` to complete the merge.
    `.trim();
  }

  async abortMerge(): Promise<void> {
    await this.git.merge(['--abort']);
    logger.info('Merge aborted');
  }

  async resolveConflict(filePath: string, resolution: 'ours' | 'theirs'): Promise<void> {
    await this.git.checkout([`--${resolution}`, filePath]);
    await this.git.add(filePath);
    logger.info(`Resolved conflict in ${filePath} using ${resolution}`);
  }
}
```

---

## Phase 9: Rate Limit & Config Rotation

### 9.0 Cost & Usage Tracking (`src/orchestrator/cost-tracker.ts`)

```typescript
import { ClaudeInstanceManager } from '../claude/instance';
import { logger } from '../utils/logger';

export interface UsageStats {
  totalToolUses: number;
  toolUsesPerInstance: Map<string, number>;
  startTime: Date;
  runDurationMinutes: number;
}

export interface CostLimits {
  maxToolUsesPerInstance: number;  // e.g., 500
  maxTotalToolUses: number;         // e.g., 2000
  maxRunDurationMinutes: number;    // e.g., 120
}

export class CostTracker {
  private startTime: Date;
  private limits: CostLimits;

  constructor(
    private instanceManager: ClaudeInstanceManager,
    limits?: Partial<CostLimits>
  ) {
    this.startTime = new Date();
    this.limits = {
      maxToolUsesPerInstance: limits?.maxToolUsesPerInstance ?? 500,
      maxTotalToolUses: limits?.maxTotalToolUses ?? 2000,
      maxRunDurationMinutes: limits?.maxRunDurationMinutes ?? 120,
    };
  }

  getStats(): UsageStats {
    const instances = this.instanceManager.getAllInstances();
    const toolUsesPerInstance = new Map<string, number>();
    let totalToolUses = 0;

    for (const instance of instances) {
      toolUsesPerInstance.set(instance.id, instance.toolUseCount);
      totalToolUses += instance.toolUseCount;
    }

    return {
      totalToolUses,
      toolUsesPerInstance,
      startTime: this.startTime,
      runDurationMinutes: (Date.now() - this.startTime.getTime()) / 60000,
    };
  }

  checkLimits(): { exceeded: boolean; reason?: string } {
    const stats = this.getStats();

    if (stats.totalToolUses >= this.limits.maxTotalToolUses) {
      return { exceeded: true, reason: `Total tool uses (${stats.totalToolUses}) exceeded limit (${this.limits.maxTotalToolUses})` };
    }

    if (stats.runDurationMinutes >= this.limits.maxRunDurationMinutes) {
      return { exceeded: true, reason: `Run duration (${stats.runDurationMinutes.toFixed(1)}m) exceeded limit (${this.limits.maxRunDurationMinutes}m)` };
    }

    for (const [instanceId, count] of stats.toolUsesPerInstance) {
      if (count >= this.limits.maxToolUsesPerInstance) {
        return { exceeded: true, reason: `Instance ${instanceId} tool uses (${count}) exceeded limit (${this.limits.maxToolUsesPerInstance})` };
      }
    }

    return { exceeded: false };
  }

  logStats(): void {
    const stats = this.getStats();
    logger.info('Usage stats', {
      totalToolUses: stats.totalToolUses,
      runDurationMinutes: stats.runDurationMinutes.toFixed(1),
      perInstance: Object.fromEntries(stats.toolUsesPerInstance),
    });
  }
}
```

### 9.0.1 Stuck Detection (`src/orchestrator/stuck-detector.ts`)

```typescript
import { ClaudeInstanceManager } from '../claude/instance';
import { logger } from '../utils/logger';

const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes without tool use

export class StuckDetector {
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(
    private instanceManager: ClaudeInstanceManager,
    private onStuck: (instanceId: string) => Promise<void>
  ) {}

  start(intervalMs: number = 60000): void {
    this.checkInterval = setInterval(() => this.check(), intervalMs);
    logger.info('Stuck detector started');
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  private async check(): Promise<void> {
    const instances = this.instanceManager.getAllInstances();
    const now = Date.now();

    for (const instance of instances) {
      if (instance.status !== 'busy') continue;
      
      const lastActivity = instance.lastToolUse?.getTime() ?? 0;
      const idleTime = now - lastActivity;

      if (idleTime > STUCK_THRESHOLD_MS && lastActivity > 0) {
        logger.warn(`Instance ${instance.id} appears stuck (no activity for ${(idleTime / 60000).toFixed(1)}m)`);
        await this.onStuck(instance.id);
      }
    }
  }
}
```

### 9.1 Config Rotator (`src/claude/config-rotator.ts`)

```typescript
import { readFile, writeFile, copyFile } from 'fs/promises';
import { logger } from '../utils/logger';

interface ConfigStatus {
  path: string;
  inUse: boolean;
  rateLimited: boolean;
  rateLimitedUntil?: Date;
  assignedTo?: string;
}

export class ConfigRotator {
  private configs: Map<string, ConfigStatus> = new Map();

  constructor(configPaths: string[]) {
    for (const path of configPaths) {
      this.configs.set(path, {
        path,
        inUse: false,
        rateLimited: false,
      });
    }
  }

  async assignConfig(instanceId: string): Promise<string | null> {
    // Find available config
    const available = Array.from(this.configs.values()).find(
      (c) => !c.inUse && !c.rateLimited
    );

    if (!available) {
      logger.warn('No available configs');
      return null;
    }

    available.inUse = true;
    available.assignedTo = instanceId;
    
    logger.info(`Assigned config ${available.path} to ${instanceId}`);
    return available.path;
  }

  async releaseConfig(configPath: string): Promise<void> {
    const config = this.configs.get(configPath);
    if (config) {
      config.inUse = false;
      config.assignedTo = undefined;
      logger.info(`Released config ${configPath}`);
    }
  }

  async markRateLimited(configPath: string, retryAfterMinutes: number = 60): Promise<void> {
    const config = this.configs.get(configPath);
    if (config) {
      config.rateLimited = true;
      config.rateLimitedUntil = new Date(Date.now() + retryAfterMinutes * 60 * 1000);
      
      logger.warn(`Config ${configPath} rate limited until ${config.rateLimitedUntil}`);
      
      // Schedule reset
      setTimeout(() => {
        config.rateLimited = false;
        config.rateLimitedUntil = undefined;
        logger.info(`Config ${configPath} rate limit expired`);
      }, retryAfterMinutes * 60 * 1000);
    }
  }

  async rotateConfig(instanceId: string, currentConfigPath: string): Promise<string | null> {
    // Release current config and mark as rate limited
    await this.releaseConfig(currentConfigPath);
    await this.markRateLimited(currentConfigPath);

    // Assign new config
    return this.assignConfig(instanceId);
  }

  getStats(): { total: number; available: number; inUse: number; rateLimited: number } {
    const configs = Array.from(this.configs.values());
    return {
      total: configs.length,
      available: configs.filter((c) => !c.inUse && !c.rateLimited).length,
      inUse: configs.filter((c) => c.inUse).length,
      rateLimited: configs.filter((c) => c.rateLimited).length,
    };
  }
}
```

### 9.2 Config Swap Handler with Context Restoration

```typescript
// In src/orchestrator/manager.ts - add this method

async handleRateLimitHook(instanceId: string): Promise<void> {
  const instance = this.instanceManager.getInstance(instanceId);
  if (!instance) return;

  logger.warn(`Rotating config for ${instanceId} due to rate limit`);

  // FIXED: Save context before restart
  const savedTask = instance.currentTaskFull;

  // Get new config
  const newConfigPath = await this.configRotator.rotateConfig(
    instanceId,
    instance.configPath
  );

  if (!newConfigPath) {
    logger.error(`No available configs for ${instanceId}`);
    instance.status = 'error';
    return;
  }

  // Update instance config
  instance.configPath = newConfigPath;

  // Copy new config to container
  await this.docker.execInContainer(instance.containerName, [
    'cp', newConfigPath, '/root/.claude/settings.json'
  ]);

  // Restart Claude in the instance
  await this.tmux.sendKeys(instance.sessionName, 'C-c'); // Interrupt
  await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for clean exit
  await this.tmux.sendKeys(instance.sessionName, 'claude --dangerously-skip-permissions'); // Restart

  // FIXED: Restore context after restart
  if (savedTask) {
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for Claude to initialize
    const resumePrompt = `
You were restarted due to API rate limits. Your configuration has been rotated.

Your previous task was:
${savedTask}

Please resume this task from where you left off. Check your recent file changes and git status to understand your progress.
    `.trim();
    
    await this.instanceManager.sendPrompt(instanceId, resumePrompt);
  }

  logger.info(`Config rotated for ${instanceId}, context restored`);
}
```

---

## Phase 10: Health Monitoring & Recovery

### 10.1 Health Monitor (`src/docker/health.ts`)

```typescript
import { DockerManager } from './manager';
import { logger } from '../utils/logger';

interface HealthStatus {
  containerName: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  lastCheck: Date;
  consecutiveFailures: number;
}

export class HealthMonitor {
  private statuses: Map<string, HealthStatus> = new Map();
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(
    private docker: DockerManager,
    private onUnhealthy: (containerName: string) => Promise<void>
  ) {}

  start(intervalMs: number = 30000): void {
    this.checkInterval = setInterval(() => this.checkAll(), intervalMs);
    logger.info(`Health monitor started (interval: ${intervalMs}ms)`);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('Health monitor stopped');
    }
  }

  private async checkAll(): Promise<void> {
    const containers = Array.from(this.statuses.keys());
    
    for (const containerName of containers) {
      await this.checkContainer(containerName);
    }
  }

  async checkContainer(containerName: string): Promise<void> {
    const status = await this.docker.getContainerStatus(containerName);
    const healthStatus = this.statuses.get(containerName) || {
      containerName,
      status: 'unknown',
      lastCheck: new Date(),
      consecutiveFailures: 0,
    };

    if (status === 'running') {
      healthStatus.status = 'healthy';
      healthStatus.consecutiveFailures = 0;
    } else {
      healthStatus.status = 'unhealthy';
      healthStatus.consecutiveFailures++;
      
      logger.warn(`Container ${containerName} unhealthy (failures: ${healthStatus.consecutiveFailures})`);

      if (healthStatus.consecutiveFailures >= 3) {
        await this.onUnhealthy(containerName);
      }
    }

    healthStatus.lastCheck = new Date();
    this.statuses.set(containerName, healthStatus);
  }

  registerContainer(containerName: string): void {
    this.statuses.set(containerName, {
      containerName,
      status: 'unknown',
      lastCheck: new Date(),
      consecutiveFailures: 0,
    });
  }

  getStatus(containerName: string): HealthStatus | undefined {
    return this.statuses.get(containerName);
  }

  getAllStatuses(): HealthStatus[] {
    return Array.from(this.statuses.values());
  }
}
```

### 10.2 Recovery Handler

```typescript
// In src/orchestrator/manager.ts - add recovery logic

async handleUnhealthyContainer(containerName: string): Promise<void> {
  logger.warn(`Handling unhealthy container: ${containerName}`);

  // Find the instance
  const instance = this.instanceManager.getAllInstances().find(
    (i) => i.containerName === containerName
  );

  if (!instance) {
    logger.error(`Instance not found for container: ${containerName}`);
    return;
  }

  // Mark instance as error
  instance.status = 'error';

  // Attempt recovery
  try {
    // 1. Try to restart the container
    await this.docker.restartContainer(containerName);
    
    // 2. Wait for container to be ready
    await this.waitForContainer(containerName);

    // 3. Re-attach tmux session
    await this.tmux.attachToContainer(instance.sessionName, containerName);

    // 4. Reinitialize Claude
    if (instance.type === 'manager') {
      await this.initializeManager();
    } else {
      await this.workerController.initializeWorker(instance.workerId);
    }

    instance.status = 'ready';
    logger.info(`Successfully recovered container: ${containerName}`);
  } catch (err) {
    logger.error(`Failed to recover container: ${containerName}`, err);
    // Could implement escalation logic here
  }
}

private async waitForContainer(containerName: string, timeoutMs: number = 60000): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const status = await this.docker.getContainerStatus(containerName);
    if (status === 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Container ${containerName} did not become ready in time`);
}
```

---

## Phase 11: Testing & Documentation

### 11.1 Unit Tests

```typescript
// tests/unit/config-loader.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigLoader } from '../../src/config/loader';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('ConfigLoader', () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'orchestrator-test-'));
  });

  it('should load valid orchestrator config', async () => {
    const config = {
      repositoryUrl: 'https://github.com/test/repo.git',
      branch: 'main',
      workerCount: 3,
      claudeConfigs: '~/configs/*.json',
    };

    await writeFile(
      join(configDir, 'orchestrator.json'),
      JSON.stringify(config)
    );

    const loader = new ConfigLoader(configDir);
    const loaded = await loader.loadOrchestratorConfig();

    expect(loaded.repositoryUrl).toBe(config.repositoryUrl);
    expect(loaded.workerCount).toBe(3);
  });

  it('should throw on invalid config', async () => {
    await writeFile(
      join(configDir, 'orchestrator.json'),
      JSON.stringify({ invalid: true })
    );

    const loader = new ConfigLoader(configDir);
    await expect(loader.loadOrchestratorConfig()).rejects.toThrow();
  });
});
```

### 11.2 Integration Tests

```typescript
// tests/integration/orchestrator.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Orchestrator } from '../../src/orchestrator/manager';
import { DockerManager } from '../../src/docker/manager';

describe('Orchestrator Integration', () => {
  let orchestrator: Orchestrator;

  beforeAll(async () => {
    // Setup test environment
  });

  afterAll(async () => {
    // Cleanup
  });

  it('should start all instances', async () => {
    // Test implementation
  });

  it('should handle worker task completion', async () => {
    // Test implementation
  });

  it('should rotate configs on rate limit', async () => {
    // Test implementation
  });
});
```

### 11.3 Documentation Files to Create

1. **README.md** - Getting started guide
2. **docs/configuration.md** - Detailed config documentation
3. **docs/architecture.md** - System architecture deep dive
4. **docs/troubleshooting.md** - Common issues and solutions
5. **docs/api.md** - Hook API documentation

### 11.4 Cleanup Script (`scripts/cleanup.sh`)

Force cleanup of orphaned resources if orchestrator crashes:

```bash
#!/bin/bash
# scripts/cleanup.sh - Force cleanup orphaned orchestrator resources

echo "Cleaning up Claude Code Orchestrator resources..."

# Kill all orchestrator tmux sessions
echo "Killing tmux sessions..."
tmux list-sessions 2>/dev/null | grep '^claude-' | cut -d: -f1 | while read session; do
    echo "  Killing session: $session"
    tmux kill-session -t "$session" 2>/dev/null
done

# Stop and remove orchestrator containers
echo "Stopping Docker containers..."
docker ps -a --filter "label=orchestrator.instance" --format "{{.Names}}" | while read container; do
    echo "  Stopping: $container"
    docker stop "$container" 2>/dev/null
    docker rm "$container" 2>/dev/null
done

# Remove docker-compose resources
if [ -f "./docker-compose.yml" ]; then
    echo "Running docker-compose down..."
    docker-compose down -v 2>/dev/null
fi

# Clean up any orphaned volumes
echo "Cleaning up volumes..."
docker volume ls --filter "name=repo-data" -q | xargs -r docker volume rm 2>/dev/null

echo "Cleanup complete!"
```

### 11.5 Periodic Volume Cleanup

> **Note**: The `repo-data` volume accumulates git history from past runs. Clean it periodically.

```bash
# scripts/hard-reset.sh - Full reset including persistent data

#!/bin/bash
echo "Performing HARD RESET - this will delete all orchestrator data!"
read -p "Are you sure? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "Aborted."
    exit 0
fi

# Run normal cleanup first
./scripts/cleanup.sh

# Remove ALL orchestrator volumes (including repo data)
echo "Removing persistent volumes..."
docker volume ls --filter "name=repo-data" -q | xargs -r docker volume rm 2>/dev/null
docker volume ls --filter "name=claude-" -q | xargs -r docker volume rm 2>/dev/null

# Remove generated files
rm -f docker-compose.yml
rm -rf ./workspaces
rm -rf ./claude-configs

echo "Hard reset complete. All orchestrator data has been removed."
```

---

## Implementation Timeline

| Phase | Duration | Dependencies | Notes |
|-------|----------|--------------|-------|
| **Phase 0: Feasibility** | 1 day | None | **MUST PASS before continuing** |
| Phase 1: Foundation | 1 day | Phase 0 | |
| Phase 2: Configuration | 1 day | Phase 1 | Includes config validation |
| Phase 3: Docker | 2 days | Phase 1 | Fixed volume mounting |
| Phase 4: tmux | 1 day | Phase 1 | Fixed docker exec approach |
| Phase 5: Claude Integration | 2 days | Phase 3, 4 | With --dangerously-skip-permissions |
| Phase 6: Hook System | 2 days | Phase 5 | Added ToolUse hook |
| Phase 7: Manager | 3 days | Phase 5, 6 | Improved prompting |
| Phase 8: Workers | 2 days | Phase 5, 6 | |
| Phase 9: Rate Limiting | 2 days | Phase 7, 8 | Added cost tracking, stuck detection |
| Phase 10: Health Monitoring | 2 days | Phase 7, 8 | Added cleanup handlers |
| Phase 11: Testing & Docs | 3 days | All phases | |

**Total estimated time: ~3.5 weeks** (added 0.5 week for Phase 0 and additional robustness features)

---

## Next Steps

1. [ ] **Phase 0: Run feasibility prototype** — validate permission bypass works
2. [ ] Initialize project with `npm init`
3. [ ] Install dependencies
4. [ ] Set up TypeScript configuration
5. [ ] Create base Docker image with `--dangerously-skip-permissions`
6. [ ] Implement config loader with validation
7. [ ] Build out remaining phases iteratively

---

## Appendix: Risk Mitigation Summary

| Risk | Severity | Mitigation | Status |
|------|----------|------------|--------|
| Interactive permission blocking | RESOLVED | `--dangerously-skip-permissions` (safe in Docker) | ✅ Safe |
| Terminal scraping unreliability | MEDIUM | Use hooks for control flow, not screen scrape | ✅ Documented |
| Context loss on config rotation | MEDIUM | Save & restore task context | ✅ Added |
| Git worktree volume mounting | MEDIUM | Shared `repo-data` volume | ✅ Fixed |
| tmux docker attach fragility | MEDIUM | Use `docker exec` directly in tmux command | ✅ Fixed |
| Claude config validation | LOW | Validate JSON before orchestration | ✅ Added |
| Zombie process cleanup | MEDIUM | SIGINT/SIGTERM handlers + cleanup script | ✅ Added |
| Cost runaway | MEDIUM | Tool use tracking + limits | ✅ Added |
| Stuck worker detection | MEDIUM | ToolUse hook heartbeat + 5min timeout | ✅ Added |
| Merge conflict handling | LOW | Manager notification with resolution options | ✅ Added |
| **Auth portability** | CRITICAL | Validate in Phase 0; prefer `ANTHROPIC_API_KEY` env var | ⬜ Phase 0 |
| **Rate limit detection** | MEDIUM | Regex scrape tmux output (hooks may not exist) | ✅ Added |
| **Git race conditions** | LOW | Lock worker during Manager merge | ✅ Added |
| **Manager polling loop** | MEDIUM | Event-driven architecture; Manager only acts on prompts | ✅ Fixed |
| **Volume disk growth** | LOW | Periodic cleanup with hard-reset script | ✅ Added |
