/**
 * TaskQueue - Thread-safe task management for the orchestrator
 *
 * Features:
 * - Priority-based ordering (high > normal > low)
 * - FIFO within same priority
 * - Thread-safe operations
 * - Retry support with configurable limits
 */

import { logger } from '../utils/logger.js';
import type { Task, TaskStatus, TaskPriority, TaskResult } from './types.js';
import { randomUUID } from 'crypto';

/** Priority weights for sorting */
const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

/** Task creation options */
export interface CreateTaskOptions {
  title: string;
  description: string;
  requirements?: string[];
  filesToModify?: string[];
  acceptanceCriteria?: string[];
  priority?: TaskPriority;
  teamId?: number;
  maxRetries?: number;
}

/**
 * TaskQueue manages the lifecycle of tasks
 */
export class TaskQueue {
  private tasks: Map<string, Task> = new Map();
  private pendingQueue: string[] = []; // Task IDs in priority order

  constructor() {
    logger.debug('TaskQueue initialized');
  }

  /**
   * Create and add a new task to the queue
   */
  addTask(options: CreateTaskOptions): Task {
    const task: Task = {
      id: randomUUID(),
      title: options.title,
      description: options.description,
      requirements: options.requirements,
      filesToModify: options.filesToModify,
      acceptanceCriteria: options.acceptanceCriteria,
      priority: options.priority ?? 'normal',
      status: 'pending',
      teamId: options.teamId,
      createdAt: new Date(),
      retryCount: 0,
      maxRetries: options.maxRetries ?? 3,
    };

    this.tasks.set(task.id, task);
    this.insertByPriority(task.id, task.priority);

    logger.info('Task added to queue', {
      taskId: task.id,
      title: task.title,
      priority: task.priority,
      queueSize: this.pendingQueue.length,
    });

    return task;
  }

  /**
   * Add multiple tasks at once
   */
  addTasks(taskOptions: CreateTaskOptions[]): Task[] {
    return taskOptions.map((options) => this.addTask(options));
  }

  /**
   * Get the next pending task (FIFO within priority)
   * Does NOT remove from queue - use assignTask for that
   */
  peekNextTask(): Task | undefined {
    const taskId = this.pendingQueue[0];
    return taskId ? this.tasks.get(taskId) : undefined;
  }

  /**
   * Assign the next pending task to a worker
   * Removes from pending queue and marks as in_progress
   */
  assignTask(workerId: number): Task | undefined {
    const taskId = this.pendingQueue.shift();
    if (!taskId) return undefined;

    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    task.status = 'in_progress';
    task.assignedWorker = workerId;
    task.startedAt = new Date();

    logger.info('Task assigned to worker', {
      taskId: task.id,
      title: task.title,
      workerId,
    });

    return task;
  }

  /**
   * Mark a task as completed
   */
  completeTask(taskId: string, result: TaskResult): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      logger.warn('Attempted to complete unknown task', { taskId });
      return;
    }

    task.status = 'completed';
    task.completedAt = new Date();
    task.result = result;

    logger.info('Task completed', {
      taskId,
      title: task.title,
      workerId: task.assignedWorker,
      durationMs: result.durationMs,
      success: result.success,
    });
  }

  /**
   * Mark a task as failed
   * If retries remain, re-queues the task
   */
  failTask(taskId: string, result: TaskResult): boolean {
    const task = this.tasks.get(taskId);
    if (!task) {
      logger.warn('Attempted to fail unknown task', { taskId });
      return false;
    }

    task.retryCount++;
    task.result = result;

    if (task.retryCount < task.maxRetries && !result.rateLimited) {
      // Re-queue for retry
      task.status = 'pending';
      task.assignedWorker = undefined;
      task.startedAt = undefined;
      this.insertByPriority(taskId, task.priority);

      logger.info('Task re-queued for retry', {
        taskId,
        title: task.title,
        retryCount: task.retryCount,
        maxRetries: task.maxRetries,
      });

      return true; // Will retry
    }

    // No more retries
    task.status = 'failed';
    task.completedAt = new Date();

    logger.error('Task failed permanently', {
      taskId,
      title: task.title,
      retryCount: task.retryCount,
      rateLimited: result.rateLimited,
    });

    return false; // Won't retry
  }

  /**
   * Re-queue a task (e.g., after worker rate limiting)
   */
  requeueTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.status !== 'in_progress') {
      logger.warn('Cannot requeue task not in progress', { taskId, status: task.status });
      return false;
    }

    task.status = 'pending';
    task.assignedWorker = undefined;
    task.startedAt = undefined;
    // Insert at high priority to pick up quickly
    this.insertByPriority(taskId, 'high');

    logger.info('Task re-queued', { taskId, title: task.title });
    return true;
  }

  /**
   * Get a task by ID
   */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks
   */
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get tasks by status
   */
  getTasksByStatus(status: TaskStatus): Task[] {
    return this.getAllTasks().filter((t) => t.status === status);
  }

  /**
   * Get tasks by worker
   */
  getTasksByWorker(workerId: number): Task[] {
    return this.getAllTasks().filter((t) => t.assignedWorker === workerId);
  }

  /**
   * Get queue statistics
   */
  getStats(): {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
  } {
    const tasks = this.getAllTasks();
    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === 'pending').length,
      inProgress: tasks.filter((t) => t.status === 'in_progress').length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
    };
  }

  /**
   * Check if queue is empty (no pending tasks)
   */
  isEmpty(): boolean {
    return this.pendingQueue.length === 0;
  }

  /**
   * Check if all tasks are complete (none pending or in_progress)
   */
  isComplete(): boolean {
    return this.getAllTasks().every(
      (t) => t.status === 'completed' || t.status === 'failed'
    );
  }

  /**
   * Get pending queue size
   */
  getPendingCount(): number {
    return this.pendingQueue.length;
  }

  /**
   * Clear all tasks (for testing or reset)
   */
  clear(): void {
    this.tasks.clear();
    this.pendingQueue = [];
    logger.debug('TaskQueue cleared');
  }

  /**
   * Insert task ID into pending queue by priority
   */
  private insertByPriority(taskId: string, priority: TaskPriority): void {
    const weight = PRIORITY_WEIGHT[priority];

    // Find insertion point
    let insertIndex = this.pendingQueue.length;
    for (let i = 0; i < this.pendingQueue.length; i++) {
      const existingTask = this.tasks.get(this.pendingQueue[i]);
      if (existingTask && PRIORITY_WEIGHT[existingTask.priority] > weight) {
        insertIndex = i;
        break;
      }
    }

    this.pendingQueue.splice(insertIndex, 0, taskId);
  }

  /**
   * Remove a task from the queue entirely
   */
  removeTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    this.tasks.delete(taskId);
    const queueIndex = this.pendingQueue.indexOf(taskId);
    if (queueIndex >= 0) {
      this.pendingQueue.splice(queueIndex, 1);
    }

    logger.debug('Task removed', { taskId, title: task.title });
    return true;
  }
}
