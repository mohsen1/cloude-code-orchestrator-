/**
 * Integration tests for V2 Orchestrator Setup
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execa } from 'execa';
import { V2Orchestrator } from '../../../src/v2/orchestrator.js';
import type { V2OrchestratorConfig } from '../../../src/v2/types.js';

describe('V2 Orchestrator Setup', () => {
  let testDir: string;
  let workspaceDir: string;
  let repoDir: string;

  beforeEach(async () => {
    // Create test directories
    testDir = join(tmpdir(), `v2-orchestrator-test-${Date.now()}`);
    workspaceDir = join(testDir, 'workspace');
    repoDir = join(testDir, 'repo');

    await mkdir(testDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(repoDir, { recursive: true });

    // Initialize a test git repository
    await execa('git', ['init'], { cwd: repoDir });
    await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir });
    await execa('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });

    // Create initial commit
    await writeFile(join(repoDir, 'README.md'), '# Test Repo\n');
    await execa('git', ['add', '.'], { cwd: repoDir });
    await execa('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('Configuration', () => {
    it('should create orchestrator with config', () => {
      const config: V2OrchestratorConfig = {
        repositoryUrl: repoDir,
        branch: 'main',
        workerCount: 2,
        workspaceDir,
        authMode: 'oauth',
        engineerManagerGroupSize: 4,
        taskTimeoutMs: 60000,
        pollIntervalMs: 1000,
        maxToolUsesPerInstance: 100,
        maxTotalToolUses: 500,
        maxRunDurationMinutes: 60,
      };

      const orchestrator = new V2Orchestrator(config);
      const status = orchestrator.getStatus();

      expect(status.mode).toBe('flat'); // 2 workers <= 4 group size
      expect(status.isRunning).toBe(false);
      expect(status.workers).toHaveLength(0); // Not initialized yet
    });

    it('should detect hierarchy mode with many workers', () => {
      const config: V2OrchestratorConfig = {
        repositoryUrl: repoDir,
        branch: 'main',
        workerCount: 10,
        workspaceDir,
        authMode: 'oauth',
        engineerManagerGroupSize: 4,
        taskTimeoutMs: 60000,
        pollIntervalMs: 1000,
        maxToolUsesPerInstance: 100,
        maxTotalToolUses: 500,
        maxRunDurationMinutes: 60,
      };

      const orchestrator = new V2Orchestrator(config);
      const status = orchestrator.getStatus();

      expect(status.mode).toBe('hierarchy'); // 10 workers > 4 group size
    });
  });

  describe('Task Management', () => {
    it('should add tasks to queue', () => {
      const config: V2OrchestratorConfig = {
        repositoryUrl: repoDir,
        branch: 'main',
        workerCount: 2,
        workspaceDir,
        authMode: 'oauth',
        engineerManagerGroupSize: 4,
        taskTimeoutMs: 60000,
        pollIntervalMs: 1000,
        maxToolUsesPerInstance: 100,
        maxTotalToolUses: 500,
        maxRunDurationMinutes: 60,
      };

      const orchestrator = new V2Orchestrator(config);

      const tasks = orchestrator.addTasks([
        { title: 'Task 1', description: 'First task' },
        { title: 'Task 2', description: 'Second task' },
      ]);

      expect(tasks).toHaveLength(2);
      expect(tasks[0].title).toBe('Task 1');
      expect(tasks[1].title).toBe('Task 2');

      const status = orchestrator.getStatus();
      expect(status.totalTasks).toBe(2);
      expect(status.pendingTasks).toBe(2);
    });

    it('should add single task', () => {
      const config: V2OrchestratorConfig = {
        repositoryUrl: repoDir,
        branch: 'main',
        workerCount: 2,
        workspaceDir,
        authMode: 'oauth',
        engineerManagerGroupSize: 4,
        taskTimeoutMs: 60000,
        pollIntervalMs: 1000,
        maxToolUsesPerInstance: 100,
        maxTotalToolUses: 500,
        maxRunDurationMinutes: 60,
      };

      const orchestrator = new V2Orchestrator(config);

      const task = orchestrator.addTask({
        title: 'Single Task',
        description: 'A single task',
        priority: 'high',
      });

      expect(task.title).toBe('Single Task');
      expect(task.priority).toBe('high');
    });
  });

  describe('Auth Configuration', () => {
    it('should accept auth configs', () => {
      const config: V2OrchestratorConfig = {
        repositoryUrl: repoDir,
        branch: 'main',
        workerCount: 2,
        workspaceDir,
        authMode: 'api-keys-first',
        engineerManagerGroupSize: 4,
        taskTimeoutMs: 60000,
        pollIntervalMs: 1000,
        maxToolUsesPerInstance: 100,
        maxTotalToolUses: 500,
        maxRunDurationMinutes: 60,
      };

      const authConfigs = [
        { name: 'key-1', apiKey: 'sk-test-1' },
        { name: 'key-2', apiKey: 'sk-test-2' },
      ];

      // Should not throw
      const orchestrator = new V2Orchestrator(config, authConfigs);
      expect(orchestrator).toBeDefined();
    });
  });
});
