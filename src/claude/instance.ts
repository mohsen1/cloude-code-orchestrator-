import { TmuxManager } from '../tmux/session.js';
import { logger } from '../utils/logger.js';

export type InstanceType = 'director' | 'em' | 'worker' | 'manager';
export type InstanceStatus =
  | 'starting'
  | 'ready'
  | 'busy'
  | 'idle'
  | 'merging'
  | 'error'
  | 'stopped';

export interface ClaudeInstance {
  id: string;
  type: InstanceType;
  workerId: number;
  sessionName: string;
  workDir: string;
  status: InstanceStatus;
  currentTask?: string;
  currentTaskFull?: string; // Full task description for context restoration
  lastToolUse?: Date; // For heartbeat/stuck detection
  toolUseCount: number; // For cost tracking
  createdAt: Date;
  apiKey?: string; // If set, uses this key instead of OAuth
  model?: string; // Claude model to use (e.g., 'haiku', 'sonnet', 'opus')
  logFile?: string; // Path to the tmux log file
}

export class ClaudeInstanceManager {
  private instances: Map<string, ClaudeInstance> = new Map();

  constructor(private tmux: TmuxManager) {}

  /**
   * Add an instance to the manager (used when orchestrator creates sessions directly).
   */
  addInstance(instance: ClaudeInstance): void {
    this.instances.set(instance.id, instance);
    logger.info(`Added instance: ${instance.id}`, {
      type: instance.type,
      workDir: instance.workDir,
      hasApiKey: !!instance.apiKey,
    });
  }

  /**
   * Send a prompt to an instance with safety checks.
   * Ensures Claude is running, clears screen, and waits before sending.
   */
  async sendPrompt(instanceId: string, prompt: string, workDir?: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    const dir = workDir ?? instance.workDir;

    // 1. Check if at shell prompt (Claude crashed) and restart if needed
    const didRestart = await this.tmux.ensureClaudeRunning(instance.sessionName, dir, instance.model);
    if (didRestart) {
      logger.info(`Restarted Claude for ${instanceId} before sending prompt`);
      // Wait for Claude to fully initialize after restart
      await new Promise(r => setTimeout(r, 5000));
    }

    // 2. Clear the screen for a clean slate
    await this.tmux.sendControlKey(instance.sessionName, 'C-l');
    await new Promise(r => setTimeout(r, 500));

    // 3. Check if at Claude prompt (waiting for input)
    const atPrompt = await this.tmux.isAtClaudePrompt(instance.sessionName);
    if (!atPrompt) {
      // Might be in the middle of something, send Ctrl+C first
      logger.debug(`Instance ${instanceId} not at prompt, sending Ctrl+C first`);
      await this.tmux.sendControlKey(instance.sessionName, 'C-c');
      await new Promise(r => setTimeout(r, 2000));
    }

    // 4. Update instance state
    instance.status = 'busy';
    instance.currentTask = prompt.substring(0, 100);
    instance.currentTaskFull = prompt;
    instance.lastToolUse = new Date(); // Reset stuck timer

    // 5. Send the prompt
    await this.tmux.sendKeys(instance.sessionName, prompt);

    logger.debug(`Sent prompt to ${instanceId}`, {
      taskPreview: instance.currentTask,
      didRestart,
    });
  }

  /**
   * Get terminal output from instance.
   * WARNING: Do NOT use this for control flow decisions.
   * Use hooks for state changes. This is for logging/debugging only.
   */
  async getOutput(instanceId: string, lines: number = 500): Promise<string> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    return this.tmux.capturePane(instance.sessionName, lines);
  }

  async interruptInstance(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    await this.tmux.sendControlKey(instance.sessionName, 'C-c');
    logger.info(`Interrupted instance: ${instanceId}`);
  }

  getInstance(instanceId: string): ClaudeInstance | undefined {
    return this.instances.get(instanceId);
  }

  getAllInstances(): ClaudeInstance[] {
    return Array.from(this.instances.values());
  }

  getInstancesByType(type: InstanceType): ClaudeInstance[] {
    return this.getAllInstances().filter((i) => i.type === type);
  }

  getIdleWorkers(): ClaudeInstance[] {
    return this.getAllInstances().filter(
      (i) => i.type === 'worker' && i.status === 'idle'
    );
  }

  getBusyWorkers(): ClaudeInstance[] {
    return this.getAllInstances().filter(
      (i) => i.type === 'worker' && i.status === 'busy'
    );
  }

  updateStatus(instanceId: string, status: InstanceStatus): void {
    const instance = this.instances.get(instanceId);
    if (instance) {
      const oldStatus = instance.status;
      instance.status = status;
      logger.debug(`Instance ${instanceId} status: ${oldStatus} -> ${status}`);
    }
  }

  updateToolUse(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (instance) {
      instance.lastToolUse = new Date();
      instance.toolUseCount++;
    }
  }

  clearTask(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (instance) {
      instance.currentTask = undefined;
      instance.currentTaskFull = undefined;
    }
  }

  /**
   * Lock a worker during merge operations to prevent race conditions.
   */
  lockWorker(workerId: number): void {
    const instance = this.instances.get(`worker-${workerId}`);
    if (instance) {
      instance.status = 'merging';
      logger.info(`Locked worker ${workerId} for merge`);
    }
  }

  /**
   * Unlock a worker after merge completes.
   */
  unlockWorker(workerId: number): void {
    const instance = this.instances.get(`worker-${workerId}`);
    if (instance && instance.status === 'merging') {
      instance.status = 'idle';
      logger.info(`Unlocked worker ${workerId}`);
    }
  }

  /**
   * Remove an instance from tracking (without killing session).
   */
  removeInstance(instanceId: string): void {
    this.instances.delete(instanceId);
  }

  async destroyInstance(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (instance) {
      await this.tmux.killSession(instance.sessionName);
      this.instances.delete(instanceId);
      logger.info(`Destroyed instance: ${instanceId}`);
    }
  }

  async destroyAll(): Promise<void> {
    const ids = Array.from(this.instances.keys());
    for (const id of ids) {
      await this.destroyInstance(id);
    }
  }

  getStats(): {
    total: number;
    byStatus: Record<InstanceStatus, number>;
    totalToolUses: number;
  } {
    const instances = this.getAllInstances();
    const byStatus: Record<InstanceStatus, number> = {
      starting: 0,
      ready: 0,
      busy: 0,
      idle: 0,
      merging: 0,
      error: 0,
      stopped: 0,
    };

    let totalToolUses = 0;

    for (const instance of instances) {
      byStatus[instance.status]++;
      totalToolUses += instance.toolUseCount;
    }

    return {
      total: instances.length,
      byStatus,
      totalToolUses,
    };
  }
}
