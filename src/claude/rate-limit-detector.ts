import { TmuxManager } from '../tmux/session.js';
import { ClaudeInstanceManager } from './instance.js';
import { logger } from '../utils/logger.js';

/**
 * Patterns to detect rate limit errors in terminal output.
 * Note: Claude Code may not emit a rate_limit hook, so we scrape tmux output.
 * Update these patterns based on actual error messages observed during Phase 0 testing.
 */
const RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /429/,
  /too many requests/i,
  /please try again/i,
  /exceeded.*quota/i,
  /temporarily unavailable/i,
  /API rate limit/i,
  /request limit/i,
];

export class RateLimitDetector {
  private checkInterval: NodeJS.Timeout | null = null;
  private readonly patterns: RegExp[];
  private lastHandledTime: Map<string, number> = new Map();
  private readonly cooldownMs: number;

  constructor(
    private tmux: TmuxManager,
    private instanceManager: ClaudeInstanceManager,
    private onRateLimitDetected: (instanceId: string) => Promise<void>,
    options: { cooldownMs: number; patterns?: RegExp[] }
  ) {
    this.patterns = options.patterns ?? RATE_LIMIT_PATTERNS;
    this.cooldownMs = options.cooldownMs;
  }

  start(intervalMs: number): void {
    if (this.checkInterval) {
      this.stop();
    }

    this.checkInterval = setInterval(() => {
      this.checkAll().catch((err) => {
        logger.error('Rate limit check failed', err);
      });
    }, intervalMs);

    logger.info(`Rate limit detector started (interval: ${intervalMs}ms)`);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('Rate limit detector stopped');
    }
  }

  private async checkAll(): Promise<void> {
    const instances = this.instanceManager.getAllInstances();

    for (const instance of instances) {
      // Only check busy instances
      if (instance.status !== 'busy') continue;

      await this.checkInstance(instance.id, instance.sessionName);
    }
  }

  private async checkInstance(instanceId: string, sessionName: string): Promise<void> {
    // Skip if we recently handled a rate limit for this instance (cooldown period)
    const lastHandled = this.lastHandledTime.get(instanceId) || 0;
    if (Date.now() - lastHandled < this.cooldownMs) {
      logger.debug(`Skipping rate limit check for ${instanceId} (in cooldown)`);
      return;
    }

    try {
      const output = await this.tmux.capturePane(sessionName, 200);

      // Filter out orchestrator log lines to avoid self-triggering
      const filteredOutput = output
        .split('\n')
        .filter(line => !line.match(/^\d{4}-\d{2}-\d{2}.*\[(info|warn|error|debug)\]:/))
        .join('\n');

      for (const pattern of this.patterns) {
        if (pattern.test(filteredOutput)) {
          logger.warn(`Rate limit detected for ${instanceId}`, {
            pattern: pattern.toString(),
          });

          this.lastHandledTime.set(instanceId, Date.now());
          await this.onRateLimitDetected(instanceId);
          break; // Only trigger once per check
        }
      }
    } catch (err) {
      logger.debug(`Failed to check rate limit for ${instanceId}`, err);
    }
  }

  /**
   * Manually check a specific instance for rate limits.
   */
  async checkNow(instanceId: string): Promise<boolean> {
    const instance = this.instanceManager.getInstance(instanceId);
    if (!instance) return false;

    try {
      const output = await this.tmux.capturePane(instance.sessionName, 200);

      for (const pattern of this.patterns) {
        if (pattern.test(output)) {
          return true;
        }
      }
    } catch {
      // Ignore errors
    }

    return false;
  }

  /**
   * Add a custom pattern to detect.
   */
  addPattern(pattern: RegExp): void {
    this.patterns.push(pattern);
    logger.debug(`Added rate limit pattern: ${pattern.toString()}`);
  }

  /**
   * Clear cooldown for an instance (e.g., after successful recovery).
   */
  clearCooldown(instanceId: string): void {
    this.lastHandledTime.delete(instanceId);
  }

  /**
   * Check if an instance is currently in cooldown.
   */
  isInCooldown(instanceId: string): boolean {
    const lastHandled = this.lastHandledTime.get(instanceId) || 0;
    return Date.now() - lastHandled < this.cooldownMs;
  }
}
