import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CostTracker } from '../../src/orchestrator/cost-tracker.js';
import { TeamManager } from '../../src/v2/team-manager.js';

/**
 * Create a mock TeamManager for testing
 */
function createMockTeamManager(workerCount: number = 3): TeamManager {
  const manager = new TeamManager({
    workerCount,
    engineerManagerGroupSize: 4,
    baseBranch: 'main',
  });
  manager.initialize();
  return manager;
}

describe('CostTracker', () => {
  let teamManager: TeamManager;
  let costTracker: CostTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    teamManager = createMockTeamManager(3);

    costTracker = new CostTracker(teamManager, {
      maxToolUsesPerInstance: 100,
      maxTotalToolUses: 250,
      maxRunDurationMinutes: 60,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getStats', () => {
    it('should return current usage statistics', () => {
      teamManager.incrementToolUseCount(1, 10);
      teamManager.incrementToolUseCount(2, 20);
      teamManager.incrementToolUseCount(3, 30);

      const stats = costTracker.getStats();

      expect(stats.totalToolUses).toBe(60);
      expect(stats.toolUsesPerWorker.get(1)).toBe(10);
      expect(stats.toolUsesPerWorker.get(2)).toBe(20);
      expect(stats.toolUsesPerWorker.get(3)).toBe(30);
    });

    it('should track run duration', () => {
      const stats1 = costTracker.getStats();
      expect(stats1.runDurationMinutes).toBe(0);

      // Advance time by 30 minutes
      vi.advanceTimersByTime(30 * 60 * 1000);

      const stats2 = costTracker.getStats();
      expect(stats2.runDurationMinutes).toBeCloseTo(30, 1);
    });
  });

  describe('checkLimits', () => {
    it('should not exceed when under all limits', () => {
      teamManager.incrementToolUseCount(1, 10);
      teamManager.incrementToolUseCount(2, 20);
      teamManager.incrementToolUseCount(3, 30);

      const result = costTracker.checkLimits();

      expect(result.exceeded).toBe(false);
      expect(result.reason).toBeUndefined();
    });

    it('should detect total tool use limit exceeded', () => {
      teamManager.incrementToolUseCount(1, 100);
      teamManager.incrementToolUseCount(2, 100);
      teamManager.incrementToolUseCount(3, 100);

      const result = costTracker.checkLimits();

      expect(result.exceeded).toBe(true);
      expect(result.reason).toContain('Total tool uses');
      expect(result.reason).toContain('300');
      expect(result.reason).toContain('250');
    });

    it('should detect per-worker limit exceeded', () => {
      teamManager.incrementToolUseCount(2, 150);

      const result = costTracker.checkLimits();

      expect(result.exceeded).toBe(true);
      expect(result.reason).toContain('Worker 2');
      expect(result.reason).toContain('150');
      expect(result.reason).toContain('100');
    });

    it('should detect run duration limit exceeded', () => {
      vi.advanceTimersByTime(70 * 60 * 1000); // 70 minutes

      const result = costTracker.checkLimits();

      expect(result.exceeded).toBe(true);
      expect(result.reason).toContain('Run duration');
      expect(result.reason).toContain('60m');
    });
  });

  describe('checkAndWarn', () => {
    it('should warn when approaching total limit', () => {
      teamManager.incrementToolUseCount(1, 80);
      teamManager.incrementToolUseCount(2, 80);
      teamManager.incrementToolUseCount(3, 50);

      // 210/250 = 84% > 80% threshold
      const result = costTracker.checkAndWarn(0.8);

      expect(result.exceeded).toBe(false); // Not exceeded yet
    });

    it('should warn only once per threshold', () => {
      teamManager.incrementToolUseCount(1, 80);
      teamManager.incrementToolUseCount(2, 80);
      teamManager.incrementToolUseCount(3, 50);

      costTracker.checkAndWarn(0.8);
      costTracker.checkAndWarn(0.8);

      // Should only warn once (checked via the warned set)
      expect((costTracker as any).warned.has('total')).toBe(true);
    });

    it('should warn when approaching per-worker limit', () => {
      teamManager.incrementToolUseCount(2, 85);

      costTracker.checkAndWarn(0.8);

      expect((costTracker as any).warned.has('worker-2')).toBe(true);
    });

    it('should warn when approaching duration limit', () => {
      vi.advanceTimersByTime(50 * 60 * 1000); // 50 minutes = 83%

      costTracker.checkAndWarn(0.8);

      expect((costTracker as any).warned.has('duration')).toBe(true);
    });
  });

  describe('updateLimits', () => {
    it('should update limits at runtime', () => {
      costTracker.updateLimits({ maxTotalToolUses: 500 });

      const limits = costTracker.getLimits();
      expect(limits.maxTotalToolUses).toBe(500);
      expect(limits.maxToolUsesPerInstance).toBe(100); // Unchanged
    });

    it('should reset warnings when limits updated', () => {
      teamManager.incrementToolUseCount(2, 85);
      costTracker.checkAndWarn(0.8);

      expect((costTracker as any).warned.has('worker-2')).toBe(true);

      costTracker.updateLimits({ maxToolUsesPerInstance: 200 });

      expect((costTracker as any).warned.size).toBe(0);
    });
  });

  describe('resetWarnings', () => {
    it('should clear all warnings', () => {
      (costTracker as any).warned.add('total');
      (costTracker as any).warned.add('duration');
      (costTracker as any).warned.add('worker-1');

      costTracker.resetWarnings();

      expect((costTracker as any).warned.size).toBe(0);
    });
  });

  describe('getLimits', () => {
    it('should return copy of limits', () => {
      const limits = costTracker.getLimits();

      expect(limits.maxToolUsesPerInstance).toBe(100);
      expect(limits.maxTotalToolUses).toBe(250);
      expect(limits.maxRunDurationMinutes).toBe(60);

      // Modifying returned object shouldn't affect internal state
      limits.maxTotalToolUses = 999;
      expect(costTracker.getLimits().maxTotalToolUses).toBe(250);
    });
  });

  describe('default limits', () => {
    it('should use default limits when not specified', () => {
      const tracker = new CostTracker(teamManager);
      const limits = tracker.getLimits();

      expect(limits.maxToolUsesPerInstance).toBe(500);
      expect(limits.maxTotalToolUses).toBe(2000);
      expect(limits.maxRunDurationMinutes).toBe(120);
    });
  });
});
