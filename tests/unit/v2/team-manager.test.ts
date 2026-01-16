/**
 * Unit tests for V2 TeamManager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TeamManager } from '../../../src/v2/team-manager.js';

describe('TeamManager', () => {
  describe('Mode Detection', () => {
    it('should use flat mode when workerCount <= engineerManagerGroupSize', () => {
      const manager = new TeamManager({
        workerCount: 4,
        engineerManagerGroupSize: 4,
        baseBranch: 'main',
      });

      expect(manager.getMode()).toBe('flat');
    });

    it('should use hierarchy mode when workerCount > engineerManagerGroupSize', () => {
      const manager = new TeamManager({
        workerCount: 10,
        engineerManagerGroupSize: 4,
        baseBranch: 'main',
      });

      expect(manager.getMode()).toBe('hierarchy');
    });
  });

  describe('Flat Mode', () => {
    let manager: TeamManager;

    beforeEach(() => {
      manager = new TeamManager({
        workerCount: 4,
        engineerManagerGroupSize: 4,
        baseBranch: 'main',
      });
      manager.initialize();
    });

    it('should create workers without teams', () => {
      const workers = manager.getAllWorkers();
      const teams = manager.getAllTeams();

      expect(workers).toHaveLength(4);
      expect(teams).toHaveLength(0);
    });

    it('should create workers with correct branch names', () => {
      const workers = manager.getAllWorkers();

      expect(workers[0].branchName).toBe('worker-1');
      expect(workers[1].branchName).toBe('worker-2');
      expect(workers[2].branchName).toBe('worker-3');
      expect(workers[3].branchName).toBe('worker-4');
    });

    it('should not return team for worker in flat mode', () => {
      const team = manager.getTeamForWorker(1);
      expect(team).toBeUndefined();
    });
  });

  describe('Hierarchy Mode', () => {
    let manager: TeamManager;

    beforeEach(() => {
      manager = new TeamManager({
        workerCount: 10,
        engineerManagerGroupSize: 4,
        baseBranch: 'main',
      });
      manager.initialize();
    });

    it('should create correct number of teams', () => {
      const teams = manager.getAllTeams();
      // 10 workers / 4 per group = 3 teams (ceiling)
      expect(teams).toHaveLength(3);
    });

    it('should distribute workers across teams', () => {
      const team1 = manager.getTeam(1);
      const team2 = manager.getTeam(2);
      const team3 = manager.getTeam(3);

      expect(team1?.workerIds).toEqual([1, 2, 3, 4]);
      expect(team2?.workerIds).toEqual([5, 6, 7, 8]);
      expect(team3?.workerIds).toEqual([9, 10]); // Last team gets remaining
    });

    it('should create team branch names', () => {
      const teams = manager.getAllTeams();

      expect(teams[0].branchName).toBe('em-team-1');
      expect(teams[1].branchName).toBe('em-team-2');
      expect(teams[2].branchName).toBe('em-team-3');
    });

    it('should return correct team for worker', () => {
      expect(manager.getTeamForWorker(1)?.id).toBe(1);
      expect(manager.getTeamForWorker(5)?.id).toBe(2);
      expect(manager.getTeamForWorker(10)?.id).toBe(3);
    });

    it('should return workers for team', () => {
      const workers = manager.getWorkersForTeam(2);

      expect(workers).toHaveLength(4);
      expect(workers.map((w) => w.id)).toEqual([5, 6, 7, 8]);
    });
  });

  describe('Worker Management', () => {
    let manager: TeamManager;

    beforeEach(() => {
      manager = new TeamManager({
        workerCount: 3,
        engineerManagerGroupSize: 4,
        baseBranch: 'main',
      });
      manager.initialize();
    });

    it('should get worker by id', () => {
      const worker = manager.getWorker(2);

      expect(worker).toBeDefined();
      expect(worker?.id).toBe(2);
      expect(worker?.status).toBe('idle');
    });

    it('should update worker status', () => {
      manager.updateWorkerStatus(1, 'running');

      const worker = manager.getWorker(1);
      expect(worker?.status).toBe('running');
      expect(worker?.lastActivityAt).toBeInstanceOf(Date);
    });

    it('should get workers by status', () => {
      manager.updateWorkerStatus(1, 'running');
      manager.updateWorkerStatus(2, 'running');

      const running = manager.getWorkersByStatus('running');
      const idle = manager.getWorkersByStatus('idle');

      expect(running).toHaveLength(2);
      expect(idle).toHaveLength(1);
    });

    it('should get idle workers', () => {
      manager.updateWorkerStatus(1, 'running');

      const idle = manager.getIdleWorkers();

      expect(idle).toHaveLength(2);
      expect(idle.every((w) => w.status === 'idle')).toBe(true);
    });

    it('should set worker worktree path', () => {
      manager.setWorkerWorktreePath(1, '/test/path');

      const worker = manager.getWorker(1);
      expect(worker?.worktreePath).toBe('/test/path');
    });

    it('should increment task count', () => {
      manager.incrementTaskCount(1);
      manager.incrementTaskCount(1);

      const worker = manager.getWorker(1);
      expect(worker?.totalTasksCompleted).toBe(2);
    });

    it('should increment tool use count', () => {
      manager.incrementToolUseCount(1, 5);
      manager.incrementToolUseCount(1, 3);

      const worker = manager.getWorker(1);
      expect(worker?.toolUseCount).toBe(8);
    });

    it('should reset worker', () => {
      const worker = manager.getWorker(1);
      if (worker) {
        worker.status = 'error';
        worker.currentTask = { id: 'test' } as never;
      }

      manager.resetWorker(1);

      expect(manager.getWorker(1)?.status).toBe('idle');
      expect(manager.getWorker(1)?.currentTask).toBeUndefined();
    });
  });

  describe('Team Management', () => {
    let manager: TeamManager;

    beforeEach(() => {
      manager = new TeamManager({
        workerCount: 10,
        engineerManagerGroupSize: 4,
        baseBranch: 'main',
      });
      manager.initialize();
    });

    it('should set team worktree path', () => {
      manager.setTeamWorktreePath(1, '/test/team-1');

      const team = manager.getTeam(1);
      expect(team?.worktreePath).toBe('/test/team-1');
    });

    it('should get worker branch names', () => {
      const branches = manager.getWorkerBranchNames();

      expect(branches).toHaveLength(10);
      expect(branches[0]).toBe('worker-1');
      expect(branches[9]).toBe('worker-10');
    });

    it('should get team branch names', () => {
      const branches = manager.getTeamBranchNames();

      expect(branches).toHaveLength(3);
      expect(branches).toEqual(['em-team-1', 'em-team-2', 'em-team-3']);
    });
  });

  describe('Statistics', () => {
    let manager: TeamManager;

    beforeEach(() => {
      manager = new TeamManager({
        workerCount: 4,
        engineerManagerGroupSize: 4,
        baseBranch: 'main',
      });
      manager.initialize();
    });

    it('should return correct stats for flat mode', () => {
      manager.updateWorkerStatus(1, 'running');
      manager.updateWorkerStatus(2, 'error');
      manager.incrementTaskCount(3);
      manager.incrementTaskCount(3);
      manager.incrementToolUseCount(3, 10);

      const stats = manager.getStats();

      expect(stats.mode).toBe('flat');
      expect(stats.totalWorkers).toBe(4);
      expect(stats.idleWorkers).toBe(2);
      expect(stats.runningWorkers).toBe(1);
      expect(stats.errorWorkers).toBe(1);
      expect(stats.totalTeams).toBe(0);
      expect(stats.totalTasksCompleted).toBe(2);
      expect(stats.totalToolUses).toBe(10);
    });

    it('should return correct stats for hierarchy mode', () => {
      const hierarchyManager = new TeamManager({
        workerCount: 10,
        engineerManagerGroupSize: 4,
        baseBranch: 'main',
      });
      hierarchyManager.initialize();

      const stats = hierarchyManager.getStats();

      expect(stats.mode).toBe('hierarchy');
      expect(stats.totalWorkers).toBe(10);
      expect(stats.totalTeams).toBe(3);
    });
  });

  describe('Base Branch', () => {
    it('should return configured base branch', () => {
      const manager = new TeamManager({
        workerCount: 2,
        engineerManagerGroupSize: 4,
        baseBranch: 'develop',
      });

      expect(manager.getBaseBranch()).toBe('develop');
    });
  });
});
