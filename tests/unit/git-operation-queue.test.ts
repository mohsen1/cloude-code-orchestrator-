import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitOperationQueue, getGitQueue, resetGitQueue } from '../../src/git/operation-queue.js';

describe('GitOperationQueue', () => {
  beforeEach(() => {
    resetGitQueue();
  });

  describe('enqueue', () => {
    it('should execute operations serially', async () => {
      const queue = new GitOperationQueue();
      const executionOrder: number[] = [];

      const op1 = queue.enqueue('/repo', async () => {
        await new Promise(r => setTimeout(r, 50));
        executionOrder.push(1);
        return 'result1';
      });

      const op2 = queue.enqueue('/repo', async () => {
        executionOrder.push(2);
        return 'result2';
      });

      const op3 = queue.enqueue('/repo', async () => {
        executionOrder.push(3);
        return 'result3';
      });

      const results = await Promise.all([op1, op2, op3]);

      expect(results).toEqual(['result1', 'result2', 'result3']);
      expect(executionOrder).toEqual([1, 2, 3]);
    });

    it('should respect priority ordering', async () => {
      const queue = new GitOperationQueue();
      const executionOrder: string[] = [];

      // Pause processing initially by queueing a slow operation
      const blocker = queue.enqueue('/repo', async () => {
        await new Promise(r => setTimeout(r, 100));
        executionOrder.push('blocker');
      });

      // Queue operations with different priorities
      const low = queue.enqueue('/repo', async () => {
        executionOrder.push('low');
      }, { priority: 'low' });

      const normal = queue.enqueue('/repo', async () => {
        executionOrder.push('normal');
      }, { priority: 'normal' });

      const high = queue.enqueue('/repo', async () => {
        executionOrder.push('high');
      }, { priority: 'high' });

      await Promise.all([blocker, high, normal, low]);

      // High priority should execute before normal, normal before low
      expect(executionOrder).toEqual(['blocker', 'high', 'normal', 'low']);
    });

    it('should retry on lock-related errors', async () => {
      const queue = new GitOperationQueue({ retryDelayMs: 10, maxRetries: 3 });
      let attempts = 0;

      const result = await queue.enqueue('/repo', async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Unable to create index.lock: File exists');
        }
        return 'success';
      });

      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    it('should fail after max retries', async () => {
      const queue = new GitOperationQueue({ retryDelayMs: 10, maxRetries: 2 });

      await expect(
        queue.enqueue('/repo', async () => {
          throw new Error('Another git process seems to be running');
        })
      ).rejects.toThrow('Another git process');
    });

    it('should reject if queue is full', async () => {
      const queue = new GitOperationQueue({ maxQueueSize: 2 });

      // Start a slow operation that will be processing
      const p1 = queue.enqueue('/repo', () => new Promise(r => setTimeout(r, 500)));
      
      // Wait for p1 to start processing (removed from queue)
      await new Promise(r => setTimeout(r, 10));
      
      // Queue two more operations (fills the queue)
      const p2 = queue.enqueue('/repo', () => new Promise(r => setTimeout(r, 500)));
      const p3 = queue.enqueue('/repo', () => new Promise(r => setTimeout(r, 500)));

      // This should overflow
      await expect(
        queue.enqueue('/repo', async () => 'overflow')
      ).rejects.toThrow('Git operation queue full');
      
      // Clean up - catch rejections to avoid unhandled promise warnings
      queue.clear();
      await Promise.allSettled([p1, p2, p3]);
    });
  });

  describe('getStats', () => {
    it('should track statistics', async () => {
      const queue = new GitOperationQueue();

      await queue.enqueue('/repo', async () => 'ok');
      await queue.enqueue('/repo', async () => 'ok');

      // Wait for async processing to complete
      await new Promise(r => setTimeout(r, 100));

      const stats = queue.getStats();
      expect(stats.totalProcessed).toBe(2);
      expect(stats.totalFailed).toBe(0);
      expect(stats.pending).toBe(0);
    });
  });

  describe('clear', () => {
    it('should reject pending operations', async () => {
      const queue = new GitOperationQueue();

      // Start a slow operation
      const slow = queue.enqueue('/repo', () => new Promise(r => setTimeout(r, 500)));
      
      // Queue more operations
      const pending = queue.enqueue('/repo', async () => 'pending');

      // Clear the queue
      queue.clear();

      // Pending should be rejected - use allSettled to catch the rejection
      const [slowResult, pendingResult] = await Promise.allSettled([slow, pending]);
      
      expect(slowResult.status).toBe('fulfilled');
      expect(pendingResult.status).toBe('rejected');
      if (pendingResult.status === 'rejected') {
        expect(pendingResult.reason.message).toContain('queue cleared');
      }
    });
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      const q1 = getGitQueue();
      const q2 = getGitQueue();
      expect(q1).toBe(q2);
    });

    it('should reset singleton', () => {
      const q1 = getGitQueue();
      resetGitQueue();
      const q2 = getGitQueue();
      expect(q1).not.toBe(q2);
    });
  });
});
