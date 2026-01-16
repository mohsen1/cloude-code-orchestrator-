/**
 * Unit tests for V2 TaskQueue
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TaskQueue, type CreateTaskOptions } from '../../../src/v2/task-queue.js';
import type { TaskResult } from '../../../src/v2/types.js';

describe('TaskQueue', () => {
  let queue: TaskQueue;

  beforeEach(() => {
    queue = new TaskQueue();
  });

  describe('addTask', () => {
    it('should add a task and return it with generated fields', () => {
      const task = queue.addTask({
        title: 'Test Task',
        description: 'A test task description',
      });

      expect(task.id).toBeDefined();
      expect(task.title).toBe('Test Task');
      expect(task.description).toBe('A test task description');
      expect(task.status).toBe('pending');
      expect(task.priority).toBe('normal');
      expect(task.retryCount).toBe(0);
      expect(task.maxRetries).toBe(3);
      expect(task.createdAt).toBeInstanceOf(Date);
    });

    it('should respect custom priority and maxRetries', () => {
      const task = queue.addTask({
        title: 'High Priority Task',
        description: 'Important',
        priority: 'high',
        maxRetries: 5,
      });

      expect(task.priority).toBe('high');
      expect(task.maxRetries).toBe(5);
    });

    it('should include optional fields', () => {
      const task = queue.addTask({
        title: 'Full Task',
        description: 'Complete task',
        requirements: ['Req 1', 'Req 2'],
        filesToModify: ['file1.ts', 'file2.ts'],
        acceptanceCriteria: ['Criterion 1'],
        teamId: 1,
      });

      expect(task.requirements).toEqual(['Req 1', 'Req 2']);
      expect(task.filesToModify).toEqual(['file1.ts', 'file2.ts']);
      expect(task.acceptanceCriteria).toEqual(['Criterion 1']);
      expect(task.teamId).toBe(1);
    });
  });

  describe('addTasks', () => {
    it('should add multiple tasks', () => {
      const tasks = queue.addTasks([
        { title: 'Task 1', description: 'Desc 1' },
        { title: 'Task 2', description: 'Desc 2' },
        { title: 'Task 3', description: 'Desc 3' },
      ]);

      expect(tasks).toHaveLength(3);
      expect(queue.getPendingCount()).toBe(3);
    });
  });

  describe('priority ordering', () => {
    it('should return high priority tasks before normal and low', () => {
      queue.addTask({ title: 'Low Task', description: 'Low', priority: 'low' });
      queue.addTask({ title: 'Normal Task', description: 'Normal', priority: 'normal' });
      queue.addTask({ title: 'High Task', description: 'High', priority: 'high' });

      const first = queue.peekNextTask();
      expect(first?.title).toBe('High Task');
    });

    it('should maintain FIFO within same priority', () => {
      queue.addTask({ title: 'Normal 1', description: 'First normal', priority: 'normal' });
      queue.addTask({ title: 'Normal 2', description: 'Second normal', priority: 'normal' });
      queue.addTask({ title: 'Normal 3', description: 'Third normal', priority: 'normal' });

      const task1 = queue.assignTask(1);
      const task2 = queue.assignTask(2);
      const task3 = queue.assignTask(3);

      expect(task1?.title).toBe('Normal 1');
      expect(task2?.title).toBe('Normal 2');
      expect(task3?.title).toBe('Normal 3');
    });
  });

  describe('assignTask', () => {
    it('should assign task to worker and mark as in_progress', () => {
      queue.addTask({ title: 'Test Task', description: 'Test' });

      const task = queue.assignTask(1);

      expect(task).toBeDefined();
      expect(task?.status).toBe('in_progress');
      expect(task?.assignedWorker).toBe(1);
      expect(task?.startedAt).toBeInstanceOf(Date);
      expect(queue.getPendingCount()).toBe(0);
    });

    it('should return undefined when queue is empty', () => {
      const task = queue.assignTask(1);
      expect(task).toBeUndefined();
    });
  });

  describe('completeTask', () => {
    it('should mark task as completed', () => {
      const added = queue.addTask({ title: 'Test Task', description: 'Test' });
      queue.assignTask(1);

      const result: TaskResult = {
        success: true,
        output: 'Done',
        stderr: '',
        exitCode: 0,
        durationMs: 1000,
      };

      queue.completeTask(added.id, result);

      const task = queue.getTask(added.id);
      expect(task?.status).toBe('completed');
      expect(task?.completedAt).toBeInstanceOf(Date);
      expect(task?.result).toEqual(result);
    });
  });

  describe('failTask', () => {
    it('should re-queue task if retries remain', () => {
      const added = queue.addTask({ title: 'Test Task', description: 'Test', maxRetries: 3 });
      queue.assignTask(1);

      const result: TaskResult = {
        success: false,
        output: '',
        stderr: 'Error',
        exitCode: 1,
        durationMs: 500,
      };

      const willRetry = queue.failTask(added.id, result);

      expect(willRetry).toBe(true);
      expect(queue.getTask(added.id)?.status).toBe('pending');
      expect(queue.getTask(added.id)?.retryCount).toBe(1);
      expect(queue.getPendingCount()).toBe(1);
    });

    it('should mark as failed when no retries remain', () => {
      const added = queue.addTask({ title: 'Test Task', description: 'Test', maxRetries: 1 });
      queue.assignTask(1);

      const result: TaskResult = {
        success: false,
        output: '',
        stderr: 'Error',
        exitCode: 1,
        durationMs: 500,
      };

      // First failure - should retry
      queue.failTask(added.id, result);
      queue.assignTask(1); // Re-assign

      // Second failure - should not retry
      const willRetry = queue.failTask(added.id, result);

      expect(willRetry).toBe(false);
      expect(queue.getTask(added.id)?.status).toBe('failed');
    });

    it('should not retry when rate limited', () => {
      const added = queue.addTask({ title: 'Test Task', description: 'Test', maxRetries: 3 });
      queue.assignTask(1);

      const result: TaskResult = {
        success: false,
        output: '',
        stderr: 'Rate limited',
        exitCode: 1,
        durationMs: 500,
        rateLimited: true,
      };

      const willRetry = queue.failTask(added.id, result);

      expect(willRetry).toBe(false);
      expect(queue.getTask(added.id)?.status).toBe('failed');
    });
  });

  describe('requeueTask', () => {
    it('should re-queue an in-progress task', () => {
      const added = queue.addTask({ title: 'Test Task', description: 'Test' });
      queue.assignTask(1);

      expect(queue.getPendingCount()).toBe(0);

      const success = queue.requeueTask(added.id);

      expect(success).toBe(true);
      expect(queue.getPendingCount()).toBe(1);
      expect(queue.getTask(added.id)?.status).toBe('pending');
    });

    it('should not re-queue a pending task', () => {
      const added = queue.addTask({ title: 'Test Task', description: 'Test' });

      const success = queue.requeueTask(added.id);

      expect(success).toBe(false);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      // Add various tasks
      queue.addTask({ title: 'Pending 1', description: 'P1' });
      queue.addTask({ title: 'Pending 2', description: 'P2' });
      const inProgress = queue.addTask({ title: 'In Progress', description: 'IP' });
      const completed = queue.addTask({ title: 'Completed', description: 'C' });

      // Assign and complete some
      queue.assignTask(1); // Pending 1 -> in_progress
      queue.assignTask(2); // Pending 2 -> in_progress
      queue.assignTask(3); // In Progress -> in_progress
      queue.assignTask(4); // Completed -> in_progress

      queue.completeTask(completed.id, {
        success: true,
        output: 'Done',
        stderr: '',
        exitCode: 0,
        durationMs: 100,
      });

      const stats = queue.getStats();

      expect(stats.total).toBe(4);
      expect(stats.pending).toBe(0);
      expect(stats.inProgress).toBe(3);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(0);
    });
  });

  describe('isEmpty', () => {
    it('should return true when no pending tasks', () => {
      expect(queue.isEmpty()).toBe(true);

      queue.addTask({ title: 'Task', description: 'Test' });
      expect(queue.isEmpty()).toBe(false);

      queue.assignTask(1);
      expect(queue.isEmpty()).toBe(true);
    });
  });

  describe('isComplete', () => {
    it('should return true when all tasks are completed or failed', () => {
      const task1 = queue.addTask({ title: 'Task 1', description: 'T1' });
      const task2 = queue.addTask({ title: 'Task 2', description: 'T2', maxRetries: 0 });

      queue.assignTask(1);
      queue.assignTask(2);

      // Not complete yet
      expect(queue.isComplete()).toBe(false);

      // Complete one
      queue.completeTask(task1.id, {
        success: true,
        output: '',
        stderr: '',
        exitCode: 0,
        durationMs: 100,
      });

      // Still not complete
      expect(queue.isComplete()).toBe(false);

      // Fail the other
      queue.failTask(task2.id, {
        success: false,
        output: '',
        stderr: 'Error',
        exitCode: 1,
        durationMs: 100,
      });

      // Now complete
      expect(queue.isComplete()).toBe(true);
    });
  });

  describe('clear', () => {
    it('should remove all tasks', () => {
      queue.addTask({ title: 'Task 1', description: 'T1' });
      queue.addTask({ title: 'Task 2', description: 'T2' });

      queue.clear();

      expect(queue.getAllTasks()).toHaveLength(0);
      expect(queue.getPendingCount()).toBe(0);
    });
  });

  describe('removeTask', () => {
    it('should remove a specific task', () => {
      const task1 = queue.addTask({ title: 'Task 1', description: 'T1' });
      queue.addTask({ title: 'Task 2', description: 'T2' });

      const removed = queue.removeTask(task1.id);

      expect(removed).toBe(true);
      expect(queue.getAllTasks()).toHaveLength(1);
      expect(queue.getTask(task1.id)).toBeUndefined();
    });

    it('should return false for non-existent task', () => {
      const removed = queue.removeTask('non-existent-id');
      expect(removed).toBe(false);
    });
  });

  describe('getTasksByStatus', () => {
    it('should filter tasks by status', () => {
      queue.addTask({ title: 'Task A', description: 'A' });
      queue.addTask({ title: 'Task B', description: 'B' });
      queue.assignTask(1); // Makes first task (Task A) in_progress

      const pending = queue.getTasksByStatus('pending');
      const inProgress = queue.getTasksByStatus('in_progress');

      expect(pending).toHaveLength(1);
      expect(pending[0].title).toBe('Task B'); // Task B is still pending
      expect(inProgress).toHaveLength(1);
      expect(inProgress[0].title).toBe('Task A'); // Task A was assigned
    });
  });

  describe('getTasksByWorker', () => {
    it('should filter tasks by assigned worker', () => {
      queue.addTask({ title: 'Task 1', description: 'T1' });
      queue.addTask({ title: 'Task 2', description: 'T2' });
      queue.addTask({ title: 'Task 3', description: 'T3' });

      queue.assignTask(1);
      queue.assignTask(2);
      queue.assignTask(1); // Second task for worker 1

      const worker1Tasks = queue.getTasksByWorker(1);
      const worker2Tasks = queue.getTasksByWorker(2);

      expect(worker1Tasks).toHaveLength(2);
      expect(worker2Tasks).toHaveLength(1);
    });
  });
});
