/**
 * Local runner - runs Claude Code instances directly without Docker.
 * Uses the host's OAuth authentication.
 */

import { OrchestratorConfig } from '../config/schema.js';
import { HookServer } from '../server.js';
import { TmuxManager } from '../tmux/session.js';
import { ClaudeInstanceManager, ClaudeInstance, InstanceType } from '../claude/instance.js';
import { registerHookHandlers } from '../claude/hook-handlers.js';
import { GitManager } from '../git/worktree.js';
import { execa } from 'execa';
import { mkdir, rm } from 'fs/promises';
import { logger } from '../utils/logger.js';

export class LocalOrchestrator {
  private hookServer: HookServer;
  private tmux: TmuxManager;
  private instanceManager: ClaudeInstanceManager;
  private git!: GitManager;
  private managerInstance?: ClaudeInstance;
  private isShuttingDown = false;
  private workspaceDir: string;

  constructor(
    private config: OrchestratorConfig,
    workspaceDir: string = '/tmp/orchestrator-workspace'
  ) {
    this.workspaceDir = workspaceDir;
    this.hookServer = new HookServer(config.hookServerPort);
    this.tmux = new TmuxManager();
    // Pass a mock docker manager since we're not using Docker
    this.instanceManager = new ClaudeInstanceManager(null as any, this.tmux);
  }

  async start(): Promise<void> {
    logger.info('Starting local orchestrator (no Docker)...');

    try {
      // 1. Clean up any previous workspace
      await this.cleanWorkspace();

      // 2. Start hook server
      await this.hookServer.start();

      // 3. Register hook handlers
      this.registerHandlers();

      // 4. Clone repository
      await this.setupRepository();

      // 5. Create Claude instances (tmux sessions)
      await this.createInstances();

      // 6. Initialize manager
      await this.initializeManager();

      logger.info('Local orchestrator started successfully', {
        workerCount: this.config.workerCount,
        hookPort: this.config.hookServerPort,
        workspace: this.workspaceDir,
      });
    } catch (err) {
      logger.error('Failed to start local orchestrator', err);
      await this.shutdown();
      throw err;
    }
  }

  private async cleanWorkspace(): Promise<void> {
    try {
      await rm(this.workspaceDir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
    await mkdir(this.workspaceDir, { recursive: true });
  }

  private async setupRepository(): Promise<void> {
    logger.info('Cloning repository...', { url: this.config.repositoryUrl });

    // Clone the repo
    await execa('git', ['clone', this.config.repositoryUrl, this.workspaceDir]);

    this.git = new GitManager(this.workspaceDir);

    // Create worktrees for workers
    const worktreesDir = `${this.workspaceDir}/worktrees`;
    await mkdir(worktreesDir, { recursive: true });

    for (let i = 1; i <= this.config.workerCount; i++) {
      const branchName = `worker-${i}`;
      const worktreePath = `${worktreesDir}/worker-${i}`;

      // Create branch
      await execa('git', ['-C', this.workspaceDir, 'branch', branchName], {
        reject: false,
      });

      // Create worktree
      await execa('git', ['-C', this.workspaceDir, 'worktree', 'add', worktreePath, branchName]);

      logger.info(`Created worktree for worker-${i}`, { path: worktreePath });
    }
  }

  private async createInstances(): Promise<void> {
    // Create manager instance
    await this.createLocalInstance('manager', 'manager', 0, this.workspaceDir);

    // Create worker instances
    for (let i = 1; i <= this.config.workerCount; i++) {
      const worktreePath = `${this.workspaceDir}/worktrees/worker-${i}`;
      await this.createLocalInstance(`worker-${i}`, 'worker', i, worktreePath);
    }

    logger.info(`Created ${this.config.workerCount + 1} Claude instances`);
  }

  private async createLocalInstance(
    id: string,
    type: InstanceType,
    workerId: number,
    workDir: string
  ): Promise<ClaudeInstance> {
    const sessionName = `claude-${id}`;

    // Kill existing session if any
    await this.tmux.killSession(sessionName).catch(() => {});

    // Create tmux session running Claude in the work directory
    const claudeCmd = `cd "${workDir}" && claude --dangerously-skip-permissions`;

    await execa('tmux', ['new-session', '-d', '-s', sessionName, '-c', workDir]);
    await this.tmux.sendKeys(sessionName, claudeCmd);

    const instance: ClaudeInstance = {
      id,
      type,
      workerId,
      containerName: `local-${id}`,
      sessionName,
      status: 'ready',
      configPath: '',
      toolUseCount: 0,
      createdAt: new Date(),
    };

    // Store in instance manager
    (this.instanceManager as any).instances.set(id, instance);

    logger.info(`Created local Claude instance: ${id}`, { workDir });
    return instance;
  }

  private registerHandlers(): void {
    registerHookHandlers(this.hookServer, this.instanceManager, {
      onTaskComplete: (workerId, instanceType) => {
        this.handleTaskComplete(workerId, instanceType);
      },
      onError: (instanceId, error) => {
        logger.error(`Instance ${instanceId} error`, error);
      },
      onRateLimit: (instanceId) => {
        logger.warn(`Instance ${instanceId} rate limited`);
      },
    });
  }

  private async initializeManager(): Promise<void> {
    this.managerInstance = this.instanceManager.getInstance('manager');
    if (!this.managerInstance) return;

    // Wait for Claude to initialize
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const prompt = `
You are the **Manager** instance of a Claude Code Orchestrator.

## Your Environment
- Working directory: ${this.workspaceDir} (main branch)
- Worker instances: ${this.config.workerCount} workers
- Workers have worktrees at: ${this.workspaceDir}/worktrees/worker-{N}

## CRITICAL: Event-Driven Architecture
- Do NOT poll or loop - just complete your task and STOP
- You'll receive new prompts when workers finish

## Your Task Now

1. **Read PROJECT_DIRECTION.md** to understand what to build

2. **Create task lists** for each worker:
   - WORKER_1_TASK_LIST.md
   - WORKER_2_TASK_LIST.md

   Format:
   \`\`\`markdown
   # Worker N Task List

   ## Current Task
   - [ ] First task with clear description

   ## Queue
   - [ ] Second task
   - [ ] Third task

   ## Completed
   (none yet)
   \`\`\`

3. **Commit and push**:
   \`\`\`bash
   git add WORKER_*.md
   git commit -m "Add worker task lists"
   git push origin main
   \`\`\`

4. **STOP** after pushing - workers will start automatically

Begin now: Read PROJECT_DIRECTION.md and create the task lists.
    `.trim();

    await this.instanceManager.sendPrompt('manager', prompt);

    // Initialize workers after a delay
    setTimeout(() => this.initializeWorkers(), 10000);
  }

  private async initializeWorkers(): Promise<void> {
    for (let i = 1; i <= this.config.workerCount; i++) {
      await this.initializeWorker(i);
      // Stagger worker starts
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  private async initializeWorker(workerId: number): Promise<void> {
    const prompt = `
You are **Worker ${workerId}** in a Claude Code Orchestrator.

## Your Environment
- Working directory: ${this.workspaceDir}/worktrees/worker-${workerId}
- Your branch: worker-${workerId}

## Your Workflow

1. **Pull latest and read your tasks**:
   \`\`\`bash
   git pull origin main
   cat WORKER_${workerId}_TASK_LIST.md
   \`\`\`

2. **Work on "Current Task"** from your task list

3. **When done, commit and push**:
   \`\`\`bash
   git add -A
   git commit -m "Complete: <description>"
   git push origin worker-${workerId}
   \`\`\`

4. **STOP after pushing** - wait for Manager to merge

Start now: Pull main and read your task list.
    `.trim();

    await this.instanceManager.sendPrompt(`worker-${workerId}`, prompt);
    logger.info(`Worker ${workerId} initialized`);
  }

  private handleTaskComplete(workerId: number, instanceType: 'manager' | 'worker'): void {
    if (this.isShuttingDown) return;

    if (instanceType === 'worker') {
      logger.info(`Worker ${workerId} completed task - notifying manager`);
      this.notifyManagerOfCompletion(workerId);
    } else {
      logger.info('Manager completed task');
    }
  }

  private async notifyManagerOfCompletion(workerId: number): Promise<void> {
    const prompt = `
## Worker ${workerId} Completed

Worker ${workerId} pushed to branch \`worker-${workerId}\`.

### Actions:
1. Review: \`git fetch origin worker-${workerId} && git diff main...origin/worker-${workerId}\`
2. Merge: \`git merge origin/worker-${workerId} --no-ff -m "Merge worker-${workerId}"\`
3. Push: \`git push origin main\`
4. Update WORKER_${workerId}_TASK_LIST.md (move task to Completed, set next Current Task)
5. Commit the task list update
6. STOP
    `.trim();

    await this.instanceManager.sendPrompt('manager', prompt);
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info('Shutting down local orchestrator...');

    await this.hookServer.stop();
    await this.tmux.killAllOrchestratorSessions();

    logger.info('Local orchestrator shutdown complete');
  }
}
