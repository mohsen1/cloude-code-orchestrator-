import { execa } from 'execa';
import { readdir, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { getGitQueue } from './operation-queue.js';

const DEFAULT_TIMEOUT_MS = 15000;
const STALE_LOCK_MS = 2 * 60 * 1000;
const MAX_LOCK_SCAN_DEPTH = 4;

export interface GitRunOptions {
  allowFailure?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
  retryOnLock?: boolean;
  /** Skip the queue and run immediately (use sparingly) */
  skipQueue?: boolean;
  /** Priority for queued operations */
  priority?: 'high' | 'normal' | 'low';
}

type GitRunResult = Awaited<ReturnType<typeof execa>>;

export async function getGitDir(workDir: string): Promise<string | null> {
  try {
    const result = await execa('git', ['-C', workDir, 'rev-parse', '--absolute-git-dir'], {
      reject: false,
      timeout: DEFAULT_TIMEOUT_MS,
      env: { ...process.env, GIT_PAGER: 'cat' },
    });
    if (result.exitCode !== 0) {
      return null;
    }
    const gitDir = result.stdout.trim();
    return gitDir.length > 0 ? gitDir : null;
  } catch (err) {
    logger.debug('Failed to resolve git dir', { workDir, err });
    return null;
  }
}

async function listLockFiles(root: string, maxDepth: number): Promise<string[]> {
  const results: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.depth > maxDepth) continue;

    let entries: Array<import('fs').Dirent<string>>;
    try {
      entries = await readdir(current.dir, { withFileTypes: true, encoding: 'utf8' }) as Array<import('fs').Dirent<string>>;
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current.dir, entry.name);
      if (entry.isDirectory()) {
        queue.push({ dir: fullPath, depth: current.depth + 1 });
      } else if (entry.isFile() && entry.name.endsWith('.lock')) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function isLockRelatedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('index.lock') ||
    message.includes('could not write index') ||
    message.includes('Another git process') ||
    message.includes('Unable to create') ||
    message.includes('File exists')
  );
}

export async function clearStaleGitLocks(workDir: string, staleMs: number = STALE_LOCK_MS): Promise<string[]> {
  const gitDir = await getGitDir(workDir);
  if (!gitDir || !existsSync(gitDir)) {
    return [];
  }

  const now = Date.now();
  const lockFiles = await listLockFiles(gitDir, MAX_LOCK_SCAN_DEPTH);
  const removed: string[] = [];

  for (const lockFile of lockFiles) {
    try {
      const fileStat = await stat(lockFile);
      if (now - fileStat.mtimeMs < staleMs) {
        continue;
      }
      await rm(lockFile, { force: true });
      removed.push(lockFile);
    } catch {
      continue;
    }
  }

  if (removed.length > 0) {
    logger.warn(`Cleared ${removed.length} stale git lock file(s)`, { workDir, removed });
  }

  return removed;
}

/**
 * Internal implementation that actually runs the git command.
 * This is called either directly (skipQueue) or via the queue.
 */
async function runGitImmediate(
  workDir: string,
  args: string[],
  options: GitRunOptions = {}
): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = { ...process.env, GIT_PAGER: 'cat', ...options.env };
  const retryOnLock = options.retryOnLock ?? true;

  await clearStaleGitLocks(workDir);

  const attempt = async () =>
    execa('git', ['-C', workDir, ...args], {
      reject: !(options.allowFailure ?? false),
      timeout: timeoutMs,
      env,
    });

  try {
    return await attempt();
  } catch (err: unknown) {
    const timedOut = typeof err === 'object' && err !== null && 'timedOut' in err && Boolean((err as { timedOut?: boolean }).timedOut);
    if (retryOnLock && (timedOut || isLockRelatedError(err))) {
      logger.warn('Git command failed, attempting lock cleanup and retry', {
        workDir,
        args: args.join(' '),
      });
      await clearStaleGitLocks(workDir);
      return await attempt();
    }
    throw err;
  }
}

/**
 * Run a git command, serialized through the operation queue to prevent lock contention.
 * 
 * With 14+ workers using worktrees, concurrent git operations can fail due to
 * .git/index.lock conflicts. This function queues operations to run serially.
 * 
 * Use `skipQueue: true` only for read-only commands that don't touch the index.
 */
export async function runGit(
  workDir: string,
  args: string[],
  options: GitRunOptions = {}
): Promise<GitRunResult> {
  // Some commands are safe to run concurrently (read-only)
  const safeCommands = ['rev-parse', 'branch', '--show-current', 'log', 'diff', 'show', 'ls-tree', 'cat-file'];
  const isSafeCommand = safeCommands.some(cmd => args.includes(cmd)) && !args.includes('checkout');
  
  if (options.skipQueue || isSafeCommand) {
    return runGitImmediate(workDir, args, options);
  }

  const queue = getGitQueue();
  return queue.enqueue(
    workDir,
    () => runGitImmediate(workDir, args, options),
    {
      priority: options.priority ?? 'normal',
      label: args.slice(0, 3).join(' '),
    }
  );
}
