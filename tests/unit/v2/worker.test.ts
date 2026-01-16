/**
 * Unit tests for V2 Worker
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerExecutor, buildWorkerPrompt, buildMergePrompt, buildConflictResolutionPrompt } from '../../../src/v2/worker.js';
import type { AuthConfig } from '../../../src/v2/types.js';

// Mock execa
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';

const mockExeca = vi.mocked(execa);

describe('WorkerExecutor', () => {
  let worker: WorkerExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new WorkerExecutor({
      id: 1,
      worktreePath: '/test/workspace/worker-1',
      model: 'sonnet',
      timeoutMs: 60000,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('runTask', () => {
    it('should execute claude with --print and return success result', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: 'Task completed successfully',
        stderr: '',
        exitCode: 0,
      } as never);

      const result = await worker.runTask('Complete the task');

      expect(result.success).toBe(true);
      expect(result.output).toBe('Task completed successfully');
      expect(result.exitCode).toBe(0);
      expect(result.rateLimited).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      expect(mockExeca).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['--print', '--dangerously-skip-permissions', '--model', 'sonnet']),
        expect.objectContaining({
          cwd: '/test/workspace/worker-1',
          timeout: 60000,
        })
      );
    });

    it('should return failure result when exit code is non-zero', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: 'Partial output',
        stderr: 'Error occurred',
        exitCode: 1,
      } as never);

      const result = await worker.runTask('Complete the task');

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('Error occurred');
    });

    it('should detect rate limiting from stderr', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: '',
        stderr: 'Error: rate limit exceeded',
        exitCode: 1,
      } as never);

      const result = await worker.runTask('Complete the task');

      expect(result.success).toBe(false);
      expect(result.rateLimited).toBe(true);
    });

    it('should detect rate limiting with 429 status', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: '',
        stderr: 'HTTP 429 Too Many Requests',
        exitCode: 1,
      } as never);

      const result = await worker.runTask('Complete the task');

      expect(result.rateLimited).toBe(true);
    });

    it('should handle timeout errors', async () => {
      const timeoutError = new Error('Command timed out');
      (timeoutError as Error & { timedOut?: boolean }).timedOut = true;
      mockExeca.mockRejectedValueOnce(timeoutError);

      const result = await worker.runTask('Complete the task');

      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
    });

    it('should handle general errors', async () => {
      mockExeca.mockRejectedValueOnce(new Error('Process failed'));

      const result = await worker.runTask('Complete the task');

      expect(result.success).toBe(false);
      expect(result.stderr).toContain('Process failed');
    });
  });

  describe('setAuthConfig', () => {
    it('should update auth config', async () => {
      const authConfig: AuthConfig = {
        name: 'test-key',
        apiKey: 'sk-test-123',
      };

      worker.setAuthConfig(authConfig);

      mockExeca.mockResolvedValueOnce({
        stdout: 'Done',
        stderr: '',
        exitCode: 0,
      } as never);

      await worker.runTask('Test');

      expect(mockExeca).toHaveBeenCalledWith(
        'claude',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            ANTHROPIC_API_KEY: 'sk-test-123',
          }),
        })
      );
    });
  });

  describe('getId', () => {
    it('should return worker id', () => {
      expect(worker.getId()).toBe(1);
    });
  });

  describe('getWorktreePath', () => {
    it('should return worktree path', () => {
      expect(worker.getWorktreePath()).toBe('/test/workspace/worker-1');
    });
  });
});

describe('Prompt Builders', () => {
  describe('buildWorkerPrompt', () => {
    it('should build a proper worker prompt', () => {
      const prompt = buildWorkerPrompt(1, 'WORKER_1_TASK.md');

      expect(prompt).toContain('Worker 1');
      expect(prompt).toContain('WORKER_1_TASK.md');
      expect(prompt).toContain('Read your task from');
      expect(prompt).toContain('Begin working');
    });
  });

  describe('buildMergePrompt', () => {
    it('should build a merge prompt without diff summary', () => {
      const prompt = buildMergePrompt('worker-1', 'main');

      expect(prompt).toContain('worker-1');
      expect(prompt).toContain('main');
      expect(prompt).toContain('git merge');
    });

    it('should include diff summary when provided', () => {
      const prompt = buildMergePrompt('worker-1', 'main', '3 files changed, 10 insertions');

      expect(prompt).toContain('Changes to Review');
      expect(prompt).toContain('3 files changed');
    });
  });

  describe('buildConflictResolutionPrompt', () => {
    it('should build conflict resolution prompt with file list', () => {
      const prompt = buildConflictResolutionPrompt(['src/file1.ts', 'src/file2.ts']);

      expect(prompt).toContain('src/file1.ts');
      expect(prompt).toContain('src/file2.ts');
      expect(prompt).toContain('Conflicted Files');
      expect(prompt).toContain('conflict markers');
    });
  });
});
