import { ClaudeInstanceManager } from '../claude/instance.js';
import { TmuxManager } from '../tmux/session.js';
import { logger } from '../utils/logger.js';

export interface StuckDetectorTiming {
  stuckThresholdMs: number;
  nudgeThresholdMs?: number;
  escalationCooldownMs?: number;
  interventionDelayMs?: number;
}

/**
 * Tracks recovery attempts for an instance
 */
interface RecoveryState {
  nudgeCount: number;
  ctrlCCount: number;
  lastAttemptTime: number;
}

export class StuckDetector {
  private checkInterval: NodeJS.Timeout | null = null;
  private stuckThresholdMs: number;
  private nudgeThresholdMs: number;
  private escalationCooldownMs: number;
  private interventionDelayMs: number;
  private nudgedInstances: Set<string> = new Set(); // Track which instances we've nudged
  private recoveryStates: Map<string, RecoveryState> = new Map(); // Track recovery attempts

  constructor(
    private instanceManager: ClaudeInstanceManager,
    private onStuck: (instanceId: string) => Promise<void>,
    timing: StuckDetectorTiming = { stuckThresholdMs: 300000 },
    private tmux?: TmuxManager
  ) {
    this.stuckThresholdMs = timing.stuckThresholdMs ?? 300000;
    this.nudgeThresholdMs = timing.nudgeThresholdMs ?? Math.round(this.stuckThresholdMs * 0.4);
    this.escalationCooldownMs = timing.escalationCooldownMs ?? Math.round(this.stuckThresholdMs * 0.2);
    this.interventionDelayMs = timing.interventionDelayMs ?? Math.max(1, Math.round(this.stuckThresholdMs / 150));
  }

  /**
   * Set the tmux manager reference (for active intervention).
   */
  setTmuxManager(tmux: TmuxManager): void {
    this.tmux = tmux;
  }

  /**
   * Start monitoring for stuck instances.
   */
  start(intervalMs: number): void {
    if (this.checkInterval) {
      this.stop();
    }

    this.checkInterval = setInterval(() => {
      this.check().catch((err) => {
        logger.error('Stuck detection check failed', err);
      });
    }, intervalMs);

    logger.info(`Stuck detector started (threshold: ${this.stuckThresholdMs}ms, interval: ${intervalMs}ms)`);
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('Stuck detector stopped');
    }
  }

  /**
   * Check all instances for stuck state with multi-stage intervention.
   */
  private async check(): Promise<void> {
    const instances = this.instanceManager.getAllInstances();
    const now = Date.now();

    for (const instance of instances) {
      // Only check busy instances
      if (instance.status !== 'busy') {
        // Clear recovery state when not busy
        this.recoveryStates.delete(instance.id);
        this.nudgedInstances.delete(instance.id);
        continue;
      }

      // Initialize lastToolUse if not set (grace period)
      if (!instance.lastToolUse) {
        instance.lastToolUse = new Date();
        continue;
      }

      const idleTime = now - instance.lastToolUse.getTime();

      // Get or create recovery state
      let recoveryState = this.recoveryStates.get(instance.id);
      if (!recoveryState) {
        recoveryState = { nudgeCount: 0, ctrlCCount: 0, lastAttemptTime: 0 };
        this.recoveryStates.set(instance.id, recoveryState);
      }

      // STAGE 1: Nudge - try to auto-answer prompts
      if (idleTime > this.nudgeThresholdMs && idleTime < this.stuckThresholdMs) {
        if (!this.nudgedInstances.has(instance.id) && this.tmux) {
          await this.tryNudge(instance.id, instance.sessionName);
          this.nudgedInstances.add(instance.id);
          recoveryState.nudgeCount++;
          recoveryState.lastAttemptTime = now;
        }
        continue;
      }

      // STAGE 2+: Hard interventions (threshold reached)
      if (idleTime > this.stuckThresholdMs) {
        // Wait between escalation attempts
        if (now - recoveryState.lastAttemptTime < this.escalationCooldownMs) {
          continue;
        }

        // Stage 2: Send Ctrl+C (try up to 2 times)
        if (recoveryState.ctrlCCount < 2) {
          logger.warn(
            `Instance ${instance.id} stuck (no activity for ${(idleTime / 60000).toFixed(1)} minutes). ` +
            `Sending Ctrl+C (attempt ${recoveryState.ctrlCCount + 1}/2)`
          );

          try {
            if (this.tmux) {
              await this.tmux.sendControlKey(instance.sessionName, 'C-c');
              await new Promise(r => setTimeout(r, this.interventionDelayMs));
              await this.tmux.sendKeys(instance.sessionName, '', true); // Send Enter to clear
            }

            recoveryState.ctrlCCount++;
            recoveryState.lastAttemptTime = now;
            instance.lastToolUse = new Date(); // Reset timer to give it time to respond
          } catch (err) {
            logger.error(`Failed to send Ctrl+C to instance ${instance.id}`, err);
          }
          continue;
        }

        // Stage 3: Escalate to orchestrator for restart/EM notification
        logger.error(
          `Instance ${instance.id} permanently stuck after ${recoveryState.nudgeCount} nudges and ` +
          `${recoveryState.ctrlCCount} Ctrl+C attempts. Escalating to orchestrator.`
        );

        try {
          this.nudgedInstances.delete(instance.id);
          this.recoveryStates.delete(instance.id);
          instance.lastToolUse = new Date(); // Reset to prevent immediate re-escalation
          await this.onStuck(instance.id);
        } catch (err) {
          logger.error(`Failed to escalate stuck instance ${instance.id}`, err);
        }
      }
    }
  }

  /**
   * Try to nudge a stuck instance by answering prompts or sending wake-up.
   */
  private async tryNudge(instanceId: string, sessionName: string): Promise<void> {
    if (!this.tmux) return;

    try {
      // Check for confirmation prompts
      const confirmKey = await this.tmux.hasConfirmationPrompt(sessionName);
      if (confirmKey) {
        logger.info(`Instance ${instanceId} waiting for confirmation, sending '${confirmKey}'`);
        if (confirmKey === 'Enter') {
          await this.tmux.sendKeys(sessionName, '', true);
        } else {
          await this.tmux.sendKeys(sessionName, confirmKey, true);
        }
        return;
      }

      // Check for pending input in prompt buffer (text typed but not sent)
      const hasPendingInput = await this.tmux.hasPendingInput(sessionName);
      if (hasPendingInput) {
        logger.info(`Instance ${instanceId} has pending input, sending Enter`);
        await this.tmux.sendEnter(sessionName);
        return;
      }

      // Check if at Claude prompt (waiting for input but nothing sent)
      const atPrompt = await this.tmux.isAtClaudePrompt(sessionName);
      if (atPrompt) {
        logger.debug(`Instance ${instanceId} at Claude prompt, may be waiting for orchestrator`);
        // Don't intervene if at prompt - orchestrator should send next command
        return;
      }

      // Send a space to wake up (in case of rendering issue)
      logger.debug(`Nudging instance ${instanceId} with space`);
      await this.tmux.sendKeys(sessionName, ' ', false);
    } catch (err) {
      logger.debug(`Failed to nudge instance ${instanceId}`, err);
    }
  }

  /**
   * Manually check a specific instance.
   */
  async checkInstance(instanceId: string): Promise<boolean> {
    const instance = this.instanceManager.getInstance(instanceId);
    if (!instance || instance.status !== 'busy' || !instance.lastToolUse) {
      return false;
    }

    const idleTime = Date.now() - instance.lastToolUse.getTime();
    return idleTime > this.stuckThresholdMs;
  }

  /**
   * Update the stuck threshold.
   */
  setThreshold(thresholdMs: number): void {
    this.stuckThresholdMs = thresholdMs;
    this.nudgeThresholdMs = Math.round(this.stuckThresholdMs * 0.4);
    this.escalationCooldownMs = Math.round(this.stuckThresholdMs * 0.2);
    this.interventionDelayMs = Math.max(1, Math.round(this.stuckThresholdMs / 150));
    logger.info(`Stuck detector threshold updated: ${thresholdMs}ms`);
  }

  /**
   * Get current threshold.
   */
  getThreshold(): number {
    return this.stuckThresholdMs;
  }
}
