/**
 * Unit tests for V2 TaskFile
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getTaskFileName,
  getEmTaskFileName,
  DIRECTOR_TASK_FILE,
  MANAGER_TASK_FILE,
  generateWorkerTaskContent,
  generateEmTaskContent,
  generateDirectorTaskContent,
  generateManagerTaskContent,
  writeTaskFile,
  readTaskFile,
  deleteTaskFile,
} from '../../../src/v2/task-file.js';
import type { Task, Team } from '../../../src/v2/types.js';

describe('Task File Names', () => {
  describe('getTaskFileName', () => {
    it('should generate correct worker task file name', () => {
      expect(getTaskFileName(1)).toBe('WORKER_1_TASK.md');
      expect(getTaskFileName(10)).toBe('WORKER_10_TASK.md');
    });
  });

  describe('getEmTaskFileName', () => {
    it('should generate correct EM task file name', () => {
      expect(getEmTaskFileName(1)).toBe('EM_1_TASK.md');
      expect(getEmTaskFileName(3)).toBe('EM_3_TASK.md');
    });
  });

  describe('Constants', () => {
    it('should have correct constant values', () => {
      expect(DIRECTOR_TASK_FILE).toBe('DIRECTOR_TASK.md');
      expect(MANAGER_TASK_FILE).toBe('MANAGER_TASK.md');
    });
  });
});

describe('Content Generation', () => {
  const mockTask: Task = {
    id: 'task-123',
    title: 'Implement Login Feature',
    description: 'Create a login form with email and password fields',
    requirements: ['Use bcrypt for password hashing', 'Add CSRF protection'],
    filesToModify: ['src/auth/login.ts', 'src/components/LoginForm.tsx'],
    acceptanceCriteria: ['Users can log in', 'Invalid credentials show error'],
    priority: 'high',
    status: 'pending',
    createdAt: new Date(),
    retryCount: 0,
    maxRetries: 3,
  };

  describe('generateWorkerTaskContent', () => {
    it('should generate valid markdown content', () => {
      const content = generateWorkerTaskContent(mockTask, 1, {
        branchName: 'worker-1',
        baseBranch: 'main',
        mode: 'flat',
      });

      expect(content).toContain('# Worker 1 Task');
      expect(content).toContain('Implement Login Feature');
      expect(content).toContain('Create a login form');
      expect(content).toContain('Use bcrypt for password hashing');
      expect(content).toContain('src/auth/login.ts');
      expect(content).toContain('Users can log in');
      expect(content).toContain('worker-1');
      expect(content).toContain('main');
      expect(content).toContain('task-123');
      expect(content).toContain('high');
    });

    it('should include team info in hierarchy mode', () => {
      const content = generateWorkerTaskContent(mockTask, 1, {
        branchName: 'worker-1',
        baseBranch: 'main',
        mode: 'hierarchy',
        teamInfo: 'em-team-1',
      });

      expect(content).toContain('em-team-1');
      expect(content).toContain('hierarchy');
    });

    it('should handle task without optional fields', () => {
      const minimalTask: Task = {
        id: 'task-456',
        title: 'Simple Task',
        description: 'A simple task',
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
        retryCount: 0,
        maxRetries: 3,
      };

      const content = generateWorkerTaskContent(minimalTask, 1, {
        branchName: 'worker-1',
        baseBranch: 'main',
        mode: 'flat',
      });

      expect(content).toContain('Simple Task');
      expect(content).toContain('Complete the task as described');
      expect(content).toContain('Determine which files');
    });
  });

  describe('generateEmTaskContent', () => {
    it('should generate EM task content with worker branches', () => {
      const content = generateEmTaskContent(
        1,
        ['worker-1', 'worker-2', 'worker-3'],
        'em-team-1'
      );

      expect(content).toContain('Engineering Manager 1');
      expect(content).toContain('worker-1');
      expect(content).toContain('worker-2');
      expect(content).toContain('worker-3');
      expect(content).toContain('em-team-1');
      expect(content).toContain('git merge');
      expect(content).toContain('Quality Checklist');
    });
  });

  describe('generateDirectorTaskContent', () => {
    it('should generate director task content with teams', () => {
      const teams: Team[] = [
        { id: 1, emId: 1, workerIds: [1, 2], branchName: 'em-team-1', worktreePath: '' },
        { id: 2, emId: 2, workerIds: [3, 4], branchName: 'em-team-2', worktreePath: '' },
      ];

      const content = generateDirectorTaskContent(teams, 'main');

      expect(content).toContain('Director Task');
      expect(content).toContain('Team 1');
      expect(content).toContain('Team 2');
      expect(content).toContain('em-team-1');
      expect(content).toContain('em-team-2');
      expect(content).toContain('main');
      expect(content).toContain('Cross-Team Coordination');
    });
  });

  describe('generateManagerTaskContent', () => {
    it('should generate manager task content for flat mode', () => {
      const content = generateManagerTaskContent(
        ['worker-1', 'worker-2', 'worker-3'],
        'main'
      );

      expect(content).toContain('Manager Task');
      expect(content).toContain('flat mode');
      expect(content).toContain('worker-1');
      expect(content).toContain('worker-2');
      expect(content).toContain('worker-3');
      expect(content).toContain('main');
      expect(content).toContain('git merge');
    });
  });
});

describe('File Operations', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `task-file-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('writeTaskFile', () => {
    it('should write task file to worktree', async () => {
      const content = '# Test Task\n\nThis is a test.';
      const filePath = await writeTaskFile(testDir, 'WORKER_1_TASK.md', content);

      expect(filePath).toBe(join(testDir, 'WORKER_1_TASK.md'));

      const written = await readFile(filePath, 'utf-8');
      expect(written).toBe(content);
    });
  });

  describe('readTaskFile', () => {
    it('should read existing task file', async () => {
      const content = '# Test Task Content';
      await writeTaskFile(testDir, 'WORKER_1_TASK.md', content);

      const read = await readTaskFile(testDir, 'WORKER_1_TASK.md');

      expect(read).toBe(content);
    });

    it('should return null for non-existent file', async () => {
      const read = await readTaskFile(testDir, 'NON_EXISTENT.md');

      expect(read).toBeNull();
    });
  });

  describe('deleteTaskFile', () => {
    it('should delete existing task file', async () => {
      await writeTaskFile(testDir, 'WORKER_1_TASK.md', 'content');

      const deleted = await deleteTaskFile(testDir, 'WORKER_1_TASK.md');

      expect(deleted).toBe(true);

      const read = await readTaskFile(testDir, 'WORKER_1_TASK.md');
      expect(read).toBeNull();
    });

    it('should return false for non-existent file', async () => {
      const deleted = await deleteTaskFile(testDir, 'NON_EXISTENT.md');

      expect(deleted).toBe(false);
    });
  });
});
