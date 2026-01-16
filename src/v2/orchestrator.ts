/**
 * V2 Orchestrator - Non-interactive Claude Code orchestration
 *
 * This is the simplified orchestrator using --print mode.
 * No tmux, no hooks, no terminal scraping - just process execution.
 */

import { mkdir, readdir, rm } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { execa } from 'execa';
import { logger } from '../utils/logger.js';
import { GitManager } from '../git/worktree.js';
import { extractRepoName } from '../utils/repo.js';
import { WorkerExecutor, buildWorkerPrompt, buildMergePrompt, buildConflictResolutionPrompt } from './worker.js';
import { TaskQueue, type CreateTaskOptions } from './task-queue.js';
import { TeamManager } from './team-manager.js';
import {
  writeTaskFile,
  getTaskFileName,
  generateWorkerTaskContent,
  generateManagerTaskContent,
  generateEmTaskContent,
} from './task-file.js';
import type {
  V2OrchestratorConfig,
  AuthConfig,
  OrchestratorStatus,
  Task,
  Worker,
  TaskResult,
} from './types.js';

/** Default configuration values */
const DEFAULTS = {
  taskTimeoutMs: 600000, // 10 minutes
  pollIntervalMs: 5000,  // 5 seconds
  mergeCheckIntervalMs: 30000, // 30 seconds
  gitMaintenanceIntervalMs: 600000, // 10 minutes - clean up temp pack files
};

/** Orchestrator state */
type OrchestratorState = 'idle' | 'running' | 'paused' | 'stopping' | 'stopped';

/**
 * V2 Orchestrator - Main orchestration engine
 */
export class V2Orchestrator {
  private config: V2OrchestratorConfig;
  private authConfigs: AuthConfig[];
  private state: OrchestratorState = 'idle';
  private startedAt?: Date;

  private git!: GitManager;
  private taskQueue: TaskQueue;
  private teamManager: TeamManager;
  private workerExecutors: Map<number, WorkerExecutor> = new Map();

  private activeTasks: Map<number, Promise<TaskResult>> = new Map();
  private authRotationIndex: number = 0;
  private pauseSignalPath?: string;
  private lastGitMaintenance: number = 0;

  constructor(
    config: V2OrchestratorConfig,
    authConfigs: AuthConfig[] = [],
    pauseSignalPath?: string
  ) {
    this.config = {
      ...config,
      taskTimeoutMs: config.taskTimeoutMs ?? DEFAULTS.taskTimeoutMs,
      pollIntervalMs: config.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
    };
    this.authConfigs = authConfigs;
    this.pauseSignalPath = pauseSignalPath;

    this.taskQueue = new TaskQueue();
    this.teamManager = new TeamManager({
      workerCount: config.workerCount,
      engineerManagerGroupSize: config.engineerManagerGroupSize,
      baseBranch: config.branch,
    });

    logger.info('V2 Orchestrator created', {
      repositoryUrl: config.repositoryUrl,
      branch: config.branch,
      workerCount: config.workerCount,
      mode: this.teamManager.getMode(),
    });
  }

  /**
   * Start the orchestrator
   */
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start orchestrator in state: ${this.state}`);
    }

    this.state = 'running';
    this.startedAt = new Date();

    logger.info('V2 Orchestrator starting');

    try {
      // 1. Setup workspace
      await this.setupWorkspace();

      // 2. Clone/setup repository
      await this.setupRepository();

      // 3. Initialize team structure
      this.teamManager.initialize();

      // 4. Create worktrees for workers
      await this.setupWorktrees();

      // 5. Create worker executors
      this.createWorkerExecutors();

      // 6. Start processing loop
      await this.processLoop();
    } catch (error) {
      logger.error('Orchestrator failed to start', { error });
      this.state = 'stopped';
      throw error;
    }
  }

  /**
   * Setup workspace directory
   */
  private async setupWorkspace(): Promise<void> {
    const workspaceDir = this.config.workspaceDir;

    if (!existsSync(workspaceDir)) {
      await mkdir(workspaceDir, { recursive: true });
      logger.info('Created workspace directory', { workspaceDir });
    }

    // Create worktrees subdirectory
    const worktreesDir = join(workspaceDir, 'worktrees');
    if (!existsSync(worktreesDir)) {
      await mkdir(worktreesDir, { recursive: true });
    }
  }

  /**
   * Setup git repository
   */
  private async setupRepository(): Promise<void> {
    const repoName = extractRepoName(this.config.repositoryUrl);
    const repoPath = join(this.config.workspaceDir, repoName);

    this.git = new GitManager(repoPath);

    if (!existsSync(repoPath)) {
      await this.git.clone(
        this.config.repositoryUrl,
        this.config.branch,
        repoPath,
        this.config.cloneDepth
      );
    } else {
      logger.info('Repository already exists, pulling latest', { repoPath });
      await this.git.pull('origin', this.config.branch);
    }
  }

  /**
   * Setup worktrees for all workers
   */
  private async setupWorktrees(): Promise<void> {
    const workers = this.teamManager.getAllWorkers();
    const worktreesDir = join(this.config.workspaceDir, 'worktrees');

    for (const worker of workers) {
      const worktreePath = join(worktreesDir, `worker-${worker.id}`);

      try {
        await this.git.createWorktree(worker.branchName, worktreePath);
      } catch (error) {
        // Worktree might already exist
        logger.debug('Worktree creation note', { workerId: worker.id, error });
      }

      this.teamManager.setWorkerWorktreePath(worker.id, worktreePath);
    }

    // Create team worktrees for hierarchy mode
    if (this.teamManager.getMode() === 'hierarchy') {
      for (const team of this.teamManager.getAllTeams()) {
        const teamWorktreePath = join(worktreesDir, `team-${team.id}`);

        try {
          await this.git.createWorktree(team.branchName, teamWorktreePath);
        } catch (error) {
          logger.debug('Team worktree creation note', { teamId: team.id, error });
        }

        this.teamManager.setTeamWorktreePath(team.id, teamWorktreePath);
      }
    }

    logger.info('Worktrees setup complete', {
      workerCount: workers.length,
      teamCount: this.teamManager.getAllTeams().length,
    });
  }

  /**
   * Create worker executors
   */
  private createWorkerExecutors(): void {
    const workers = this.teamManager.getAllWorkers();

    for (const worker of workers) {
      const authConfig = this.getAuthConfigForWorker(worker.id);

      const executor = new WorkerExecutor({
        id: worker.id,
        worktreePath: worker.worktreePath,
        model: this.config.model,
        timeoutMs: this.config.taskTimeoutMs,
        authConfig,
      });

      this.workerExecutors.set(worker.id, executor);
    }

    logger.info('Worker executors created', { count: this.workerExecutors.size });
  }

  /**
   * Get auth config for a worker (with rotation support)
   */
  private getAuthConfigForWorker(workerId: number): AuthConfig | undefined {
    if (this.authConfigs.length === 0) return undefined;
    if (this.config.authMode === 'oauth') return undefined;

    const index = (workerId - 1) % this.authConfigs.length;
    return this.authConfigs[index];
  }

  /**
   * Rotate auth config for a worker (after rate limit)
   */
  private rotateAuthForWorker(workerId: number): void {
    if (this.authConfigs.length === 0) return;

    this.authRotationIndex = (this.authRotationIndex + 1) % this.authConfigs.length;
    const newAuth = this.authConfigs[this.authRotationIndex];

    const executor = this.workerExecutors.get(workerId);
    if (executor) {
      executor.setAuthConfig(newAuth);
      logger.info('Rotated auth for worker', { workerId, authName: newAuth.name });
    }
  }

  /**
   * Main processing loop
   */
  private async processLoop(): Promise<void> {
    logger.info('Processing loop started');

    while (this.state === 'running' || this.state === 'paused') {
      // Check for pause signal
      if (await this.shouldPause()) {
        if (this.state !== 'paused') {
          this.state = 'paused';
          logger.info('Orchestrator paused');
        }
        await this.sleep(1000);
        continue;
      }

      if (this.state === 'paused') {
        this.state = 'running';
        logger.info('Orchestrator resumed');
      }

      // Check if we're done
      if (this.taskQueue.isEmpty() && this.activeTasks.size === 0) {
        if (this.taskQueue.isComplete()) {
          logger.info('All tasks complete');
          break;
        }
      }

      // Assign tasks to idle workers
      await this.assignTasks();

      // Process any completed tasks
      await this.processCompletedTasks();

      // Check for worker changes to merge
      await this.checkForMerges();

      // Periodic git maintenance to clean up temp pack files
      await this.performGitMaintenanceIfNeeded();

      // Small delay to prevent tight loop
      await this.sleep(this.config.pollIntervalMs);
    }

    this.state = 'stopped';
    logger.info('Processing loop ended');
  }

  /**
   * Assign pending tasks to idle workers
   */
  private async assignTasks(): Promise<void> {
    const idleWorkers = this.teamManager.getIdleWorkers();

    for (const worker of idleWorkers) {
      const task = this.taskQueue.assignTask(worker.id);
      if (!task) break; // No more pending tasks

      // Update worker state
      this.teamManager.updateWorkerStatus(worker.id, 'running');
      worker.currentTask = task;

      // Start task execution
      const taskPromise = this.executeWorkerTask(worker, task);
      this.activeTasks.set(worker.id, taskPromise);
    }
  }

  /**
   * Execute a task on a worker
   */
  private async executeWorkerTask(worker: Worker, task: Task): Promise<TaskResult> {
    const executor = this.workerExecutors.get(worker.id);
    if (!executor) {
      throw new Error(`No executor for worker ${worker.id}`);
    }

    // Write task file
    const taskContent = generateWorkerTaskContent(task, worker.id, {
      branchName: worker.branchName,
      baseBranch: this.config.branch,
      mode: this.teamManager.getMode(),
      teamInfo: this.teamManager.getTeamForWorker(worker.id)?.branchName,
    });

    const taskFileName = getTaskFileName(worker.id);
    await writeTaskFile(worker.worktreePath, taskFileName, taskContent);

    // Build and execute prompt
    const prompt = buildWorkerPrompt(worker.id, taskFileName);
    const result = await executor.runTask(prompt);

    return result;
  }

  /**
   * Process completed tasks
   */
  private async processCompletedTasks(): Promise<void> {
    for (const [workerId, taskPromise] of this.activeTasks) {
      // Check if task is done (non-blocking)
      const result = await Promise.race([
        taskPromise.then((r) => ({ done: true, result: r })),
        Promise.resolve({ done: false, result: null }),
      ]);

      if (!result.done || !result.result) continue;

      // Remove from active
      this.activeTasks.delete(workerId);

      const worker = this.teamManager.getWorker(workerId);
      if (!worker || !worker.currentTask) continue;

      const task = worker.currentTask;
      const taskResult = result.result;

      if (taskResult.success) {
        // Task completed successfully
        this.taskQueue.completeTask(task.id, taskResult);
        this.teamManager.incrementTaskCount(workerId);
        this.teamManager.updateWorkerStatus(workerId, 'idle');

        // Commit and push worker changes
        await this.commitAndPushWorkerChanges(worker);
      } else if (taskResult.rateLimited) {
        // Rate limited - rotate auth and requeue
        this.rotateAuthForWorker(workerId);
        this.taskQueue.requeueTask(task.id);
        this.teamManager.updateWorkerStatus(workerId, 'idle');
      } else {
        // Task failed
        const willRetry = this.taskQueue.failTask(task.id, taskResult);
        this.teamManager.updateWorkerStatus(workerId, willRetry ? 'idle' : 'error');
      }

      // Clear current task
      worker.currentTask = undefined;
    }
  }

  /**
   * Commit and push changes from a worker
   */
  private async commitAndPushWorkerChanges(worker: Worker): Promise<void> {
    try {
      const worktreePath = worker.worktreePath;

      // Check if there are changes to commit
      const status = await execa('git', ['status', '--porcelain'], { cwd: worktreePath });
      if (!status.stdout.trim()) {
        logger.debug('No changes to commit', { workerId: worker.id });
        return;
      }

      // Stage all changes
      await execa('git', ['add', '-A'], { cwd: worktreePath });

      // Commit
      const commitMessage = worker.currentTask
        ? `Complete: ${worker.currentTask.title}`
        : 'Worker changes';
      await execa('git', ['commit', '-m', commitMessage], { cwd: worktreePath });

      // Push
      await execa('git', ['push', 'origin', worker.branchName, '--set-upstream'], {
        cwd: worktreePath,
        reject: false, // Don't fail if already up-to-date
      });

      logger.info('Worker changes committed and pushed', {
        workerId: worker.id,
        branch: worker.branchName,
      });
    } catch (error) {
      logger.error('Failed to commit/push worker changes', { workerId: worker.id, error });
    }
  }

  /**
   * Check for worker branches to merge
   */
  private async checkForMerges(): Promise<void> {
    // This is a simplified merge check - poll git for new commits
    // In a production system, you might want more sophisticated coordination

    const mode = this.teamManager.getMode();

    if (mode === 'flat') {
      await this.checkFlatMerges();
    } else {
      await this.checkHierarchyMerges();
    }
  }

  /**
   * Check and perform merges in flat mode
   */
  private async checkFlatMerges(): Promise<void> {
    // In flat mode, the manager merges worker branches to main
    // For simplicity, we'll do this synchronously when workers complete
    // A more sophisticated implementation would use a separate merge process
  }

  /**
   * Check and perform merges in hierarchy mode
   */
  private async checkHierarchyMerges(): Promise<void> {
    // In hierarchy mode:
    // 1. EMs merge worker branches to team branches
    // 2. Director merges team branches to main
    // For simplicity, this is handled via task completion
  }

  /**
   * Check if should pause
   */
  private async shouldPause(): Promise<boolean> {
    if (!this.pauseSignalPath) return false;

    try {
      // Check for pause signal file
      return existsSync(this.pauseSignalPath);
    } catch {
      return false;
    }
  }

  /**
   * Add tasks to the queue
   */
  addTasks(tasks: CreateTaskOptions[]): Task[] {
    return this.taskQueue.addTasks(tasks);
  }

  /**
   * Add a single task
   */
  addTask(task: CreateTaskOptions): Task {
    return this.taskQueue.addTask(task);
  }

  /**
   * Get orchestrator status
   */
  getStatus(): OrchestratorStatus {
    const stats = this.taskQueue.getStats();
    const teamStats = this.teamManager.getStats();

    return {
      mode: this.teamManager.getMode(),
      isRunning: this.state === 'running',
      isPaused: this.state === 'paused',
      totalTasks: stats.total,
      completedTasks: stats.completed,
      failedTasks: stats.failed,
      pendingTasks: stats.pending,
      workers: this.teamManager.getAllWorkers().map((w) => ({
        id: w.id,
        status: w.status,
        currentTaskTitle: w.currentTask?.title,
        tasksCompleted: w.totalTasksCompleted,
      })),
      teams: this.teamManager.getMode() === 'hierarchy'
        ? this.teamManager.getAllTeams().map((t) => ({
            id: t.id,
            workerIds: t.workerIds,
            completedTasks: this.teamManager
              .getWorkersForTeam(t.id)
              .reduce((sum, w) => sum + w.totalTasksCompleted, 0),
            pendingMerges: 0, // Simplified
          }))
        : undefined,
      startedAt: this.startedAt ?? new Date(),
      runDurationMinutes: this.startedAt
        ? (Date.now() - this.startedAt.getTime()) / 60000
        : 0,
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    logger.info('Orchestrator shutting down');
    this.state = 'stopping';

    // Wait for active tasks to complete (with timeout)
    const timeout = 30000; // 30 seconds
    const start = Date.now();

    while (this.activeTasks.size > 0 && Date.now() - start < timeout) {
      await this.sleep(1000);
    }

    if (this.activeTasks.size > 0) {
      logger.warn('Shutdown timeout - some tasks still running', {
        activeCount: this.activeTasks.size,
      });
    }

    this.state = 'stopped';
    logger.info('Orchestrator shutdown complete');
  }

  /**
   * Perform periodic git maintenance to clean up temporary pack files.
   * These files can accumulate during concurrent git operations and consume
   * significant disk space (10GB+ on large repos with many workers).
   */
  private async performGitMaintenanceIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastGitMaintenance < DEFAULTS.gitMaintenanceIntervalMs) {
      return; // Not time yet
    }

    this.lastGitMaintenance = now;

    try {
      const packDir = join(this.config.workspaceDir, extractRepoName(this.config.repositoryUrl), '.git', 'objects', 'pack');

      if (!existsSync(packDir)) return;

      const files = await readdir(packDir);
      let cleaned = 0;

      for (const file of files) {
        if (file.startsWith('tmp_pack_')) {
          try {
            await rm(join(packDir, file), { force: true });
            cleaned++;
          } catch {
            // Ignore individual file errors
          }
        }
      }

      if (cleaned > 0) {
        logger.info('Git maintenance: cleaned temporary pack files', { cleaned });
      }
    } catch (err) {
      // Don't fail orchestration due to maintenance errors
      logger.debug('Git maintenance skipped', { error: String(err) });
    }
  }

  /**
   * Helper: sleep for ms
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
