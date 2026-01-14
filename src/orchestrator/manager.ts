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
import { ClaudeInstanceManager, ClaudeInstance, InstanceStatus, InstanceType } from '../claude/instance.js';
import { RateLimitDetector } from '../claude/rate-limit-detector.js';
import { registerHookHandlers } from '../claude/hook-handlers.js';
import { GitManager } from '../git/worktree.js';
import { CostTracker, CostLimits } from './cost-tracker.js';
import { StuckDetector } from './stuck-detector.js';
import { generateClaudeSettings } from '../claude/hooks.js';
import { execa } from 'execa';
import { mkdir, rm, copyFile, writeFile, readFile, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger, configureLogDirectory } from '../utils/logger.js';

const ENV_FILES = ['.env', '.env.local'];

/**
 * Queue for manager merge operations.
 * Prevents multiple workers from overwhelming the manager simultaneously.
 */
class MergeQueue {
  private queue: number[] = [];
  private isProcessing = false;
  private lastProcessTime = 0;
  private static readonly MIN_PROCESS_INTERVAL_MS = 30000; // 30 seconds between merge notifications

  constructor(private processFunc: (workerId: number) => Promise<void>) {}

  enqueue(workerId: number): void {
    if (!this.queue.includes(workerId)) {
      this.queue.push(workerId);
      logger.info(`Merge queue: added worker-${workerId} (queue size: ${this.queue.length})`);
    }
  }

  async processNext(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) return;

    // Rate limit: don't process too frequently
    const timeSinceLastProcess = Date.now() - this.lastProcessTime;
    if (timeSinceLastProcess < MergeQueue.MIN_PROCESS_INTERVAL_MS) {
      logger.debug(`Merge queue: rate limited, ${Math.round((MergeQueue.MIN_PROCESS_INTERVAL_MS - timeSinceLastProcess) / 1000)}s until next process`);
      return;
    }

    this.isProcessing = true;
    const workerId = this.queue.shift()!;

    try {
      logger.info(`Merge queue: processing worker-${workerId} (${this.queue.length} remaining)`);
      await this.processFunc(workerId);
      this.lastProcessTime = Date.now();
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

  isCurrentlyProcessing(): boolean {
    return this.isProcessing;
  }
}

interface EngineeringTeam {
  id: number;
  workerIds: number[];
  branchName: string;
  worktreePath: string;
  emInstanceId: string;
  status: 'active' | 'decommissioned';
  mergeQueue: MergeQueue;
  lastAssessment: number;
  priorityScore: number;
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
  private useHierarchy: boolean;
  private directorMergeQueue: MergeQueue | null = null;
  private managerMergeQueue: MergeQueue | null = null;
  private reconcileInterval: NodeJS.Timeout | null = null;
  private managerHeartbeatInterval: NodeJS.Timeout | null = null;
  private directorHeartbeatInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private workspaceDir: string;
  private startTimestamp: Date | null = null;

  // Auth configs for rotation (OAuth is used by default when no config is set)
  private authConfigs: AuthConfig[] = [];
  private authRotationPool: Array<AuthConfig | null> = [];
  private authRotationIndex = 0;
  private startupAuthAssignmentIndex = 0;

  // Track when each worker was last prompted to prevent over-prompting
  private workerLastPromptTime: Map<number, number> = new Map();
  private static readonly WORKER_PROMPT_COOLDOWN_MS = 300000; // 5 minutes between re-prompts
  private static readonly WORKER_IDLE_THRESHOLD_MS = 300000; // 5 minutes idle before re-prompting
  private teams: EngineeringTeam[] = [];
  private workerToTeam: Map<number, number> = new Map();
  private nextTeamId = 1;
  private logBaseDir: string;
  private runLogDir: string | null;
  private logsInitialized = false;
  private uiBuildDir: string | null;

  constructor(
    private config: OrchestratorConfig,
    workspaceDir: string = '/tmp/orchestrator-workspace',
    authConfigs: AuthConfig[] = [],
    runLogDir?: string
  ) {
    this.workspaceDir = workspaceDir;
    this.authConfigs = authConfigs;
    this.runLogDir = runLogDir ?? null;
    this.validateAuthMode();
    this.authRotationPool = this.buildAuthRotationPool();
    this.authRotationIndex = 0;
    this.useHierarchy = this.config.workerCount > this.config.engineerManagerGroupSize;
    this.logBaseDir = this.config.logDirectory ?? workspaceDir;
    this.uiBuildDir = this.resolveUiBuildDir();

    // Initialize components
    this.hookServer = new HookServer(config.serverPort, {
      sessionProvider: () => this.getSessionSnapshot(),
      uiDir: this.uiBuildDir,
    });
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

    if (this.useHierarchy) {
      this.initializeTeams();
      this.directorMergeQueue = new MergeQueue((teamId) => this.notifyDirectorOfCompletion(teamId));
    } else {
      this.directorMergeQueue = null;
      this.managerMergeQueue = new MergeQueue((workerId) => this.notifyManagerOfCompletion(workerId));
    }
  }

  async start(): Promise<void> {
    await this.initializeRunLogging();
    logger.info('Starting host-native orchestrator...');
    this.startTimestamp = new Date();

    try {
      // 1. Check if we can resume from existing workspace
      const canResume = await this.canResumeFromExisting();

      // 2. Start hook server
      await this.hookServer.start();

      // 3. Register hook handlers
      this.registerHandlers();

      if (canResume) {
        // Resume mode: reuse existing workspace
        logger.info('Resuming from existing workspace...');
        await this.resumeFromExisting();
      } else {
        // Fresh start: clean and clone
        logger.info('Starting fresh (no existing workspace found)...');
        await this.cleanWorkspace();
        await this.setupRepository();
      }

      // 4. Create or reconnect Claude instances (tmux sessions)
      await this.createInstances(canResume);

      // 5. Start monitors
      this.rateLimitDetector.start(10000);
      this.stuckDetector.start(60000);
      this.startReconcileLoop(30000);
      if (this.useHierarchy) {
        this.startDirectorHeartbeat(this.config.managerHeartbeatIntervalMs);
      } else {
        this.startManagerHeartbeat(this.config.managerHeartbeatIntervalMs);
      }

      // 6. Initialize or resume instances
      if (canResume) {
        await this.resumeInstances();
      } else if (this.useHierarchy) {
        await this.initializeDirector();
      } else {
        await this.initializeManager();
      }

      logger.info('Orchestrator started successfully', {
        mode: canResume ? 'resumed' : 'fresh',
        workerCount: this.config.workerCount,
        serverPort: this.config.serverPort,
        workspace: this.workspaceDir,
        authMode: this.config.authMode,
        startupAuth: this.getStartupAuthLogLabel(),
        authConfigsAvailable: this.authConfigs.length,
        hierarchyEnabled: this.useHierarchy,
        runLogDir: this.runLogDir,
      });
    } catch (err) {
      logger.error('Failed to start orchestrator', err);
      await this.shutdown();
      throw err;
    }
  }

  private async initializeRunLogging(): Promise<void> {
    if (this.logsInitialized) {
      return;
    }

    if (!this.runLogDir) {
      await mkdir(this.logBaseDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      this.runLogDir = join(this.logBaseDir, `run-${timestamp}`);
    }

    await mkdir(this.runLogDir, { recursive: true });
    configureLogDirectory(this.runLogDir);
    this.logsInitialized = true;
    logger.info('Log directory initialized', { runLogDir: this.runLogDir });
  }

  /**
   * Check if we can resume from an existing workspace.
   * Returns true if workspace exists and is a valid git repo with the right branch.
   */
  private async canResumeFromExisting(): Promise<boolean> {
    try {
      // Check if workspace directory exists
      if (!existsSync(this.workspaceDir)) {
        logger.debug('Workspace does not exist');
        return false;
      }

      // Check if it's a git repo
      const gitDir = join(this.workspaceDir, '.git');
      if (!existsSync(gitDir)) {
        logger.debug('Workspace is not a git repo');
        return false;
      }

      // Check if we're on the right branch
      const result = await execa('git', ['-C', this.workspaceDir, 'branch', '--show-current'], { reject: false });
      if (result.exitCode !== 0) {
        logger.debug('Could not get current branch');
        return false;
      }

      const currentBranch = result.stdout.trim();
      if (currentBranch !== this.config.branch) {
        logger.debug(`Wrong branch: ${currentBranch} (expected ${this.config.branch})`);
        return false;
      }

      // Check if worktrees directory exists
      const worktreesDir = join(this.workspaceDir, 'worktrees');
      if (!existsSync(worktreesDir)) {
        logger.debug('Worktrees directory does not exist');
        return false;
      }

      // Check if at least worker-1 worktree exists
      const worker1Dir = join(worktreesDir, 'worker-1');
      if (!existsSync(worker1Dir)) {
        logger.debug('Worker-1 worktree does not exist');
        return false;
      }

      logger.info('Found existing workspace, will resume');
      return true;
    } catch (err) {
      logger.debug('Error checking existing workspace', err);
      return false;
    }
  }

  /**
   * Resume from existing workspace - pull latest and sync worktrees.
   */
  private async resumeFromExisting(): Promise<void> {
    logger.info('Pulling latest changes in main workspace...');

    this.git = new GitManager(this.workspaceDir);

    // Pull latest on main workspace
    await execa('git', ['-C', this.workspaceDir, 'fetch', 'origin'], { reject: false });
    await execa('git', ['-C', this.workspaceDir, 'reset', '--hard', `origin/${this.config.branch}`], { reject: false });

    // Copy env files to main workspace (in case they changed)
    await this.copyConfigEnvFiles(this.workspaceDir);

    // Sync each worker worktree
    const worktreesDir = join(this.workspaceDir, 'worktrees');
    for (let i = 1; i <= this.config.workerCount; i++) {
      const worktreePath = join(worktreesDir, `worker-${i}`);

      if (existsSync(worktreePath)) {
        // Worktree exists - just sync it (but preserve local commits on worker branch)
        logger.debug(`Syncing existing worktree for worker-${i}`);
        const branchName = `worker-${i}`;
        await execa('git', ['-C', worktreePath, 'fetch', 'origin'], { reject: false });
        // Check if the worker branch exists on origin, if so reset to it; otherwise just stay on current
        const { exitCode } = await execa('git', ['-C', worktreePath, 'rev-parse', '--verify', `origin/${branchName}`], { reject: false });
        if (exitCode === 0) {
          // Worker branch exists on origin - reset to it (preserves worker's pushed work)
          await execa('git', ['-C', worktreePath, 'reset', '--hard', `origin/${branchName}`], { reject: false });
        }
        // If worker branch doesn't exist on origin, leave worktree as-is to preserve local work
        await this.copyEnvFiles(this.workspaceDir, worktreePath);
      } else {
        // Worktree missing - create it
        logger.info(`Creating missing worktree for worker-${i}`);
        const branchName = `worker-${i}`;
        await execa('git', ['-C', this.workspaceDir, 'branch', branchName], { reject: false });
        await execa('git', ['-C', this.workspaceDir, 'worktree', 'add', worktreePath, branchName]);
        await this.copyEnvFiles(this.workspaceDir, worktreePath);
      }
    }

    await this.setupEngineeringManagerWorktrees();

    logger.info('Workspace sync complete');
  }

  /**
   * Resume existing Claude instances - reconnect to tmux sessions or restart Claude.
   */
  private async resumeInstances(): Promise<void> {
    logger.info('Resuming Claude instances...');

    // Wait for Claude to initialize in sessions
    await new Promise(r => setTimeout(r, 3000));

    if (this.useHierarchy) {
      const directorPrompt = `
## ORCHESTRATOR RESUMED

You are the Director. Review TEAM_STRUCTURE.md, EM_* task files, and resume coordinating EMs only. Reassess team sizes after each escalation.
      `.trim();

      await this.instanceManager.sendPrompt('director', directorPrompt);

      for (const team of this.teams) {
        if (team.status !== 'active') continue;
        const prompt = `
## TEAM RESUMED

You are EM-${team.id}. Re-sync ${team.branchName}, review EM_${team.id}_TASKS.md, and continue merging worker branches (${team.workerIds.map(id => `worker-${id}`).join(', ')}).
        `.trim();
        await this.instanceManager.sendPrompt(team.emInstanceId, prompt);
        await new Promise(r => setTimeout(r, 1500));
      }
    } else {
      const prompt = `
## ORCHESTRATOR RESUMED

You are the Manager. Re-sync ${this.config.branch}, inspect worker task lists, and continue merging worker branches directly. Reassign tasks as needed.
      `.trim();
      await this.instanceManager.sendPrompt('manager', prompt);
    }

    // Resume workers with staggered prompts
    for (let i = 1; i <= this.config.workerCount; i++) {
      await this.resumeWorker(i);
      await new Promise(r => setTimeout(r, 1000));
    }

    logger.info('All instances resumed');
  }

  /**
   * Resume a single worker instance.
   */
  private async resumeWorker(workerId: number): Promise<void> {
    const worktreePath = `${this.workspaceDir}/worktrees/worker-${workerId}`;
    const team = this.getTeamForWorker(workerId);
    const fallbackLabel = this.useHierarchy ? 'director' : 'manager';
    const teamLabel = team ? `EM-${team.id}` : fallbackLabel;

    const prompt = `
## ORCHESTRATOR RESUMED

The orchestrator has been restarted. Resume your work.

**Your role:** Worker ${workerId} reporting to ${teamLabel}

**Immediate actions:**
1. Sync with your branch: \`git fetch origin && git pull origin worker-${workerId} --rebase 2>/dev/null || true\`
2. Read your task list: \`cat WORKER_${workerId}_TASK_LIST.md\` (maintained by ${teamLabel})
3. Work on your Current Task
4. When done: commit, push to worker-${workerId}, and STOP

Continue working autonomously. NEVER ask questions.
    `.trim();

    await this.instanceManager.sendPrompt(`worker-${workerId}`, prompt);
    logger.debug(`Worker ${workerId} resume prompt sent`);
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

    // Copy env files to main workspace (for manager)
    await this.copyConfigEnvFiles(this.workspaceDir);

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

    await this.setupEngineeringManagerWorktrees();
  }

  private async copyEnvFiles(sourceDir: string, destDir: string): Promise<void> {
    // 1. Copy standard env files from workspace (if they exist)
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

    // 2. Copy env files from config-specified external paths
    if (this.config.envFiles && this.config.envFiles.length > 0) {
      for (const sourcePath of this.config.envFiles) {
        if (existsSync(sourcePath)) {
          // Get just the filename from the path
          const fileName = sourcePath.split('/').pop() || sourcePath;
          const destPath = join(destDir, fileName);

          try {
            await copyFile(sourcePath, destPath);
            logger.info(`Copied env file ${fileName} to worker worktree`, { source: sourcePath, dest: destPath });
          } catch (err) {
            logger.error(`Failed to copy env file ${sourcePath} to ${destDir}`, err);
          }
        } else {
          logger.warn(`Env file not found: ${sourcePath}`);
        }
      }
    }
  }

  /**
   * Copy only config-specified env files to a directory.
   * Used for the main workspace (manager) which doesn't have a source dir to copy from.
   */
  private async copyConfigEnvFiles(destDir: string): Promise<void> {
    if (!this.config.envFiles || this.config.envFiles.length === 0) {
      return;
    }

    for (const sourcePath of this.config.envFiles) {
      if (existsSync(sourcePath)) {
        const fileName = sourcePath.split('/').pop() || sourcePath;
        const destPath = join(destDir, fileName);

        try {
          await copyFile(sourcePath, destPath);
          logger.info(`Copied env file ${fileName} to workspace`, { source: sourcePath, dest: destPath });
        } catch (err) {
          logger.error(`Failed to copy env file ${sourcePath} to ${destDir}`, err);
        }
      } else {
        logger.warn(`Env file not found: ${sourcePath}`);
      }
    }
  }

  private initializeTeams(): void {
    const workerIds = Array.from({ length: this.config.workerCount }, (_, idx) => idx + 1);
    const maxTeamSize = this.config.engineerManagerGroupSize;
    const teamCount = Math.max(1, Math.ceil(workerIds.length / maxTeamSize));

    this.teams = [];
    this.workerToTeam.clear();

    for (let teamIndex = 0; teamIndex < teamCount; teamIndex++) {
      const teamId = this.nextTeamId++;
      const start = teamIndex * maxTeamSize;
      const end = Math.min(start + maxTeamSize, workerIds.length);
      const members = workerIds.slice(start, end);
      const team = this.buildTeamMetadata(teamId, members);
      this.teams.push(team);
      members.forEach(workerId => this.workerToTeam.set(workerId, teamId));
    }
  }

  private buildTeamMetadata(teamId: number, workerIds: number[]): EngineeringTeam {
    const branchName = `em-team-${teamId}`;
    const worktreePath = join(this.workspaceDir, 'worktrees', `em-${teamId}`);
    return {
      id: teamId,
      workerIds,
      branchName,
      worktreePath,
      emInstanceId: `em-${teamId}`,
      status: 'active',
      mergeQueue: new MergeQueue((workerId) => this.notifyEngineeringManagerOfCompletion(teamId, workerId)),
      lastAssessment: Date.now(),
      priorityScore: 0,
    };
  }

  private getTeam(teamId: number): EngineeringTeam | undefined {
    return this.teams.find(team => team.id === teamId && team.status === 'active');
  }

  private getTeamForWorker(workerId: number): EngineeringTeam | undefined {
    const teamId = this.workerToTeam.get(workerId);
    return typeof teamId === 'number' ? this.getTeam(teamId) : undefined;
  }

  private async setupEngineeringManagerWorktrees(): Promise<void> {
    if (!this.useHierarchy) {
      return;
    }

    for (const team of this.teams) {
      if (team.status !== 'active') {
        continue;
      }

      if (existsSync(team.worktreePath)) {
        await execa('git', ['-C', team.worktreePath, 'fetch', 'origin'], { reject: false });
        // Check if the EM team branch exists on origin, if so reset to it; otherwise stay on current
        const { exitCode } = await execa('git', ['-C', team.worktreePath, 'rev-parse', '--verify', `origin/${team.branchName}`], { reject: false });
        if (exitCode === 0) {
          // EM branch exists on origin - reset to it (preserves EM's pushed work)
          await execa('git', ['-C', team.worktreePath, 'reset', '--hard', `origin/${team.branchName}`], { reject: false });
        }
        // If EM branch doesn't exist on origin, leave worktree as-is to preserve local work
        await this.copyEnvFiles(this.workspaceDir, team.worktreePath);
      } else {
        await execa('git', ['-C', this.workspaceDir, 'branch', team.branchName], { reject: false });
        await execa('git', ['-C', this.workspaceDir, 'worktree', 'add', team.worktreePath, team.branchName]);
        await this.copyEnvFiles(this.workspaceDir, team.worktreePath);
      }
    }
  }

  private async ensureClaudeIgnored(workDir: string): Promise<void> {
    try {
      const { stdout } = await execa('git', ['-C', workDir, 'rev-parse', '--absolute-git-dir']);
      const gitDir = stdout.trim();
      if (!gitDir) {
        return;
      }

      const infoDir = join(gitDir, 'info');
      const excludePath = join(infoDir, 'exclude');
      await mkdir(infoDir, { recursive: true });

      let existing = '';
      try {
        existing = await readFile(excludePath, 'utf-8');
      } catch {
        existing = '';
      }

      if (existing.includes('.claude/')) {
        return;
      }

      const needsNewline = existing.length > 0 && !existing.endsWith('\n');
      const prefix = needsNewline ? '\n' : '';
      await appendFile(excludePath, `${prefix}.claude/\n`);
      logger.debug('Added .claude/ to git exclude', { workDir });
    } catch (err) {
      logger.warn('Failed to ensure .claude/ is ignored', { workDir, err });
    }
  }

  private async createInstances(resumeMode: boolean = false): Promise<void> {
    this.startupAuthAssignmentIndex = 0;

    if (this.useHierarchy) {
      const directorAuth = this.getStartupAuthForInstance();
      await this.createInstance('director', 'director', 0, this.workspaceDir, directorAuth ?? undefined, resumeMode);

      for (const team of this.teams) {
        const emAuth = this.getStartupAuthForInstance();
        await this.createInstance(team.emInstanceId, 'em', team.id, team.worktreePath, emAuth ?? undefined, resumeMode);
      }
    } else {
      const managerAuth = this.getStartupAuthForInstance();
      await this.createInstance('manager', 'manager', 0, this.workspaceDir, managerAuth ?? undefined, resumeMode);
    }

    // Workers
    for (let i = 1; i <= this.config.workerCount; i++) {
      const worktreePath = `${this.workspaceDir}/worktrees/worker-${i}`;
      const workerAuth = this.getStartupAuthForInstance();
      await this.createInstance(`worker-${i}`, 'worker', i, worktreePath, workerAuth ?? undefined, resumeMode);
    }

    logger.info(`${resumeMode ? 'Reconnected to' : 'Created'} ${this.config.workerCount + this.teams.length + 1} Claude instances`);
  }

  /**
   * Create a Claude instance with optional auth config override.
   * If no authConfig is provided, Claude uses host OAuth.
   * In resume mode, reconnects to existing tmux session if it exists.
   */
  private async createInstance(
    id: string,
    type: 'director' | 'em' | 'worker' | 'manager',
    workerId: number,
    workDir: string,
    authConfig?: AuthConfig,
    resumeMode: boolean = false
  ): Promise<ClaudeInstance> {
    const sessionName = `claude-${id}`;
    const sessionLogPath = this.getSessionLogPath(id);

    // Build environment variables
    const env: Record<string, string> = {
      FORCE_COLOR: '1',
    };

    // If auth config provided, inject its env vars (overrides OAuth)
    if (authConfig) {
      Object.assign(env, authConfig.env);
    }

    // Ensure .claude directory is ignored by git before writing files into it
    await this.ensureClaudeIgnored(workDir);

    // Write hooks configuration to Claude settings.json
    const orchestratorUrl = `http://localhost:${this.config.serverPort}`;
    const settings = generateClaudeSettings(orchestratorUrl, id, workerId, type, { env });
    const claudeDir = join(workDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, 'settings.local.json');
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));
    logger.debug('Wrote hooks to settings.local.json', { path: settingsPath });

    // In resume mode, check if tmux session already exists
    if (resumeMode) {
      const sessionExists = await this.tmux.sessionExists(sessionName);
      if (sessionExists) {
        if (sessionLogPath) {
          await this.tmux.attachSessionLogger(sessionName, sessionLogPath);
        }
        logger.info(`Reconnecting to existing session: ${sessionName}`);
        // Ensure Claude is running in the session
        await this.tmux.ensureClaudeRunning(sessionName, workDir, this.config.model);
      } else {
        // Session doesn't exist, create it
        logger.info(`Session ${sessionName} not found, creating new one`);
        await this.tmux.createSessionWithClaude(sessionName, workDir, env, this.config.model, sessionLogPath ?? undefined);
      }
    } else {
      // Fresh mode: always create new session
      await this.tmux.createSessionWithClaude(sessionName, workDir, env, this.config.model, sessionLogPath ?? undefined);
    }

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
      model: this.config.model, // Store model for restarts
    };

    this.instanceManager.addInstance(instance);
    logger.info(`${resumeMode ? 'Reconnected to' : 'Created'} instance: ${id}`, {
      workDir,
      authConfig: authConfig?.name ?? 'OAuth',
    });

    return instance;
  }

  private getSessionLogPath(instanceId: string): string | null {
    if (!this.runLogDir) {
      return null;
    }
    return join(this.runLogDir, `session-${instanceId}.log`);
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
   * Build the auth rotation pool based on configured mode.
   * - oauth: OAuth first, then API keys
   * - api-keys-first: API keys first, then OAuth
   * - api-keys-only: API keys only (no OAuth fallback)
   */
  private buildAuthRotationPool(): Array<AuthConfig | null> {
    if (this.config.authMode === 'api-keys-only') {
      return [...this.authConfigs];
    }

    if (this.config.authMode === 'api-keys-first') {
      if (this.authConfigs.length === 0) {
        logger.warn('authMode "api-keys-first" requested but no auth configs found; falling back to OAuth');
        return [null];
      }
      return [...this.authConfigs, null];
    }

    // Default oauth mode
    return this.authConfigs.length > 0 ? [null, ...this.authConfigs] : [null];
  }

  private validateAuthMode(): void {
    if (this.config.authMode === 'api-keys-only' && this.authConfigs.length === 0) {
      throw new Error('authMode "api-keys-only" requires at least one auth config in auth-configs.json');
    }
  }

  /**
   * Get the configured startup auth (first entry in the pool).
   */
  private getStartupAuthConfig(): AuthConfig | null {
    if (this.authRotationPool.length === 0) {
      return null;
    }
    return this.authRotationPool[0];
  }

  private shouldDistributeStartupAuths(): boolean {
    if (this.authConfigs.length < 2) {
      return false;
    }

    if (this.config.authMode === 'api-keys-only') {
      return true;
    }

    if (this.config.authMode === 'api-keys-first' && this.authConfigs.length > 0) {
      return true;
    }

    return false;
  }

  private getStartupAuthForInstance(): AuthConfig | null {
    if (!this.shouldDistributeStartupAuths()) {
      return this.getStartupAuthConfig();
    }

    const auth = this.authConfigs[this.startupAuthAssignmentIndex % this.authConfigs.length];
    this.startupAuthAssignmentIndex++;
    return auth;
  }

  private getStartupAuthLogLabel(): string {
    if (this.shouldDistributeStartupAuths()) {
      return `distributed across ${this.authConfigs.length} configs`;
    }

    return this.getStartupAuthConfig()?.name ?? 'OAuth';
  }

  /**
   * Rotate to the next auth config. Returns null when OAuth should be used.
   */
  private getNextAuthConfig(): AuthConfig | null {
    if (this.authRotationPool.length === 0) {
      return null;
    }

    this.authRotationIndex = (this.authRotationIndex + 1) % this.authRotationPool.length;
    return this.authRotationPool[this.authRotationIndex] ?? null;
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

  private async initializeDirector(): Promise<void> {
    // Wait for Claude to initialize
    await new Promise(r => setTimeout(r, 3000));

    const prompt = `
You are the **Director** of the Claude Code Orchestrator.

## Your Environment
- Working directory: ${this.workspaceDir}
- Target branch: ${this.config.branch}
- Engineering Managers: ${this.teams.length}
- Workers: ${this.config.workerCount}

## Responsibilities
1. Set direction based on PROJECT_DIRECTION.md.
2. Define priorities for each Engineering Manager (EM) and review their escalations.
3. Re-size teams dynamically after every merge. Team size must stay ≤ ${this.config.engineerManagerGroupSize}.
4. Catch failing EMs or teams and kill/recreate them when needed.
5. Merge only EM branches—never manage workers directly.

## Immediate Tasks
1. Review PROJECT_DIRECTION.md and summarize focus for each team in TEAM_STRUCTURE.md.
2. Create EM_<id>_TASKS.md files outlining goals per EM. Do **not** edit worker task lists directly.
3. Commit/push your planning docs, then STOP and await EM escalations.

Document every team decision so you can justify resizing or killing teams later.
    `.trim();

    await this.instanceManager.sendPrompt('director', prompt);

    // Initialize EMs and workers after Claude spins up
    setTimeout(() => this.initializeEngineeringManagers(), 10000);
    setTimeout(() => this.initializeWorkers(), 20000);
  }

  private async initializeManager(): Promise<void> {
    await new Promise(r => setTimeout(r, 3000));

    const prompt = `
You are the **Manager** of the Claude Code Orchestrator.

## Your Environment
- Working directory: ${this.workspaceDir}
- Target branch: ${this.config.branch}
- Workers: ${this.config.workerCount}

## Responsibilities
1. Read PROJECT_DIRECTION.md and create/maintain each WORKER_<id>_TASK_LIST.md.
2. Review worker output, merge branches directly into ${this.config.branch}, and push.
3. Keep workers unblocked: assign new tasks, clarify priorities, and ensure they never wait on you.
4. Stay decisive—resolve conflicts yourself and never defer work back to workers.

## Immediate Tasks
1. Sync ${this.config.branch} and inspect PROJECT_DIRECTION.md.
2. Draft/refresh all WORKER_<id>_TASK_LIST.md files with clear queues and "Current Task" sections.
3. Commit/push your planning changes.
4. Monitor worker branches and merge as soon as they push.

Document every decision in PROJECT_DIRECTION.md or worker task lists so future restarts retain context.
    `.trim();

    await this.instanceManager.sendPrompt('manager', prompt);
    setTimeout(() => this.initializeWorkers(), 5000);
  }

  private async initializeEngineeringManagers(): Promise<void> {
    for (const team of this.teams) {
      if (team.status !== 'active') continue;
      await this.initializeEngineeringManager(team);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  private async initializeEngineeringManager(team: EngineeringTeam): Promise<void> {
    const prompt = `
You are **Engineering Manager ${team.id} (EM-${team.id})**.

## Team
- Workers: ${team.workerIds.map(id => `worker-${id}`).join(', ')}
- Branch: ${team.branchName}
- Worktree: ${team.worktreePath}

## Mission
1. Keep ${team.branchName} in sync with ${this.config.branch}.
2. Own task assignment. Maintain EM_${team.id}_TASKS.md and update each WORKER_<id>_TASK_LIST.md when giving tasks.
3. Merge worker branches locally, run validations, and escalate to the Director only when stable.
4. Be ready for roster changes; Director may resize or kill teams without notice.

Start now: pull ${this.config.branch}, read PROJECT_DIRECTION.md, draft EM_${team.id}_TASKS.md, and assign focused work to your workers.
    `.trim();

    await this.instanceManager.sendPrompt(team.emInstanceId, prompt);
  }

  private async initializeWorkers(): Promise<void> {
    for (let i = 1; i <= this.config.workerCount; i++) {
      await this.initializeWorker(i);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

    private async initializeWorker(workerId: number): Promise<void> {
     const worktreePath = `${this.workspaceDir}/worktrees/worker-${workerId}`;
    const team = this.getTeamForWorker(workerId);
    const fallbackLabel = this.useHierarchy ? 'unassigned' : 'manager';
    const teamLabel = team ? `EM-${team.id}` : fallbackLabel;

     const prompt = `
  You are **Worker ${workerId}** reporting to ${teamLabel}.

  ## Environment
  - Worktree: ${worktreePath}
  - Branch: worker-${workerId}
  - Target branch: ${this.config.branch}

  ## Rules
  1. Follow directives from ${teamLabel} via WORKER_${workerId}_TASK_LIST.md.
  2. Stay in your worktree; never touch other teams' directories.
  3. Keep commits tight and descriptive.
  4. STOP after pushing and wait for your EM.

  ## Workflow
  1. Sync: git fetch origin && git pull origin worker-${workerId} --rebase 2>/dev/null || true
  2. Read WORKER_${workerId}_TASK_LIST.md (maintained by ${teamLabel}).
  3. Execute the current task fully.
  4. git add -A && git commit -m "Complete: <task>" && git push origin worker-${workerId} --force.

  When you stop, your EM will merge and the Director will handle escalations.
     `.trim();

     await this.instanceManager.sendPrompt(`worker-${workerId}`, prompt);
     logger.info(`Worker ${workerId} initialized`);
    }

  private handleTaskComplete(workerId: number, instanceType: 'director' | 'em' | 'worker' | 'manager'): void {
    if (this.isShuttingDown) return;

    if (!this.useHierarchy) {
      if (instanceType === 'worker') {
        logger.info(`Worker ${workerId} completed task - queueing merge for manager`);
        this.managerMergeQueue?.enqueue(workerId);
        this.processManagerMergeQueue();
      } else if (instanceType === 'manager') {
        logger.info('Manager completed merge - checking next worker');
        this.processManagerMergeQueue();
      }
      return;
    }

    if (instanceType === 'worker') {
      const team = this.getTeamForWorker(workerId);
      if (!team) {
        logger.warn(`Worker ${workerId} completed task but no team assignment found`);
        return;
      }

      logger.info(`Worker ${workerId} completed task - queueing for EM-${team.id}`);
      team.mergeQueue.enqueue(workerId);
      this.processTeamMergeQueue(team.id);
      return;
    }

    if (instanceType === 'em') {
      logger.info(`Engineering Manager ${workerId} escalated changes - notifying director`);
      this.directorMergeQueue?.enqueue(workerId);
      this.processDirectorMergeQueue();
      void this.assessTeams(`em-${workerId}-merge`).catch(err => {
        logger.warn('Team assessment failed after EM merge', err);
      });
      return;
    }

    logger.info('Director completed merge - checking next team');
    this.processDirectorMergeQueue();
    void this.assessTeams('director-merge').catch(err => {
      logger.warn('Team assessment failed after director merge', err);
    });
  }

  private processTeamMergeQueue(teamId: number): void {
    if (!this.useHierarchy) {
      return;
    }

    const team = this.getTeam(teamId);
    if (!team || team.mergeQueue.isCurrentlyProcessing()) {
      return;
    }

    team.mergeQueue.processNext().catch((err: unknown) => {
      logger.warn(`Failed to process merge queue for EM-${teamId}`, err);
    });
  }

  private processManagerMergeQueue(): void {
    if (!this.managerMergeQueue || this.managerMergeQueue.isCurrentlyProcessing()) {
      return;
    }

    this.managerMergeQueue.processNext().catch((err: unknown) => {
      logger.warn('Failed to process manager merge queue', err);
    });
  }

  private processDirectorMergeQueue(): void {
    if (!this.useHierarchy || !this.directorMergeQueue || this.directorMergeQueue.isCurrentlyProcessing()) {
      return;
    }

    this.directorMergeQueue.processNext().catch((err: unknown) => {
      logger.error('Failed to process director merge queue', err);
    });
  }

  private async notifyEngineeringManagerOfCompletion(teamId: number, workerId: number): Promise<void> {
    if (!this.useHierarchy) {
      return;
    }

    const team = this.getTeam(teamId);
    if (!team) {
      throw new Error(`Team ${teamId} not found`);
    }

    const emInstance = this.instanceManager.getInstance(team.emInstanceId);
    const ready = await this.canPromptInstance(emInstance);
    if (!ready) {
      logger.info(`EM-${teamId} busy - deferring worker-${workerId} merge prompt`);
      this.scheduleTeamMergeRetry(teamId, workerId);
      return;
    }

    const prompt = `
You are **Engineering Manager ${teamId} (EM-${teamId})**.

Worker ${workerId} finished a task. Merge their branch into ${team.branchName}:

1. Sync main and worker branch:
   git fetch origin
   git checkout ${team.branchName}
   git pull --rebase origin ${this.config.branch}
   git merge --no-ff worker-${workerId}

2. Resolve any conflicts, run tests, and update WORKER_${workerId}_TASK_LIST.md with results.

3. Push ${team.branchName} to origin and STOP so the director can review.

4. Review team task priorities and be ready to reassign work if the director reshapes your team.
    `.trim();

    await this.instanceManager.sendPrompt(team.emInstanceId, prompt);
    team.priorityScore = Date.now();
  }

  private async notifyDirectorOfCompletion(teamId: number): Promise<void> {
    if (!this.useHierarchy || !this.directorMergeQueue) {
      return;
    }

    const team = this.getTeam(teamId);
    if (!team) {
      throw new Error(`Team ${teamId} not found for director escalation`);
    }

    const director = this.instanceManager.getInstance('director');
    const ready = await this.canPromptInstance(director);
    if (!ready) {
      logger.info('Director busy - deferring escalation', { teamId });
      this.scheduleDirectorMergeRetry(teamId);
      return;
    }

    const prompt = `
You are the **Director**. EM-${teamId} has escalated their branch ${team.branchName}.

1. Sync main:
   git fetch origin
   git checkout ${this.config.branch}
   git pull --rebase origin ${this.config.branch}

2. Merge the team branch:
   git merge --no-ff ${team.branchName}

3. Resolve conflicts, run validations, update high-level direction docs, and push.

4. Assess team priorities and size. Use the data in EM_${teamId}_TASKS.md and worker throughput to decide if you should redistribute workers.

5. If a team must be killed or resized, note it in TEAM_STRUCTURE.md and issue commands to the orchestrator dashboard.
    `.trim();

    await this.instanceManager.sendPrompt('director', prompt);
    team.lastAssessment = Date.now();
  }

  private async canPromptInstance(instance?: ClaudeInstance): Promise<boolean> {
    if (!instance || instance.status !== 'idle') {
      return false;
    }
    try {
      return await this.tmux.isAtClaudePrompt(instance.sessionName);
    } catch (err) {
      logger.warn('Failed to inspect tmux prompt state', { instanceId: instance?.id, err });
      return false;
    }
  }

  private scheduleTeamMergeRetry(teamId: number, workerId: number, delayMs = 5000): void {
    if (!this.useHierarchy) {
      return;
    }
    setTimeout(() => {
      if (this.isShuttingDown) {
        return;
      }
      const team = this.getTeam(teamId);
      if (!team || team.status !== 'active') {
        return;
      }
      team.mergeQueue.enqueue(workerId);
      this.processTeamMergeQueue(team.id);
    }, delayMs);
  }

  private scheduleDirectorMergeRetry(teamId: number, delayMs = 5000): void {
    if (!this.useHierarchy || !this.directorMergeQueue) {
      return;
    }
    setTimeout(() => {
      if (this.isShuttingDown || !this.directorMergeQueue) {
        return;
      }
      this.directorMergeQueue.enqueue(teamId);
      this.processDirectorMergeQueue();
    }, delayMs);
  }

  private async assessTeams(reason: string): Promise<void> {
    if (this.isShuttingDown || !this.useHierarchy) return;

    logger.debug(`Assessing teams due to ${reason}`);
    await this.rebalanceTeams();
  }

  private async rebalanceTeams(): Promise<void> {
    if (!this.useHierarchy) {
      return;
    }

    const activeTeams = this.teams.filter(team => team.status === 'active');
    if (activeTeams.length === 0) {
      return;
    }

    const workerIds = Array.from({ length: this.config.workerCount }, (_, idx) => idx + 1);
    const baseSize = Math.floor(workerIds.length / activeTeams.length);
    let remainder = workerIds.length % activeTeams.length;
    let cursor = 0;

    for (const team of activeTeams.sort((a, b) => a.id - b.id)) {
      const targetSize = baseSize + (remainder > 0 ? 1 : 0);
      if (remainder > 0) {
        remainder--;
      }
      const slice = workerIds.slice(cursor, cursor + targetSize);
      cursor += targetSize;
      await this.updateTeamAssignments(team, slice);
    }
  }

  private async updateTeamAssignments(team: EngineeringTeam, desiredWorkers: number[]): Promise<void> {
    if (!this.useHierarchy) {
      return;
    }

    const currentWorkers = new Set(team.workerIds);
    const desiredSet = new Set(desiredWorkers);

    const removedWorkers = team.workerIds.filter(id => !desiredSet.has(id));
    const addedWorkers = desiredWorkers.filter(id => !currentWorkers.has(id));

    if (removedWorkers.length === 0 && addedWorkers.length === 0) {
      return;
    }

    team.workerIds = desiredWorkers;
    desiredWorkers.forEach(workerId => this.workerToTeam.set(workerId, team.id));

    const emUpdate = `
## Team Roster Update

Your team now manages workers: ${desiredWorkers.map(id => `worker-${id}`).join(', ')}.

Removed: ${removedWorkers.length ? removedWorkers.join(', ') : 'none'}
Added: ${addedWorkers.length ? addedWorkers.join(', ') : 'none'}

Refresh your task allocations accordingly and update EM_${team.id}_TASKS.md.
    `.trim();

    try {
      await this.instanceManager.sendPrompt(team.emInstanceId, emUpdate);
    } catch (err) {
      logger.warn(`Failed to notify EM-${team.id} about roster change`, err);
    }

    for (const workerId of addedWorkers) {
      const workerPrompt = `
## Team Assignment Update

You now report to EM-${team.id}. Fetch ${team.branchName} for context and follow EM_${team.id}_TASKS.md.
      `.trim();
      try {
        await this.instanceManager.sendPrompt(`worker-${workerId}`, workerPrompt);
      } catch (err) {
        logger.warn(`Failed to notify worker-${workerId} about new EM`, err);
      }
    }
  }

  /**
   * Prompt an idle worker to continue working on their next task.
   */
  private async promptWorkerToContinue(workerId: number): Promise<void> {
    const worktreePath = `${this.workspaceDir}/worktrees/worker-${workerId}`;

    const prompt = `
## Continue Working

Your previous task was merged. Time to work on your next task.

1. **Sync with latest ${this.config.branch}** (your work was already merged):
   \`\`\`bash
   git fetch origin
   git rebase origin/${this.config.branch}
   \`\`\`

2. **Read your updated task list**:
   \`\`\`bash
   cat WORKER_${workerId}_TASK_LIST.md
   \`\`\`

3. **Work on the "Current Task"** - implement it fully

4. **Commit and push when done**:
   \`\`\`bash
   git add -A
   git commit -m "Complete: <task description>"
   git push origin worker-${workerId} --force
   \`\`\`

5. **STOP after pushing**

Start now: Sync and read your task list.
    `.trim();

    this.instanceManager.updateStatus(`worker-${workerId}`, 'busy');
    await this.instanceManager.sendPrompt(`worker-${workerId}`, prompt);
    logger.info(`Worker ${workerId} prompted to continue`);
  }

  private async notifyManagerOfCompletion(workerId: number): Promise<void> {
    if (this.useHierarchy || !this.managerMergeQueue) {
      return;
    }

    const prompt = `
  ## Worker ${workerId} Completed

  Worker ${workerId} pushed to branch \`worker-${workerId}\`.

  ## CRITICAL RULES
  - **NEVER ask questions** - make decisions and act
  - **YOU resolve conflicts** - don't tell workers to fix things, fix them yourself
  - **Be decisive** - pick the best resolution and move forward
  - **STAY in ${this.workspaceDir}** - NEVER cd into worker directories

  ## Your Actions

  0. **Verify you're in the right place**:
    \`\`\`bash
    pwd  # Must show: ${this.workspaceDir}
    git status --short  # Must show: On branch ${this.config.branch}
    \`\`\`

  1. **Fetch and review**:
    \`\`\`bash
    git fetch origin worker-${workerId}
    git diff ${this.config.branch}...origin/worker-${workerId} --stat
    \`\`\`

  2. **Attempt merge**:
    \`\`\`bash
    git merge origin/worker-${workerId} --no-ff -m "Merge worker-${workerId}"
    \`\`\`

  3. **If merge conflicts occur, RESOLVE THEM**:
    - For each conflicted file, examine the conflict markers
    - Use your judgment to combine both changes intelligently
    - If worker's changes are clearly better: \`git checkout --theirs <file>\`
    - If existing changes should win: \`git checkout --ours <file>\`
    - For complex conflicts: edit the file to include both changes properly
    - After resolving: \`git add <resolved-files> && git commit -m "Merge worker-${workerId} (resolved conflicts)"\`

  4. **If worker deleted files that shouldn't be deleted**:
    - Restore them: \`git checkout HEAD -- <file>\`
    - Then complete the merge

  5. **Push the merged result**:
    \`\`\`bash
    git push origin ${this.config.branch}
    \`\`\`

  6. **Update task list**:
    - Read WORKER_${workerId}_TASK_LIST.md
    - Move completed task to "Completed" section
    - If Queue is empty, **CREATE NEW TASKS** based on PROJECT_DIRECTION.md priorities:
      * Parser Squad: Fix TS1005/TS1109 false positives
      * Binder Squad: Fix TS2304 error poisoning, lib.d.ts integration
      * CFA Squad: Edge cases for TS2564/TS2454
      * Solver Squad: TS2322, TS7006 strictness
    - Set next "Current Task" from Queue

  7. **Commit and push task update**

  8. **STOP**
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

  /**
   * Manager heartbeat - used when hierarchy is disabled.
   */
  private startManagerHeartbeat(intervalMs: number): void {
    if (this.useHierarchy) {
      return;
    }

    if (this.managerHeartbeatInterval) {
      clearInterval(this.managerHeartbeatInterval);
    }

    this.managerHeartbeatInterval = setInterval(() => {
      this.sendManagerHeartbeat().catch(err => {
        logger.error('Manager heartbeat failed', err);
      });
    }, intervalMs);

    logger.info(`Manager heartbeat started (interval: ${intervalMs / 60000} minutes)`);
  }

  private async sendManagerHeartbeat(): Promise<void> {
    if (this.isShuttingDown) return;

    if (!this.useHierarchy) {
      const manager = this.instanceManager.getInstance('manager');
      if (!manager) return;
      if (manager.status !== 'idle') {
        logger.debug('Manager is busy, skipping heartbeat');
        return;
      }

      const atPrompt = await this.tmux.isAtClaudePrompt(manager.sessionName);
      if (!atPrompt) {
        logger.debug('Manager not at prompt, skipping heartbeat');
        return;
      }

      logger.info('Sending manager heartbeat');

      const heartbeatPrompt = `
HEARTBEAT CHECK - Perform routine maintenance. NEVER ask questions, just act.

**IMPORTANT**: Stay in ${this.workspaceDir} - NEVER cd into worker directories.

1. **Verify your branch**: \`git status --short\` (must show "On branch ${this.config.branch}")

2. **Check for pending merges**: \`git fetch --all\`
   For each worker branch with commits ahead of ${this.config.branch}, merge it.

3. **Check for idle workers needing tasks**:
   \`\`\`bash
   for i in {1..${this.config.workerCount}}; do
     if grep -q "All tasks completed\\|Queue\\s*(none)" WORKER_\${i}_TASK_LIST.md 2>/dev/null; then
       echo "Worker $i needs new tasks"
     fi
   done
   \`\`\`

4. **Assign new tasks to idle workers**:
   - Read PROJECT_DIRECTION.md for priorities
   - Update WORKER_N_TASK_LIST.md with new tasks from the priority list:
     * Parser Squad: Fix TS1005/TS1109 false positives
     * Binder Squad: Fix TS2304 error poisoning
     * CFA Squad: Edge cases for TS2564/TS2454
     * Solver Squad: TS2322, TS7006 strictness
   - Commit and push updated task lists

If everything looks good: Output a one-line status and STOP.
If action needed: Take the action, then STOP.
`.trim();

      this.instanceManager.updateStatus('manager', 'busy');
      await this.instanceManager.sendPrompt('manager', heartbeatPrompt);
    }
  }

  /**
   * Director heartbeat - only runs when hierarchy is enabled.
   */
  private startDirectorHeartbeat(intervalMs: number): void {
    if (this.directorHeartbeatInterval) {
      clearInterval(this.directorHeartbeatInterval);
    }

    this.directorHeartbeatInterval = setInterval(() => {
      this.sendDirectorHeartbeat().catch(err => {
        logger.error('Director heartbeat failed', err);
      });
    }, intervalMs);

    logger.info(`Director heartbeat started (interval: ${intervalMs / 60000} minutes)`);
  }

  private async sendDirectorHeartbeat(): Promise<void> {
    if (this.isShuttingDown) return;
    if (!this.useHierarchy) return;

    const director = this.instanceManager.getInstance('director');
    if (!director) return;

    if (director.status !== 'idle') {
      logger.debug('Director is busy, skipping heartbeat');
      return;
    }

    const atPrompt = await this.tmux.isAtClaudePrompt(director.sessionName);
    if (!atPrompt) {
      logger.debug('Director not at prompt, skipping heartbeat');
      return;
    }

    logger.info('Sending director heartbeat');

    const heartbeatPrompt = `
## DIRECTOR HEARTBEAT

You only coordinate Engineering Managers. NEVER touch worker task lists directly.

1. **Verify repo state**:
   \`\`\`bash
   pwd  # must be ${this.workspaceDir}
   git status --short
   git fetch origin
   \`\`\`

2. **Inspect EM branches**:
   \`\`\`bash
   for branch in $(git for-each-ref --format='%(refname:short)' refs/heads/em-team-*); do
     git checkout $branch && git pull --rebase origin $branch || true
     git log --oneline -5
   done
   git checkout ${this.config.branch}
   \`\`\`

3. **Audit team docs**:
   - Review TEAM_STRUCTURE.md and every EM_<id>_TASKS.md
   - Compare worker throughput vs. expectations
   - Flag EMs that are stalled or producing low-quality escalations

4. **Act**:
   - Update TEAM_STRUCTURE.md with any roster/size changes
   - Reassign workers between teams by editing EM_<id>_TASKS.md summaries
   - If a team must be killed, note it and instruct the orchestrator to rebuild that EM branch

5. **Report**: Output a one-line summary of which teams are healthy vs at risk, then STOP.
    `.trim();

    this.instanceManager.updateStatus('director', 'busy');
    await this.instanceManager.sendPrompt('director', heartbeatPrompt);
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
      await this.tmux.ensureClaudeRunning(sessionName, instance.workDir, instance.model);

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

    // Re-prompt idle workers to continue working (with cooldown to prevent bombardment)
    if (instance.type === 'worker' && instance.status === 'idle') {
      const atPrompt = await this.tmux.isAtClaudePrompt(sessionName);
      if (atPrompt) {
        const idleTime = instance.lastToolUse
          ? Date.now() - instance.lastToolUse.getTime()
          : Date.now() - instance.createdAt.getTime();

        // Check cooldown: don't re-prompt if we recently prompted this worker
        const lastPromptTime = this.workerLastPromptTime.get(instance.workerId) || 0;
        const timeSinceLastPrompt = Date.now() - lastPromptTime;

        // Only re-prompt if:
        // 1. Worker has been idle for 5+ minutes AND
        // 2. We haven't prompted them in the last 5 minutes AND
        // 3. Manager is not currently busy processing merges
        const team = this.getTeamForWorker(instance.workerId);
        const teamQueueBusy = team?.mergeQueue.isCurrentlyProcessing() ?? false;

        const orchestratorQueueBusy = this.useHierarchy
          ? (this.directorMergeQueue?.isCurrentlyProcessing() ?? false)
          : (this.managerMergeQueue?.isCurrentlyProcessing() ?? false);

        if (idleTime > Orchestrator.WORKER_IDLE_THRESHOLD_MS &&
          timeSinceLastPrompt > Orchestrator.WORKER_PROMPT_COOLDOWN_MS &&
          !orchestratorQueueBusy &&
          !teamQueueBusy) {
          logger.info(`Worker ${instance.workerId} idle for ${Math.round(idleTime / 60000)}m, prompting to continue`);
          this.workerLastPromptTime.set(instance.workerId, Date.now());
          await this.promptWorkerToContinue(instance.workerId);
        }
      }
    }

    // Check for workers at prompt but marked as 'ready' (just started but not working)
    if (instance.type === 'worker' && instance.status === 'ready') {
      const atPrompt = await this.tmux.isAtClaudePrompt(sessionName);
      if (atPrompt) {
        const timeSinceCreation = Date.now() - instance.createdAt.getTime();
        // If worker has been in 'ready' state for over 30 seconds at prompt, nudge them
        if (timeSinceCreation > 30000) {
          logger.info(`Worker ${instance.workerId} stuck in ready state, initializing`);
          await this.initializeWorker(instance.workerId);
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
      return;
    }

    // Check for pending input in prompt buffer (text typed but not submitted)
    const hasPendingInput = await this.tmux.hasPendingInput(sessionName);
    if (hasPendingInput) {
      logger.info(`Instance ${instance.id} has pending input in prompt buffer, sending Enter`);
      await this.tmux.sendEnter(sessionName);
      instance.lastToolUse = new Date(); // Reset timer
      return;
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
    if (this.managerHeartbeatInterval) {
      clearInterval(this.managerHeartbeatInterval);
      this.managerHeartbeatInterval = null;
    }
    if (this.directorHeartbeatInterval) {
      clearInterval(this.directorHeartbeatInterval);
      this.directorHeartbeatInterval = null;
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
    const snapshot = this.getSessionSnapshot();

    return {
      instances: snapshot.instances,
      costs: snapshot.costs,
      directorQueueSize: snapshot.queues.directorQueueSize,
      managerQueueSize: snapshot.queues.managerQueueSize,
      teams: snapshot.queues.teams,
      hierarchyEnabled: snapshot.meta.hierarchyEnabled,
      authConfigsAvailable: snapshot.auth.configs.length,
      runLogDirectory: snapshot.logs.runLogDir,
    };
  }

  getSessionSnapshot(): SessionSnapshot {
    const instanceStats = this.instanceManager.getStats();
    const instances = this.instanceManager.getAllInstances();
    const instanceList: InstanceSnapshot[] = instances.map((instance) => ({
      id: instance.id,
      type: instance.type,
      status: instance.status,
      workerId: instance.workerId,
      currentTask: instance.currentTask,
      lastToolUse: instance.lastToolUse ? instance.lastToolUse.toISOString() : null,
      toolUseCount: instance.toolUseCount,
      sessionName: instance.sessionName,
      workDir: instance.workDir,
      logFile: this.getSessionLogPath(instance.id),
      authConfig: instance.apiKey ?? null,
      createdAt: instance.createdAt.toISOString(),
    }));

    const costStats = this.costTracker.getStats();
    const toolUsesPerInstance = Array.from(costStats.toolUsesPerInstance.entries()).map(([id, count]) => ({
      id,
      count,
    }));

    return {
      meta: {
        repositoryUrl: this.config.repositoryUrl,
        branch: this.config.branch,
        workspaceDir: this.workspaceDir,
        runLogDir: this.runLogDir,
        workerCount: this.config.workerCount,
        hierarchyEnabled: this.useHierarchy,
        startedAt: this.startTimestamp?.toISOString() ?? null,
        model: this.config.model,
      },
      instances: {
        total: instanceStats.total,
        byStatus: instanceStats.byStatus,
        totalToolUses: instanceStats.totalToolUses,
        list: instanceList,
      },
      queues: {
        directorQueueSize: this.directorMergeQueue?.size() ?? 0,
        managerQueueSize: this.managerMergeQueue?.size() ?? 0,
        teams: this.teams.map((team) => ({
          id: team.id,
          status: team.status,
          workers: team.workerIds,
          queueSize: team.mergeQueue.size(),
          lastAssessment: team.lastAssessment,
          branchName: team.branchName,
          worktreePath: team.worktreePath,
          priorityScore: team.priorityScore,
        })),
      },
      costs: {
        totalToolUses: costStats.totalToolUses,
        runDurationMinutes: costStats.runDurationMinutes,
        startTime: costStats.startTime.toISOString(),
        toolUsesPerInstance,
        limits: this.costTracker.getLimits(),
      },
      auth: {
        mode: this.config.authMode,
        configs: this.authConfigs.map((cfg) => cfg.name),
        rotationPoolSize: this.authRotationPool.length,
      },
      logs: {
        runLogDir: this.runLogDir,
        sessions: instanceList.map((instance) => ({ id: instance.id, path: instance.logFile })),
      },
    };
  }

  private resolveUiBuildDir(): string | null {
    const envValue = process.env.ORCHESTRATOR_UI_DIR ?? process.env.ORCHESTRATOR_UI_DIST;
    const candidates = [envValue, join(process.cwd(), 'web', 'out', 'ui'), join(process.cwd(), 'web', 'out')];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const trimmed = candidate.trim();
      if (!trimmed) {
        continue;
      }

      const indexPath = join(trimmed, 'index.html');
      if (existsSync(indexPath)) {
        return trimmed;
      }
    }

    return null;
  }
}

export interface InstanceSnapshot {
  id: string;
  type: InstanceType;
  status: InstanceStatus;
  workerId: number;
  currentTask?: string;
  lastToolUse: string | null;
  toolUseCount: number;
  sessionName: string;
  workDir: string;
  logFile: string | null;
  authConfig: string | null;
  createdAt: string;
}

export interface TeamSnapshot {
  id: number;
  status: EngineeringTeam['status'];
  workers: number[];
  queueSize: number;
  lastAssessment: number;
  branchName: string;
  worktreePath: string;
  priorityScore: number;
}

export interface SessionSnapshot {
  meta: {
    repositoryUrl: string;
    branch: string;
    workspaceDir: string;
    runLogDir: string | null;
    workerCount: number;
    hierarchyEnabled: boolean;
    startedAt: string | null;
    model?: string;
  };
  instances: {
    total: number;
    byStatus: Record<InstanceStatus, number>;
    totalToolUses: number;
    list: InstanceSnapshot[];
  };
  queues: {
    directorQueueSize: number;
    managerQueueSize: number;
    teams: TeamSnapshot[];
  };
  costs: {
    totalToolUses: number;
    runDurationMinutes: number;
    startTime: string;
    toolUsesPerInstance: Array<{ id: string; count: number }>;
    limits: CostLimits;
  };
  auth: {
    mode: OrchestratorConfig['authMode'];
    configs: string[];
    rotationPoolSize: number;
  };
  logs: {
    runLogDir: string | null;
    sessions: Array<{ id: string; path: string | null }>;
  };
}
