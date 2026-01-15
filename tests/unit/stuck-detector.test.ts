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
      { stuckThresholdMs: 60000 } // 1 minute threshold
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
    it('should attempt Ctrl+C recovery before escalating to onStuck', async () => {
      const mockTmux = {
        sendControlKey: vi.fn().mockResolvedValue(undefined),
        sendKeys: vi.fn().mockResolvedValue(undefined),
      };
      
      const detectorWithTmux = new StuckDetector(
        mockInstanceManager as any,
        onStuckCallback,
        { stuckThresholdMs: 60000 }, // 1 minute threshold
        mockTmux as any
      );

      // Stage 1: First Ctrl+C attempt
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      mockInstanceManager.setLastToolUse('worker-1', twoMinutesAgo);
      await (detectorWithTmux as any).check();
      
      expect(mockTmux.sendControlKey).toHaveBeenCalledTimes(1);
      expect(onStuckCallback).not.toHaveBeenCalled();

      // Stage 2: Second Ctrl+C attempt (after 1 minute cooldown)
      // Update recovery state to simulate time passing
      const recoveryState = (detectorWithTmux as any).recoveryStates.get('worker-1');
      recoveryState.lastAttemptTime = Date.now() - 61000; // 1 minute ago
      mockInstanceManager.setLastToolUse('worker-1', new Date(Date.now() - 3 * 60 * 1000));
      
      await (detectorWithTmux as any).check();
      expect(mockTmux.sendControlKey).toHaveBeenCalledTimes(2);
      expect(onStuckCallback).not.toHaveBeenCalled();

      // Stage 3: Escalate after 2 failed Ctrl+C attempts
      recoveryState.lastAttemptTime = Date.now() - 61000;
      mockInstanceManager.setLastToolUse('worker-1', new Date(Date.now() - 4 * 60 * 1000));
      
      await (detectorWithTmux as any).check();
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
      const mockTmux = {
        sendControlKey: vi.fn().mockResolvedValue(undefined),
        sendKeys: vi.fn().mockResolvedValue(undefined),
      };
      
      const detector = new StuckDetector(
        mockInstanceManager as any,
        errorCallback,
        { stuckThresholdMs: 60000 },
        mockTmux as any
      );

      // Set up state to trigger immediate escalation (simulate already tried Ctrl+C twice)
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      mockInstanceManager.setLastToolUse('worker-1', tenMinutesAgo);
      
      (detector as any).recoveryStates.set('worker-1', {
        nudgeCount: 1,
        ctrlCCount: 2,
        lastAttemptTime: Date.now() - 120000
      });

      // Should not throw even though callback errors
      await expect((detector as any).check()).resolves.not.toThrow();
      expect(errorCallback).toHaveBeenCalled();
    });
  });
});