/**
 * Host-Native Orchestrator
 *
 * Runs Claude Code instances directly on the host using tmux sessions.
 * Uses Git Worktrees for file isolation and env vars for auth isolation.
 *
 * Auth Strategy:
 * - Default: Uses host's OAuth (no env vars needed)
 * - Fallback: Injects ANTHROPIC_API_KEY into specific tmux sessions
 */

import { OrchestratorConfig } from '../config/schema.js';
import { HookServer } from '../server.js';
import { TmuxManager } from '../tmux/session.js';
import { ClaudeInstanceManager, ClaudeInstance } from '../claude/instance.js';
import { RateLimitDetector } from '../claude/rate-limit-detector.js';
import { registerHookHandlers } from '../claude/hook-handlers.js';
import { GitManager } from '../git/worktree.js';
import { CostTracker } from './cost-tracker.js';
import { StuckDetector } from './stuck-detector.js';
import { generateClaudeSettings } from '../claude/hooks.js';
import { execa } from 'execa';
import { mkdir, rm, copyFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';

const ENV_FILES = ['.env', '.env.local'];

/**
 * Queue for manager merge operations.
 * Prevents multiple workers from overwhelming the manager simultaneously.
 */
class MergeQueue {
  private queue: number[] = [];
  private isProcessing = false;

  constructor(private processFunc: (workerId: number) => Promise<void>) {}

  enqueue(workerId: number): void {
    if (!this.queue.includes(workerId)) {
      this.queue.push(workerId);
      logger.info(`Merge queue: added worker-${workerId} (queue size: ${this.queue.length})`);
    }
  }

  async processNext(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    const workerId = this.queue.shift()!;

    try {
      logger.info(`Merge queue: processing worker-${workerId} (${this.queue.length} remaining)`);
      await this.processFunc(workerId);
    } catch (err) {
      logger.error(`Merge queue: failed to process worker-${workerId}`, err);
      this.queue.unshift(workerId);
    } finally {
      this.isProcessing = false;
    }
  }

  size(): number {
    return this.queue.length;
  }
}

/**
 * Auth configuration for a Claude instance.
 * Can be OAuth (empty), API key, or z.ai style.
 */
export interface AuthConfig {
  name: string;
  env: Record<string, string>;
}

export class Orchestrator {
  private hookServer: HookServer;
  private tmux: TmuxManager;
  private instanceManager: ClaudeInstanceManager;
  private rateLimitDetector: RateLimitDetector;
  private costTracker: CostTracker;
  private stuckDetector: StuckDetector;
  private git!: GitManager;
  private mergeQueue: MergeQueue;
  private reconcileInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private workspaceDir: string;

  // Auth configs for rotation (OAuth is used by default when no config is set)
  private authConfigs: AuthConfig[] = [];
  private authConfigIndex = 0;

  constructor(
    private config: OrchestratorConfig,
    workspaceDir: string = '/tmp/orchestrator-workspace',
    authConfigs: AuthConfig[] = []
  ) {
    this.workspaceDir = workspaceDir;
    this.authConfigs = authConfigs;

    // Initialize components
    this.hookServer = new HookServer(config.hookServerPort);
    this.tmux = new TmuxManager();
    this.instanceManager = new ClaudeInstanceManager(this.tmux);

    this.rateLimitDetector = new RateLimitDetector(
      this.tmux,
      this.instanceManager,
      (instanceId) => this.handleRateLimit(instanceId)
    );

    this.costTracker = new CostTracker(this.instanceManager, {
      maxToolUsesPerInstance: config.maxToolUsesPerInstance,
      maxTotalToolUses: config.maxTotalToolUses,
      maxRunDurationMinutes: config.maxRunDurationMinutes,
    });

    this.stuckDetector = new StuckDetector(
      this.instanceManager,
      (id) => this.handleStuckInstance(id),
      config.stuckThresholdMs,
      this.tmux
    );

    this.mergeQueue = new MergeQueue((workerId) => this.notifyManagerOfCompletion(workerId));
  }

  async start(): Promise<void> {
    logger.info('Starting host-native orchestrator...');

    try {
      // 1. Clean up any previous workspace
      await this.cleanWorkspace();

      // 2. Start hook server
      await this.hookServer.start();

      // 3. Register hook handlers
      this.registerHandlers();

      // 4. Clone repository and set up worktrees
      await this.setupRepository();

      // 5. Create Claude instances (tmux sessions)
      await this.createInstances();

      // 6. Start monitors
      this.rateLimitDetector.start(10000);
      this.stuckDetector.start(60000);
      this.startReconcileLoop(30000);

      // 7. Initialize manager
      await this.initializeManager();

      logger.info('Orchestrator started successfully', {
        workerCount: this.config.workerCount,
        hookPort: this.config.hookServerPort,
        workspace: this.workspaceDir,
        authConfigsAvailable: this.authConfigs.length,
        authMode: this.authConfigs.length > 0
          ? `hybrid (OAuth + ${this.authConfigs.map(c => c.name).join(', ')})`
          : 'OAuth only',
      });
    } catch (err) {
      logger.error('Failed to start orchestrator', err);
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
    logger.info('Cloning repository...', { url: this.config.repositoryUrl, branch: this.config.branch });

    // Clone the repo
    const cloneArgs = ['clone', '--branch', this.config.branch, this.config.repositoryUrl, this.workspaceDir];
    if (this.config.cloneDepth) {
      cloneArgs.push('--depth', String(this.config.cloneDepth));
    }
    await execa('git', cloneArgs);

    this.git = new GitManager(this.workspaceDir);

    // Create worktrees for workers in parallel
    const worktreesDir = `${this.workspaceDir}/worktrees`;
    await mkdir(worktreesDir, { recursive: true });

    const createWorktree = async (i: number) => {
      const branchName = `worker-${i}`;
      const worktreePath = `${worktreesDir}/worker-${i}`;

      await execa('git', ['-C', this.workspaceDir, 'branch', branchName], { reject: false });
      await execa('git', ['-C', this.workspaceDir, 'worktree', 'add', worktreePath, branchName]);
      await this.copyEnvFiles(this.workspaceDir, worktreePath);

      logger.info(`Created worktree for worker-${i}`, { path: worktreePath });
    };

    await Promise.all(
      Array.from({ length: this.config.workerCount }, (_, i) => createWorktree(i + 1))
    );
  }

  private async copyEnvFiles(sourceDir: string, destDir: string): Promise<void> {
    for (const envFile of ENV_FILES) {
      const sourcePath = join(sourceDir, envFile);
      const destPath = join(destDir, envFile);

      if (existsSync(sourcePath)) {
        try {
          await copyFile(sourcePath, destPath);
          logger.debug(`Copied ${envFile} to ${destDir}`);
        } catch (err) {
          logger.warn(`Failed to copy ${envFile} to ${destDir}`, err);
        }
      }
    }
  }

  private async createInstances(): Promise<void> {
    // Create manager instance (uses OAuth by default)
    await this.createInstance('manager', 'manager', 0, this.workspaceDir);

    // Create worker instances
    for (let i = 1; i <= this.config.workerCount; i++) {
      const worktreePath = `${this.workspaceDir}/worktrees/worker-${i}`;
      await this.createInstance(`worker-${i}`, 'worker', i, worktreePath);
    }

    logger.info(`Created ${this.config.workerCount + 1} Claude instances`);
  }

  /**
   * Create a Claude instance with optional auth config override.
   * If no authConfig is provided, Claude uses host OAuth.
   */
  private async createInstance(
    id: string,
    type: 'manager' | 'worker',
    workerId: number,
    workDir: string,
    authConfig?: AuthConfig
  ): Promise<ClaudeInstance> {
    const sessionName = `claude-${id}`;

    // Build environment variables
    const env: Record<string, string> = {
      FORCE_COLOR: '1',
    };

    // If auth config provided, inject its env vars (overrides OAuth)
    if (authConfig) {
      Object.assign(env, authConfig.env);
    }

    // Write hooks configuration to Claude settings.json
    const orchestratorUrl = `http://localhost:${this.config.hookServerPort}`;
    const settings = generateClaudeSettings(orchestratorUrl, id, workerId, type, { env });
    const claudeDir = join(workDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));
    logger.debug(`Wrote hooks to settings.json`, { path: settingsPath });

    // Create tmux session with env vars and start Claude
    await this.tmux.createSessionWithClaude(sessionName, workDir, env);

    const instance: ClaudeInstance = {
      id,
      type,
      workerId,
      sessionName,
      workDir,
      status: 'ready',
      toolUseCount: 0,
      createdAt: new Date(),
      apiKey: authConfig?.name, // Store auth config name for reference
    };

    this.instanceManager.addInstance(instance);
    logger.info(`Created instance: ${id}`, {
      workDir,
      authConfig: authConfig?.name ?? 'OAuth',
    });

    return instance;
  }

  private registerHandlers(): void {
    registerHookHandlers(this.hookServer, this.instanceManager, {
      onTaskComplete: (workerId, instanceType) => this.handleTaskComplete(workerId, instanceType),
      onError: (instanceId, error) => logger.error(`Instance ${instanceId} error`, error),
      onRateLimit: (instanceId) => this.handleRateLimit(instanceId),
    });
  }

  /**
   * Handle rate limit by rotating to a different auth config.
   * Kills the session and restarts Claude with new env vars.
   */
  private async handleRateLimit(instanceId: string): Promise<void> {
    const instance = this.instanceManager.getInstance(instanceId);
    if (!instance) return;

    logger.warn(`Rate limit for ${instanceId}, rotating auth...`);

    // Save task context
    const savedTask = instance.currentTaskFull;

    // Get next auth config (or null for OAuth)
    const nextAuth = this.getNextAuthConfig();

    // Kill current session completely
    await this.tmux.killSession(instance.sessionName);
    this.instanceManager.removeInstance(instanceId);

    // Re-create with new auth config (Claude restarts with new env vars)
    await this.createInstance(
      instance.id,
      instance.type,
      instance.workerId,
      instance.workDir,
      nextAuth ?? undefined
    );

    logger.info(`Rotated ${instanceId} to ${nextAuth?.name ?? 'OAuth'}`);

    // Restore context
    if (savedTask) {
      await new Promise(r => setTimeout(r, 5000));
      const resumePrompt = `
You were restarted due to rate limits. Auth rotated to ${nextAuth?.name ?? 'OAuth'}.

Your previous task was:
${savedTask}

Please resume. Check git status and recent changes.
      `.trim();

      await this.instanceManager.sendPrompt(instanceId, resumePrompt);
    }
  }

  /**
   * Get next auth config for rotation. Returns null to use OAuth.
   */
  private getNextAuthConfig(): AuthConfig | null {
    if (this.authConfigs.length === 0) return null;

    // Cycle through configs, returning null occasionally to try OAuth
    this.authConfigIndex = (this.authConfigIndex + 1) % (this.authConfigs.length + 1);

    if (this.authConfigIndex === 0) return null; // Use OAuth
    return this.authConfigs[this.authConfigIndex - 1];
  }

  private async handleStuckInstance(instanceId: string): Promise<void> {
    logger.warn(`Instance ${instanceId} stuck, nudging...`);

    const instance = this.instanceManager.getInstance(instanceId);
    if (!instance) return;

    const nudgePrompt = `
## Nudge: Are you stuck?

It appears you haven't used any tools recently. If you're:
- **Thinking**: Continue your analysis and take action
- **Waiting**: The system is automated, proceed with your task
- **Blocked**: Commit what you have, push, and stop

Please continue working.
    `.trim();

    await this.instanceManager.sendPrompt(instanceId, nudgePrompt);
  }

  private async initializeManager(): Promise<void> {
    // Wait for Claude to initialize
    await new Promise(r => setTimeout(r, 3000));

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
   ${this.config.workerCount > 2 ? `- ... up to WORKER_${this.config.workerCount}_TASK_LIST.md` : ''}

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
    setTimeout(() => this.initializeWorkers(), 15000);
  }

  private async initializeWorkers(): Promise<void> {
    for (let i = 1; i <= this.config.workerCount; i++) {
      await this.initializeWorker(i);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  private async initializeWorker(workerId: number): Promise<void> {
    const worktreePath = `${this.workspaceDir}/worktrees/worker-${workerId}`;

    const prompt = `
You are **Worker ${workerId}** in a Claude Code Orchestrator.

## Your Environment
- Working directory: ${worktreePath}
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
      logger.info(`Worker ${workerId} completed task - queueing for merge`);
      this.mergeQueue.enqueue(workerId);

      const manager = this.instanceManager.getInstance('manager');
      if (manager && (manager.status === 'idle' || manager.status === 'ready')) {
        this.mergeQueue.processNext().catch(err => {
          logger.error('Failed to process merge queue', err);
        });
      }
    } else {
      logger.info('Manager completed task');
      this.mergeQueue.processNext().catch(err => {
        logger.error('Failed to process merge queue after manager completion', err);
      });
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

  /**
   * State reconciliation loop ("Game Loop").
   */
  private startReconcileLoop(intervalMs: number): void {
    if (this.reconcileInterval) {
      clearInterval(this.reconcileInterval);
    }

    this.reconcileInterval = setInterval(() => {
      this.reconcileState().catch(err => {
        logger.error('State reconciliation failed', err);
      });
    }, intervalMs);

    logger.info(`State reconciliation loop started (interval: ${intervalMs}ms)`);
  }

  private async reconcileState(): Promise<void> {
    if (this.isShuttingDown) return;

    const instances = this.instanceManager.getAllInstances();

    for (const instance of instances) {
      try {
        await this.reconcileInstance(instance);
      } catch (err) {
        logger.error(`Failed to reconcile instance ${instance.id}`, err);
      }
    }
  }

  private async reconcileInstance(instance: ClaudeInstance): Promise<void> {
    const sessionName = instance.sessionName;

    // Check if tmux session exists
    const sessionExists = await this.tmux.sessionExists(sessionName);
    if (!sessionExists) {
      logger.warn(`Session ${sessionName} died! Recreating...`);
      await this.recreateInstance(instance);
      return;
    }

    // Check if dropped to shell prompt (Claude crashed)
    const isShell = await this.tmux.isAtShellPrompt(sessionName);
    if (isShell) {
      logger.warn(`Instance ${instance.id} dropped to shell. Restarting Claude...`);
      await this.tmux.ensureClaudeRunning(sessionName, instance.workDir);

      if (instance.currentTaskFull && instance.status === 'busy') {
        await new Promise(r => setTimeout(r, 5000));
        await this.instanceManager.sendPrompt(instance.id, instance.currentTaskFull);
      }
      return;
    }

    // Check if at Claude prompt but marked as busy
    if (instance.status === 'busy') {
      const atPrompt = await this.tmux.isAtClaudePrompt(sessionName);
      if (atPrompt) {
        const idleTime = instance.lastToolUse
          ? Date.now() - instance.lastToolUse.getTime()
          : 0;

        if (idleTime > 60000) {
          logger.info(`Instance ${instance.id} appears done. Marking idle.`);
          this.instanceManager.updateStatus(instance.id, 'idle');
          this.instanceManager.clearTask(instance.id);

          if (instance.type === 'worker') {
            this.handleTaskComplete(instance.workerId, 'worker');
          }
        }
      }
    }

    // Check for confirmation prompts
    const confirmKey = await this.tmux.hasConfirmationPrompt(sessionName);
    if (confirmKey) {
      logger.info(`Instance ${instance.id} has confirmation prompt, sending '${confirmKey}'`);
      if (confirmKey === 'Enter') {
        await this.tmux.sendKeys(sessionName, '', true);
      } else {
        await this.tmux.sendKeys(sessionName, confirmKey, true);
      }
    }
  }

  private async recreateInstance(instance: ClaudeInstance): Promise<void> {
    const savedTask = instance.currentTaskFull;

    // Find the auth config by name (apiKey field stores the config name)
    const authConfig = instance.apiKey
      ? this.authConfigs.find(c => c.name === instance.apiKey)
      : undefined;

    this.instanceManager.removeInstance(instance.id);

    await this.createInstance(
      instance.id,
      instance.type,
      instance.workerId,
      instance.workDir,
      authConfig
    );

    await new Promise(r => setTimeout(r, 5000));

    if (savedTask) {
      logger.info(`Restoring task for ${instance.id}`);
      await this.instanceManager.sendPrompt(instance.id, savedTask);
    }
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info('Shutting down orchestrator...');

    // Stop loops
    if (this.reconcileInterval) {
      clearInterval(this.reconcileInterval);
      this.reconcileInterval = null;
    }

    this.rateLimitDetector.stop();
    this.stuckDetector.stop();

    // Log stats
    this.costTracker.logStats();

    // Stop hook server
    await this.hookServer.stop();

    // Kill tmux sessions
    await this.tmux.killAllOrchestratorSessions();

    logger.info('Orchestrator shutdown complete');
  }

  getStatus() {
    return {
      instances: this.instanceManager.getStats(),
      costs: this.costTracker.getStats(),
      mergeQueueSize: this.mergeQueue.size(),
      authConfigsAvailable: this.authConfigs.length,
    };
  }
}
