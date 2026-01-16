/**
 * Worker - Non-interactive Claude Code execution via --print mode
 *
 * This is the core simplification of the v2 architecture:
 * - No tmux sessions
 * - No terminal scraping
 * - No state detection
 * - Just run a process, wait for exit, check result
 */

import { execa, type ExecaError } from 'execa';
import { logger } from '../utils/logger.js';
import type { TaskResult, AuthConfig } from './types.js';

/** Rate limit detection patterns */
const RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /429/,
  /too many requests/i,
  /quota exceeded/i,
  /temporarily unavailable/i,
  /overloaded/i,
];

/** Worker configuration */
export interface WorkerConfig {
  id: number;
  worktreePath: string;
  model?: string;
  timeoutMs: number;
  authConfig?: AuthConfig;
}

/**
 * Worker class - executes tasks via `claude --print`
 *
 * Each task execution is atomic:
 * 1. Spawn `claude --print "prompt"`
 * 2. Wait for process to exit
 * 3. Return result with stdout/stderr/exit code
 */
export class WorkerExecutor {
  private config: WorkerConfig;

  constructor(config: WorkerConfig) {
    this.config = config;
  }

  /**
   * Execute a task prompt using Claude's --print mode
   */
  async runTask(prompt: string): Promise<TaskResult> {
    const startTime = Date.now();

    logger.info(`Worker ${this.config.id} starting task`, {
      workerId: this.config.id,
      worktreePath: this.config.worktreePath,
      promptLength: prompt.length,
    });

    try {
      const args = this.buildArgs(prompt);
      const env = this.buildEnv();

      const result = await execa('claude', args, {
        cwd: this.config.worktreePath,
        timeout: this.config.timeoutMs,
        env,
        reject: false, // Don't throw on non-zero exit
        stdin: 'ignore',
        stripFinalNewline: true,
      });

      const durationMs = Date.now() - startTime;
      const rateLimited = this.isRateLimited(result.stderr);

      logger.info(`Worker ${this.config.id} task completed`, {
        workerId: this.config.id,
        exitCode: result.exitCode,
        durationMs,
        rateLimited,
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
      });

      const exitCode = result.exitCode ?? 0;

      return {
        success: exitCode === 0,
        output: result.stdout,
        stderr: result.stderr,
        exitCode,
        durationMs,
        rateLimited,
        timedOut: false,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const execaError = error as ExecaError;

      // Check if it was a timeout
      const timedOut = execaError.timedOut ?? false;

      logger.error(`Worker ${this.config.id} task failed`, {
        workerId: this.config.id,
        error: execaError.message,
        timedOut,
        durationMs,
      });

      return {
        success: false,
        output: String(execaError.stdout ?? ''),
        stderr: String(execaError.stderr ?? execaError.message),
        exitCode: typeof execaError.exitCode === 'number' ? execaError.exitCode : -1,
        durationMs,
        rateLimited: false,
        timedOut,
      };
    }
  }

  /**
   * Build command line arguments for claude
   */
  private buildArgs(prompt: string): string[] {
    const args = [
      '--print',
      '--dangerously-skip-permissions',
    ];

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    // Add the prompt as the final argument
    args.push(prompt);

    return args;
  }

  /**
   * Build environment variables for the process
   */
  private buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };

    // Set API key if using API key authentication
    if (this.config.authConfig?.apiKey) {
      env.ANTHROPIC_API_KEY = this.config.authConfig.apiKey;
    }

    return env;
  }

  /**
   * Check if the stderr indicates a rate limit
   */
  private isRateLimited(stderr: string): boolean {
    if (!stderr) return false;

    const lowerStderr = stderr.toLowerCase();
    return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(lowerStderr));
  }

  /**
   * Update the auth config (for rate limit rotation)
   */
  setAuthConfig(authConfig: AuthConfig): void {
    this.config.authConfig = authConfig;
    logger.debug(`Worker ${this.config.id} auth config updated`, {
      workerId: this.config.id,
      authName: authConfig.name,
    });
  }

  /**
   * Get worker ID
   */
  getId(): number {
    return this.config.id;
  }

  /**
   * Get worktree path
   */
  getWorktreePath(): string {
    return this.config.worktreePath;
  }

  /**
   * Update worktree path (after setup)
   */
  setWorktreePath(path: string): void {
    this.config.worktreePath = path;
  }

  /**
   * Update timeout
   */
  setTimeout(timeoutMs: number): void {
    this.config.timeoutMs = timeoutMs;
  }
}

/**
 * Build a worker prompt that instructs Claude to work on a task file
 */
export function buildWorkerPrompt(workerId: number, taskFilePath: string): string {
  return `You are Worker ${workerId} in an automated orchestration system.

Read your task from: ${taskFilePath}

Instructions:
1. Read the task file to understand what you need to do
2. Complete the task described in the file
3. Make incremental commits with clear, descriptive messages
4. Ensure tests pass before finishing (if applicable)
5. Do not modify files outside your task scope unless necessary

When done, your changes will be automatically committed and merged.

Begin working on your assigned task now.`;
}

/**
 * Build a manager/EM prompt for reviewing and merging worker changes
 */
export function buildMergePrompt(
  workerBranch: string,
  targetBranch: string,
  diffSummary?: string
): string {
  const diffSection = diffSummary
    ? `\n\n## Changes to Review\n\`\`\`\n${diffSummary}\n\`\`\``
    : '';

  return `You are reviewing changes from branch "${workerBranch}" to merge into "${targetBranch}".

## Instructions
1. Fetch the latest changes: git fetch origin ${workerBranch}
2. Review the diff: git diff ${targetBranch}...origin/${workerBranch}
3. If changes look good, merge: git merge --no-ff origin/${workerBranch}
4. If there are conflicts, resolve them appropriately
5. Push the merged changes: git push origin ${targetBranch}
${diffSection}

Proceed with the merge review now.`;
}

/**
 * Build a conflict resolution prompt
 */
export function buildConflictResolutionPrompt(conflictedFiles: string[]): string {
  return `You are resolving merge conflicts.

## Conflicted Files
${conflictedFiles.map((f) => `- ${f}`).join('\n')}

## Instructions
For each conflicted file:
1. Read the file content
2. Understand both sides of the conflict (HEAD vs incoming)
3. Resolve by keeping the best of both changes
4. Remove conflict markers (<<<<<<, =======, >>>>>>>)
5. Write the resolved content

After resolving all conflicts:
1. Stage the resolved files: git add <file>
2. Complete the merge: git commit -m "Resolve merge conflicts"
3. Push the changes: git push

Do NOT abandon changes - resolve the conflicts thoughtfully.`;
}
