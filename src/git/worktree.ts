import { simpleGit, SimpleGit, SimpleGitOptions } from 'simple-git';
import { logger } from '../utils/logger.js';

export class GitManager {
  private git: SimpleGit;
  private baseDir: string;

  constructor(baseDir: string = '/workspace') {
    this.baseDir = baseDir;

    const options: Partial<SimpleGitOptions> = {
      baseDir,
      binary: 'git',
      maxConcurrentProcesses: 6,
    };

    this.git = simpleGit(options);
  }

  /**
   * Clone a repository.
   */
  async clone(repoUrl: string, branch: string, targetDir?: string, depth?: number): Promise<void> {
    const dir = targetDir || this.baseDir;

    logger.info(`Cloning repository`, { url: repoUrl, branch, dir, depth });

    const args = ['--branch', branch];
    if (depth) {
      args.push('--depth', String(depth));
    }

    await this.git.clone(repoUrl, dir, args);

    // Update git instance to use the cloned directory
    this.git.cwd(dir);
    this.baseDir = dir;

    logger.info(`Successfully cloned repository to ${dir}`);
  }

  /**
   * Create a worktree for a worker.
   */
  async createWorktree(branchName: string, path: string): Promise<void> {
    try {
      // Check if branch exists
      const branches = await this.git.branch();

      if (!branches.all.includes(branchName)) {
        // Create new branch from current HEAD
        await this.git.checkoutBranch(branchName, 'HEAD');
        logger.debug(`Created branch: ${branchName}`);
      }

      // Create worktree
      await this.git.raw(['worktree', 'add', path, branchName]);
      logger.info(`Created worktree at ${path} for branch ${branchName}`);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('already exists')) {
        logger.warn(`Worktree already exists at ${path}`);
      } else {
        throw err;
      }
    }
  }

  /**
   * Remove a worktree.
   */
  async removeWorktree(path: string): Promise<void> {
    try {
      await this.git.raw(['worktree', 'remove', path, '--force']);
      logger.info(`Removed worktree at ${path}`);
    } catch (err: unknown) {
      if (err instanceof Error && !err.message.includes('is not a working tree')) {
        throw err;
      }
    }
  }

  /**
   * List all worktrees.
   */
  async listWorktrees(): Promise<string[]> {
    const result = await this.git.raw(['worktree', 'list', '--porcelain']);
    const worktrees = result
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.replace('worktree ', ''));
    return worktrees;
  }

  /**
   * Get branch status relative to main.
   */
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

  /**
   * Fetch from remote.
   */
  async fetch(remote: string = 'origin', branch?: string): Promise<void> {
    if (branch) {
      await this.git.fetch(remote, branch);
    } else {
      await this.git.fetch(remote);
    }
    logger.debug(`Fetched from ${remote}${branch ? `/${branch}` : ''}`);
  }

  /**
   * Pull latest changes.
   */
  async pull(remote: string = 'origin', branch: string = 'main'): Promise<void> {
    await this.git.pull(remote, branch);
    logger.debug(`Pulled ${remote}/${branch}`);
  }

  /**
   * Push to remote.
   */
  async push(remote: string = 'origin', branch: string, setUpstream: boolean = false): Promise<void> {
    const args = setUpstream ? ['-u', remote, branch] : [remote, branch];
    await this.git.push(args);
    logger.debug(`Pushed to ${remote}/${branch}`);
  }

  /**
   * Get current branch name.
   */
  async getCurrentBranch(): Promise<string> {
    const result = await this.git.branch();
    return result.current;
  }

  /**
   * Checkout a branch.
   */
  async checkout(branch: string): Promise<void> {
    await this.git.checkout(branch);
    logger.debug(`Checked out branch: ${branch}`);
  }

  /**
   * Get git instance for advanced operations.
   */
  getRawGit(): SimpleGit {
    return this.git;
  }

  /**
   * Get base directory.
   */
  getBaseDir(): string {
    return this.baseDir;
  }
}
