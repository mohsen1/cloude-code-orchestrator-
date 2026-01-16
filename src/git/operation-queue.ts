import { logger } from '../utils/logger.js';

export interface QueuedGitOperation<T = unknown> {
  id: string;
  workDir: string;
  operation: () => Promise<T>;
  priority: 'high' | 'normal' | 'low';
  createdAt: number;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export interface GitQueueStats {
  pending: number;
  processing: boolean;
  totalProcessed: number;
  totalFailed: number;
  avgWaitMs: number;
  avgProcessMs: number;
}

/**
 * Serializes git operations to prevent lock contention when using worktrees.
 * 
 * Git worktrees share the .git directory, so concurrent git operations
 * can fail with "index.lock" errors. This queue ensures only one git
 * operation runs at a time across all worktrees.
 */
export class GitOperationQueue {
  private queue: QueuedGitOperation[] = [];
  private processing = false;
  private operationId = 0;
  private stats = {
    totalProcessed: 0,
    totalFailed: 0,
    totalWaitMs: 0,
    totalProcessMs: 0,
  };

  private readonly maxQueueSize: number;
  private readonly operationTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;

  constructor(options: {
    maxQueueSize?: number;
    operationTimeoutMs?: number;
    retryDelayMs?: number;
    maxRetries?: number;
  } = {}) {
    this.maxQueueSize = options.maxQueueSize ?? 100;
    this.operationTimeoutMs = options.operationTimeoutMs ?? 30000;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.maxRetries = options.maxRetries ?? 3;
  }

  /**
   * Queue a git operation for execution.
   * Returns a promise that resolves when the operation completes.
   */
  async enqueue<T>(
    workDir: string,
    operation: () => Promise<T>,
    options: { priority?: 'high' | 'normal' | 'low'; label?: string } = {}
  ): Promise<T> {
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error(`Git operation queue full (max ${this.maxQueueSize})`);
    }

    const id = `git-op-${++this.operationId}`;
    const priority = options.priority ?? 'normal';

    return new Promise<T>((resolve, reject) => {
      const queuedOp: QueuedGitOperation<T> = {
        id,
        workDir,
        operation,
        priority,
        createdAt: Date.now(),
        resolve: resolve as (value: unknown) => void,
        reject,
      };

      // Insert based on priority
      if (priority === 'high') {
        // Find first non-high priority item
        const insertIndex = this.queue.findIndex(op => op.priority !== 'high');
        if (insertIndex === -1) {
          this.queue.push(queuedOp as QueuedGitOperation);
        } else {
          this.queue.splice(insertIndex, 0, queuedOp as QueuedGitOperation);
        }
      } else if (priority === 'low') {
        this.queue.push(queuedOp as QueuedGitOperation);
      } else {
        // Normal priority: insert after high, before low
        const insertIndex = this.queue.findIndex(op => op.priority === 'low');
        if (insertIndex === -1) {
          this.queue.push(queuedOp as QueuedGitOperation);
        } else {
          this.queue.splice(insertIndex, 0, queuedOp as QueuedGitOperation);
        }
      }

      logger.debug('Git operation queued', {
        id,
        workDir,
        priority,
        label: options.label,
        queueLength: this.queue.length,
      });

      this.processQueue();
    });
  }

  /**
   * Process the queue serially.
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const op = this.queue.shift()!;
      const waitMs = Date.now() - op.createdAt;

      logger.debug('Processing git operation', {
        id: op.id,
        workDir: op.workDir,
        waitMs,
        remainingQueue: this.queue.length,
      });

      const startTime = Date.now();
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        try {
          const result = await this.executeWithTimeout(op.operation);
          const processMs = Date.now() - startTime;

          this.stats.totalProcessed++;
          this.stats.totalWaitMs += waitMs;
          this.stats.totalProcessMs += processMs;

          logger.debug('Git operation completed', {
            id: op.id,
            attempt,
            processMs,
          });

          op.resolve(result);
          lastError = null;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));

          if (attempt < this.maxRetries && this.isRetryableError(lastError)) {
            logger.warn('Git operation failed, retrying', {
              id: op.id,
              attempt,
              maxRetries: this.maxRetries,
              error: lastError.message,
            });
            await this.delay(this.retryDelayMs * attempt);
          }
        }
      }

      if (lastError) {
        this.stats.totalFailed++;
        logger.error('Git operation failed permanently', {
          id: op.id,
          error: lastError.message,
        });
        op.reject(lastError);
      }

      // Small delay between operations to let git release resources
      await this.delay(50);
    }

    this.processing = false;
  }

  private async executeWithTimeout<T>(operation: () => Promise<T>): Promise<T> {
    return Promise.race([
      operation(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Git operation timed out')),
          this.operationTimeoutMs
        )
      ),
    ]);
  }

  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('index.lock') ||
      message.includes('another git process') ||
      message.includes('unable to create') ||
      message.includes('file exists') ||
      message.includes('could not write') ||
      message.includes('timed out')
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get queue statistics.
   */
  getStats(): GitQueueStats {
    const processed = this.stats.totalProcessed || 1;
    return {
      pending: this.queue.length,
      processing: this.processing,
      totalProcessed: this.stats.totalProcessed,
      totalFailed: this.stats.totalFailed,
      avgWaitMs: Math.round(this.stats.totalWaitMs / processed),
      avgProcessMs: Math.round(this.stats.totalProcessMs / processed),
    };
  }

  /**
   * Clear pending operations (doesn't affect currently running operation).
   */
  clear(): void {
    const cleared = this.queue.length;
    for (const op of this.queue) {
      op.reject(new Error('Git operation queue cleared'));
    }
    this.queue = [];
    logger.info('Git operation queue cleared', { cleared });
  }

  /**
   * Get current queue length.
   */
  get length(): number {
    return this.queue.length;
  }
}

// Singleton instance for the orchestrator
let globalQueue: GitOperationQueue | null = null;

export function getGitQueue(options?: ConstructorParameters<typeof GitOperationQueue>[0]): GitOperationQueue {
  if (!globalQueue) {
    globalQueue = new GitOperationQueue(options);
  }
  return globalQueue;
}

export function resetGitQueue(): void {
  if (globalQueue) {
    globalQueue.clear();
    globalQueue = null;
  }
}
