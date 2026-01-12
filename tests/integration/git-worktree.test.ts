import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitManager } from '../../src/git/worktree.js';
import { rm, mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execa } from 'execa';

describe('GitManager', () => {
  let testDir: string;
  let repoDir: string;
  let gitManager: GitManager;

  beforeEach(async () => {
    testDir = join(tmpdir(), `git-test-${Date.now()}`);
    repoDir = join(testDir, 'repo');
    await mkdir(repoDir, { recursive: true });

    // Initialize a git repo
    await execa('git', ['init'], { cwd: repoDir });
    await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir });
    await execa('git', ['config', 'user.name', 'Test'], { cwd: repoDir });

    // Create initial commit
    await writeFile(join(repoDir, 'README.md'), '# Test Repo');
    await execa('git', ['add', '.'], { cwd: repoDir });
    await execa('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir });

    gitManager = new GitManager(repoDir);
  });

  afterEach(async () => {
    try {
      // Clean up worktrees by pruning
      await execa('git', ['worktree', 'prune'], { cwd: repoDir }).catch(() => {});
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('createWorktree', () => {
    it('should create a new worktree with a new branch', async () => {
      const worktreePath = join(testDir, 'worktree-1');

      // First create the branch
      await execa('git', ['branch', 'feature-1'], { cwd: repoDir });

      // Then create worktree pointing to that branch
      await execa('git', ['worktree', 'add', worktreePath, 'feature-1'], { cwd: repoDir });

      expect(existsSync(worktreePath)).toBe(true);
      expect(existsSync(join(worktreePath, 'README.md'))).toBe(true);
    });
  });

  describe('listWorktrees', () => {
    it('should list all worktrees', async () => {
      const worktree1 = join(testDir, 'wt-1');
      const worktree2 = join(testDir, 'wt-2');

      // Create branches first
      await execa('git', ['branch', 'branch-1'], { cwd: repoDir });
      await execa('git', ['branch', 'branch-2'], { cwd: repoDir });

      // Create worktrees
      await execa('git', ['worktree', 'add', worktree1, 'branch-1'], { cwd: repoDir });
      await execa('git', ['worktree', 'add', worktree2, 'branch-2'], { cwd: repoDir });

      const worktrees = await gitManager.listWorktrees();

      expect(worktrees.length).toBe(3); // main + 2 worktrees
      expect(worktrees.some((w) => w.includes('wt-1'))).toBe(true);
      expect(worktrees.some((w) => w.includes('wt-2'))).toBe(true);
    });

    it('should include main worktree', async () => {
      const worktrees = await gitManager.listWorktrees();

      expect(worktrees.length).toBeGreaterThanOrEqual(1);
      expect(worktrees.some((w) => w.includes('repo'))).toBe(true);
    });
  });

  describe('removeWorktree', () => {
    it('should remove a worktree', async () => {
      const worktreePath = join(testDir, 'worktree-remove');

      // Create branch and worktree
      await execa('git', ['branch', 'remove-branch'], { cwd: repoDir });
      await execa('git', ['worktree', 'add', worktreePath, 'remove-branch'], { cwd: repoDir });

      await gitManager.removeWorktree(worktreePath);

      expect(existsSync(worktreePath)).toBe(false);
    });

    it('should handle non-existent worktree gracefully', async () => {
      await expect(
        gitManager.removeWorktree('/non/existent/path')
      ).resolves.not.toThrow();
    });
  });

  describe('getCurrentBranch', () => {
    it('should return current branch name', async () => {
      // Default branch might be 'master' or 'main' depending on git config
      const branch = await gitManager.getCurrentBranch();
      expect(['main', 'master']).toContain(branch);
    });
  });

  describe('checkout', () => {
    it('should checkout a branch', async () => {
      // Create a branch
      await execa('git', ['branch', 'test-checkout'], { cwd: repoDir });

      await gitManager.checkout('test-checkout');
      const currentBranch = await gitManager.getCurrentBranch();

      expect(currentBranch).toBe('test-checkout');
    });
  });

  describe('getBaseDir', () => {
    it('should return base directory', () => {
      expect(gitManager.getBaseDir()).toBe(repoDir);
    });
  });

  describe('getRawGit', () => {
    it('should return simple-git instance', () => {
      const git = gitManager.getRawGit();
      expect(git).toBeDefined();
      expect(typeof git.status).toBe('function');
    });
  });

  describe('worktree isolation', () => {
    it('should allow independent changes in worktrees', async () => {
      const worktree1 = join(testDir, 'isolated-1');
      const worktree2 = join(testDir, 'isolated-2');

      // Create branches
      await execa('git', ['branch', 'iso-1'], { cwd: repoDir });
      await execa('git', ['branch', 'iso-2'], { cwd: repoDir });

      // Create worktrees
      await execa('git', ['worktree', 'add', worktree1, 'iso-1'], { cwd: repoDir });
      await execa('git', ['worktree', 'add', worktree2, 'iso-2'], { cwd: repoDir });

      // Make changes in worktree1
      await writeFile(join(worktree1, 'file1.txt'), 'content1');
      await execa('git', ['add', 'file1.txt'], { cwd: worktree1 });
      await execa('git', ['commit', '-m', 'Add file1'], { cwd: worktree1 });

      // Make different changes in worktree2
      await writeFile(join(worktree2, 'file2.txt'), 'content2');
      await execa('git', ['add', 'file2.txt'], { cwd: worktree2 });
      await execa('git', ['commit', '-m', 'Add file2'], { cwd: worktree2 });

      // Verify isolation - file1 only in worktree1
      expect(existsSync(join(worktree1, 'file1.txt'))).toBe(true);
      expect(existsSync(join(worktree2, 'file1.txt'))).toBe(false);

      // Verify isolation - file2 only in worktree2
      expect(existsSync(join(worktree2, 'file2.txt'))).toBe(true);
      expect(existsSync(join(worktree1, 'file2.txt'))).toBe(false);
    });
  });
});
