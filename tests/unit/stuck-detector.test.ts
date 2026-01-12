import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StuckDetector } from '../../src/orchestrator/stuck-detector.js';
import { createMockInstanceManager, createMockInstance } from '../helpers/mocks.js';

describe('StuckDetector', () => {
  let mockInstanceManager: ReturnType<typeof createMockInstanceManager>;
  let stuckDetector: StuckDetector;
  let onStuckCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockInstanceManager = createMockInstanceManager([
      createMockInstance('manager', 'manager', { status: 'busy' }),
      createMockInstance('worker-1', 'worker', { status: 'busy' }),
      createMockInstance('worker-2', 'worker', { status: 'ready' }),
    ]);

    onStuckCallback = vi.fn().mockResolvedValue(undefined);

    stuckDetector = new StuckDetector(
      mockInstanceManager as any,
      onStuckCallback,
      60000 // 1 minute threshold
    );
  });

  afterEach(() => {
    stuckDetector.stop();
  });

  describe('start/stop', () => {
    it('should start monitoring', () => {
      stuckDetector.start(10000);

      expect((stuckDetector as any).checkInterval).not.toBeNull();
    });

    it('should stop monitoring', () => {
      stuckDetector.start(10000);
      stuckDetector.stop();

      expect((stuckDetector as any).checkInterval).toBeNull();
    });

    it('should restart monitoring when start called twice', () => {
      stuckDetector.start(10000);
      const firstInterval = (stuckDetector as any).checkInterval;

      stuckDetector.start(5000);
      const secondInterval = (stuckDetector as any).checkInterval;

      expect(secondInterval).not.toBe(firstInterval);
    });
  });

  describe('checkInstance', () => {
    it('should return true for stuck instance', async () => {
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      mockInstanceManager.setLastToolUse('worker-1', twoMinutesAgo);

      const isStuck = await stuckDetector.checkInstance('worker-1');

      expect(isStuck).toBe(true);
    });

    it('should return false for active instance', async () => {
      const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
      mockInstanceManager.setLastToolUse('worker-1', thirtySecondsAgo);

      const isStuck = await stuckDetector.checkInstance('worker-1');

      expect(isStuck).toBe(false);
    });

    it('should return false for non-existent instance', async () => {
      const isStuck = await stuckDetector.checkInstance('non-existent');

      expect(isStuck).toBe(false);
    });

    it('should return false for non-busy instance', async () => {
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      mockInstanceManager.setLastToolUse('worker-2', twoMinutesAgo);

      const isStuck = await stuckDetector.checkInstance('worker-2');

      expect(isStuck).toBe(false);
    });

    it('should return false for instance without lastToolUse', async () => {
      const isStuck = await stuckDetector.checkInstance('manager');

      expect(isStuck).toBe(false);
    });
  });

  describe('setThreshold', () => {
    it('should update threshold', () => {
      stuckDetector.setThreshold(120000);

      expect(stuckDetector.getThreshold()).toBe(120000);
    });

    it('should affect stuck detection', async () => {
      const ninetySecondsAgo = new Date(Date.now() - 90 * 1000);
      mockInstanceManager.setLastToolUse('worker-1', ninetySecondsAgo);

      // With 60s threshold, instance should be stuck
      let isStuck = await stuckDetector.checkInstance('worker-1');
      expect(isStuck).toBe(true);

      // With 120s threshold, instance should not be stuck
      stuckDetector.setThreshold(120000);
      isStuck = await stuckDetector.checkInstance('worker-1');
      expect(isStuck).toBe(false);
    });
  });

  describe('getThreshold', () => {
    it('should return current threshold', () => {
      expect(stuckDetector.getThreshold()).toBe(60000);
    });
  });

  describe('default threshold', () => {
    it('should use default 5 minute threshold', () => {
      const detector = new StuckDetector(mockInstanceManager as any, onStuckCallback);

      expect(detector.getThreshold()).toBe(5 * 60 * 1000);
    });
  });

  describe('internal check method', () => {
    it('should call onStuck callback for stuck instances', async () => {
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      mockInstanceManager.setLastToolUse('worker-1', twoMinutesAgo);

      // Directly call the private check method
      await (stuckDetector as any).check();

      expect(onStuckCallback).toHaveBeenCalledWith('worker-1');
    });

    it('should not call onStuck for non-busy instances', async () => {
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      mockInstanceManager.setLastToolUse('worker-2', twoMinutesAgo);
      // worker-2 has status 'ready', not 'busy'

      await (stuckDetector as any).check();

      expect(onStuckCallback).not.toHaveBeenCalledWith('worker-2');
    });

    it('should not call onStuck for instances without lastToolUse', async () => {
      // manager has status 'busy' but no lastToolUse (just started)
      await (stuckDetector as any).check();

      expect(onStuckCallback).not.toHaveBeenCalledWith('manager');
    });

    it('should not call onStuck for instances with recent activity', async () => {
      const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
      mockInstanceManager.setLastToolUse('worker-1', thirtySecondsAgo);

      await (stuckDetector as any).check();

      expect(onStuckCallback).not.toHaveBeenCalled();
    });

    it('should continue checking after callback error', async () => {
      const errorCallback = vi.fn().mockRejectedValue(new Error('Test error'));
      const detector = new StuckDetector(
        mockInstanceManager as any,
        errorCallback,
        60000
      );

      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      mockInstanceManager.setLastToolUse('worker-1', twoMinutesAgo);

      // Should not throw
      await expect((detector as any).check()).resolves.not.toThrow();

      expect(errorCallback).toHaveBeenCalled();
    });
  });
});
