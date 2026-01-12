import { OrchestratorConfig } from '../config/schema.js';
import { HookServer } from '../server.js';
import { DockerManager } from '../docker/manager.js';
import { HealthMonitor } from '../docker/health.js';
import { TmuxManager } from '../tmux/session.js';
import { ClaudeInstanceManager, ClaudeInstance } from '../claude/instance.js';
import { RateLimitDetector } from '../claude/rate-limit-detector.js';
import { registerHookHandlers } from '../claude/hook-handlers.js';
import { GitManager } from '../git/worktree.js';
import { BranchMerger } from '../git/merge.js';
import { ComposeGenerator } from '../docker/compose.js';
import { TaskScheduler } from './scheduler.js';
import { WorkerController } from './worker.js';
import { CostTracker } from './cost-tracker.js';
import { StuckDetector } from './stuck-detector.js';
import { logger } from '../utils/logger.js';

export class Orchestrator {
  private hookServer: HookServer;
  private docker: DockerManager;
  private healthMonitor: HealthMonitor;
  private tmux: TmuxManager;
  private instanceManager: ClaudeInstanceManager;
  private rateLimitDetector: RateLimitDetector;
  private git: GitManager;
  private _merger: BranchMerger;
  private scheduler: TaskScheduler;
  private workerController: WorkerController;
  private costTracker: CostTracker;
  private stuckDetector: StuckDetector;
  private managerInstance?: ClaudeInstance;
  private isShuttingDown: boolean = false;

  constructor(private config: OrchestratorConfig) {
    // Initialize components
    this.hookServer = new HookServer(config.hookServerPort);
    this.docker = new DockerManager();
    this.tmux = new TmuxManager();
    this.instanceManager = new ClaudeInstanceManager(this.docker, this.tmux);
    this.git = new GitManager('/workspace');
    this._merger = new BranchMerger('/workspace');
    this.scheduler = new TaskScheduler();
    this.workerController = new WorkerController(this.instanceManager, this.git);

    // Initialize monitors
    this.healthMonitor = new HealthMonitor(
      this.docker,
      (name) => this.handleUnhealthyContainer(name)
    );

    this.rateLimitDetector = new RateLimitDetector(
      this.tmux,
      this.instanceManager,
      (id) => this.handleRateLimit(id)
    );

    this.costTracker = new CostTracker(this.instanceManager, {
      maxToolUsesPerInstance: config.maxToolUsesPerInstance,
      maxTotalToolUses: config.maxTotalToolUses,
      maxRunDurationMinutes: config.maxRunDurationMinutes,
    });

    this.stuckDetector = new StuckDetector(
      this.instanceManager,
      (id) => this.handleStuckInstance(id),
      config.stuckThresholdMs
    );
  }

  /**
   * Start the orchestrator.
   */
  async start(): Promise<void> {
    logger.info('Starting orchestrator...');

    try {
      // 1. Start hook server
      await this.hookServer.start();

      // 2. Register hook handlers
      this.registerHandlers();

      // 3. Build Docker image
      await this.docker.buildImage('./docker/Dockerfile', 'claude-code-orchestrator');

      // 4. Generate and write docker-compose file
      const composeGenerator = new ComposeGenerator();
      const compose = composeGenerator.generateCompose({
        workerCount: this.config.workerCount,
        orchestratorUrl: `http://host.docker.internal:${this.config.hookServerPort}`,
        repoUrl: this.config.repositoryUrl,
        branch: this.config.branch,
        configDir: './config',
      });
      await composeGenerator.writeComposeFile('./docker-compose.yml', compose);

      // 5. Start containers
      await this.docker.startContainers('./docker-compose.yml');

      // 6. Register containers for health monitoring
      await this.docker.refreshContainerList();
      for (const name of this.docker.getContainerNames()) {
        this.healthMonitor.registerContainer(name);
      }

      // 7. Clone repository and set up worktrees
      await this.setupRepository();

      // 8. Create Claude instances
      await this.createInstances();

      // 9. Start monitors
      this.healthMonitor.start(this.config.healthCheckIntervalMs);
      this.rateLimitDetector.start(this.config.rateLimitCheckIntervalMs);
      this.stuckDetector.start(60000);

      // 10. Initialize manager instance
      await this.initializeManager();

      logger.info('Orchestrator started successfully', {
        workerCount: this.config.workerCount,
        hookPort: this.config.hookServerPort,
      });
    } catch (err) {
      logger.error('Failed to start orchestrator', err);
      await this.shutdown();
      throw err;
    }
  }

  /**
   * Set up the repository and worktrees.
   */
  private async setupRepository(): Promise<void> {
    logger.info('Setting up repository...');

    // Clone repository
    await this.git.clone(this.config.repositoryUrl, this.config.branch, '/workspace');

    // Create worktrees for each worker
    for (let i = 1; i <= this.config.workerCount; i++) {
      const branchName = `worker-${i}`;
      const worktreePath = `/workspace/worktrees/worker-${i}`;
      await this.git.createWorktree(branchName, worktreePath);
    }

    logger.info('Repository setup complete');
  }

  /**
   * Create Claude instances for manager and workers.
   */
  private async createInstances(): Promise<void> {
    // Create manager instance
    this.managerInstance = await this.instanceManager.createInstance({
      id: 'manager',
      type: 'manager',
      workerId: 0,
      configPath: '',
    });

    // Create worker instances
    for (let i = 1; i <= this.config.workerCount; i++) {
      await this.instanceManager.createInstance({
        id: `worker-${i}`,
        type: 'worker',
        workerId: i,
        configPath: '',
      });
    }

    logger.info(`Created ${this.config.workerCount + 1} Claude instances`);
  }

  /**
   * Register hook handlers.
   */
  private registerHandlers(): void {
    registerHookHandlers(this.hookServer, this.instanceManager, {
      onTaskComplete: (workerId, instanceType) =>
        this.handleTaskComplete(workerId, instanceType),
      onError: (instanceId, error) => this.handleInstanceError(instanceId, error),
      onRateLimit: (instanceId) => this.handleRateLimit(instanceId),
    });
  }

  /**
   * Initialize the manager instance with its initial prompt.
   */
  private async initializeManager(): Promise<void> {
    if (!this.managerInstance) return;

    const prompt = `
You are the **Manager** instance of a Claude Code Orchestrator system.

## Your Environment
- Working directory: /repo (main branch)
- Worker instances available: ${this.config.workerCount}
- Workers have their own worktrees at /repo/worktrees/worker-{N}

## CRITICAL: You are EVENT-DRIVEN
- You will receive prompts from the Orchestrator when workers finish tasks
- Do NOT poll, loop, or "monitor continuously" - just wait for the next prompt
- Each prompt will tell you exactly what happened and what action to take

## Your Initial Task

### Step 1: Read the Project Direction
\`\`\`bash
cat PROJECT_DIRECTION.md
\`\`\`

### Step 2: Create Task Lists for Each Worker
Create these files with specific, actionable tasks:
- \`WORKER_1_TASK_LIST.md\`
- \`WORKER_2_TASK_LIST.md\`
${this.config.workerCount > 2 ? `- ... up to \`WORKER_${this.config.workerCount}_TASK_LIST.md\`` : ''}

Use this format for each file:
\`\`\`markdown
# Worker N Task List

## Current Task
- [ ] Specific task description with clear acceptance criteria

## Queue
- [ ] Next task
- [ ] Another task

## Completed
(empty initially)
\`\`\`

### Step 3: Commit and Push
\`\`\`bash
git add WORKER_*.md
git commit -m "Add initial worker task lists"
git push origin main
\`\`\`

### Step 4: STOP
After pushing, **STOP immediately**.
- Workers will automatically pick up their tasks
- You'll be notified when each worker completes a task
- Do NOT try to monitor or poll for updates

## Important Notes
- Make tasks independent so workers don't block each other
- Order tasks by dependency and priority
- Include enough detail so workers can work autonomously
- Each worker should have 3-5 tasks initially

**START NOW**: Read PROJECT_DIRECTION.md and create the task lists.
    `.trim();

    await this.instanceManager.sendPrompt('manager', prompt);
    logger.info('Manager instance initialized');

    // Initialize workers after manager sets up task lists
    // Workers will start on their own via container entrypoint
    for (let i = 1; i <= this.config.workerCount; i++) {
      await this.workerController.initializeWorker(i, this.config.workerCount);
    }
  }

  /**
   * Handle task completion from a worker or manager.
   */
  private async handleTaskComplete(
    workerId: number,
    instanceType: 'manager' | 'worker'
  ): Promise<void> {
    if (this.isShuttingDown) return;

    if (instanceType === 'worker') {
      logger.info(`Worker ${workerId} completed task`);
      await this.notifyManagerOfWorkerCompletion(workerId);
    } else {
      logger.info('Manager completed task');
      // Manager tasks (like merging) complete here
      // Check if there are pending worker merges
    }
  }

  /**
   * Notify manager that a worker has completed their task.
   */
  private async notifyManagerOfWorkerCompletion(workerId: number): Promise<void> {
    if (!this.managerInstance) return;

    // Lock worker during merge
    this.instanceManager.lockWorker(workerId);

    const prompt = `
## Event: Worker ${workerId} Task Complete

Worker ${workerId} has finished their current task and pushed to branch \`worker-${workerId}\`.

### Your Actions (in order):

1. **Fetch and review changes**:
   \`\`\`bash
   git fetch origin worker-${workerId}
   git diff main...origin/worker-${workerId} --stat
   \`\`\`

2. **Merge the branch**:
   \`\`\`bash
   git checkout main
   git merge origin/worker-${workerId} --no-ff -m "Merge worker-${workerId} task completion"
   git push origin main
   \`\`\`

3. **Handle conflicts** (if any):
   - Review conflicting files
   - Resolve conflicts appropriately
   - Complete the merge with \`git add\` and \`git commit\`

4. **Update the task list**:
   Edit \`WORKER_${workerId}_TASK_LIST.md\`:
   - Move the completed task from "Current Task" to "Completed"
   - Move the next task from "Queue" to "Current Task"
   - If queue is empty, note that worker is done

   \`\`\`bash
   git add WORKER_${workerId}_TASK_LIST.md
   git commit -m "Update worker ${workerId} task list"
   git push origin main
   \`\`\`

5. **STOP**:
   After pushing, stop immediately. The Orchestrator will:
   - Unlock Worker ${workerId}
   - Notify Worker ${workerId} to pull and continue
    `.trim();

    await this.instanceManager.sendPrompt('manager', prompt);
  }

  /**
   * Handle manager completing a merge.
   */
  async onManagerMergeComplete(workerId: number): Promise<void> {
    // Unlock the worker
    this.instanceManager.unlockWorker(workerId);

    // Notify worker to continue
    await this.workerController.notifyWorkerToContinue(workerId);
  }

  /**
   * Handle rate limit for an instance.
   */
  private async handleRateLimit(instanceId: string): Promise<void> {
    logger.warn(`Handling rate limit for ${instanceId}`);

    const instance = this.instanceManager.getInstance(instanceId);
    if (!instance) return;

    // Save context
    const savedTask = instance.currentTaskFull;

    // Mark as rate limited - Docker mode relies on ANTHROPIC_API_KEY env var
    // so we can only log the error and hope it resolves
    logger.error(`Rate limited on ${instanceId} - waiting for cooldown`);
    this.instanceManager.updateStatus(instanceId, 'error');

    // Wait for cooldown (in Docker mode, we can't easily rotate configs)
    await new Promise((resolve) => setTimeout(resolve, 60000));

    // Try to resume
    this.instanceManager.updateStatus(instanceId, 'ready');

    // Restore context
    if (savedTask) {
      const resumePrompt = `
You were paused due to API rate limits. Please resume your task.

Your previous task was:
${savedTask}

Please check your recent file changes and git status to understand your progress, then continue.
      `.trim();

      await this.instanceManager.sendPrompt(instanceId, resumePrompt);
    }
  }

  /**
   * Handle a stuck instance.
   */
  private async handleStuckInstance(instanceId: string): Promise<void> {
    logger.warn(`Handling stuck instance: ${instanceId}`);

    const instance = this.instanceManager.getInstance(instanceId);
    if (!instance) return;

    // Try to unstick by sending a nudge
    const nudgePrompt = `
## Nudge: Are you stuck?

It appears you haven't used any tools in a while. If you're:
- **Thinking**: Continue your analysis and take action
- **Waiting for input**: The system is automated, proceed with your task
- **Blocked**: Commit what you have and push, then stop

Please continue working or indicate if you need help.
    `.trim();

    await this.instanceManager.sendPrompt(instanceId, nudgePrompt);
  }

  /**
   * Handle an unhealthy container.
   */
  private async handleUnhealthyContainer(containerName: string): Promise<void> {
    logger.warn(`Handling unhealthy container: ${containerName}`);

    // Find the instance
    const instance = this.instanceManager
      .getAllInstances()
      .find((i) => i.containerName === containerName);

    if (!instance) return;

    // Mark as error
    this.instanceManager.updateStatus(instance.id, 'error');

    try {
      // Restart container
      await this.docker.restartContainer(containerName);

      // Wait for container to be ready
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Re-create tmux session
      await this.tmux.createSessionWithContainer(instance.sessionName, containerName);

      // Reinitialize the instance
      if (instance.type === 'manager') {
        await this.initializeManager();
      } else {
        await this.workerController.initializeWorker(instance.workerId, this.config.workerCount);
      }

      this.instanceManager.updateStatus(instance.id, 'ready');
      logger.info(`Recovered container: ${containerName}`);
    } catch (err) {
      logger.error(`Failed to recover container: ${containerName}`, err);
    }
  }

  /**
   * Handle instance error.
   */
  private handleInstanceError(instanceId: string, error: unknown): void {
    logger.error(`Instance ${instanceId} error`, error);
    this.instanceManager.updateStatus(instanceId, 'error');
  }

  /**
   * Shutdown the orchestrator gracefully.
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info('Shutting down orchestrator...');

    // Stop monitors
    this.healthMonitor.stop();
    this.rateLimitDetector.stop();
    this.stuckDetector.stop();

    // Log final stats
    this.costTracker.logStats();

    // Stop hook server
    await this.hookServer.stop();

    // Destroy Claude instances
    await this.instanceManager.destroyAll();

    // Kill tmux sessions
    await this.tmux.killAllOrchestratorSessions();

    // Stop Docker containers
    await this.docker.cleanup('./docker-compose.yml');

    logger.info('Orchestrator shutdown complete');
  }

  /**
   * Get orchestrator status.
   */
  getStatus(): {
    instances: ReturnType<ClaudeInstanceManager['getStats']>;
    tasks: ReturnType<TaskScheduler['getStats']>;
    health: ReturnType<HealthMonitor['getHealthySummary']>;
    costs: ReturnType<CostTracker['getStats']>;
  } {
    return {
      instances: this.instanceManager.getStats(),
      tasks: this.scheduler.getStats(),
      health: this.healthMonitor.getHealthySummary(),
      costs: this.costTracker.getStats(),
    };
  }
}
