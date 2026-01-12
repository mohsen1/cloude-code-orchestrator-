import { execa } from 'execa';
import { logger } from '../utils/logger.js';

export class TmuxManager {
  private sessions: Set<string> = new Set();

  /**
   * Create a tmux session that runs docker exec directly.
   * This is more robust than attaching after session creation.
   */
  async createSessionWithContainer(
    sessionName: string,
    containerName: string,
    command: string = 'claude --dangerously-skip-permissions'
  ): Promise<void> {
    try {
      // Check if session already exists
      const exists = await this.sessionExists(sessionName);
      if (exists) {
        logger.warn(`Session ${sessionName} already exists, killing it first`);
        await this.killSession(sessionName);
      }

      // Create session with docker exec as the command
      const dockerCommand = `docker exec -it ${containerName} /bin/bash -c "${command}"`;

      await execa('tmux', ['new-session', '-d', '-s', sessionName, dockerCommand]);

      this.sessions.add(sessionName);
      logger.info(`Created tmux session: ${sessionName} (attached to ${containerName})`);
    } catch (err) {
      logger.error(`Failed to create tmux session: ${sessionName}`, err);
      throw err;
    }
  }

  /**
   * Create a plain tmux session without attaching to a container.
   */
  async createSession(sessionName: string): Promise<void> {
    try {
      const exists = await this.sessionExists(sessionName);
      if (exists) {
        logger.warn(`Session ${sessionName} already exists`);
        return;
      }

      await execa('tmux', ['new-session', '-d', '-s', sessionName]);
      this.sessions.add(sessionName);
      logger.info(`Created tmux session: ${sessionName}`);
    } catch (err) {
      logger.error(`Failed to create tmux session: ${sessionName}`, err);
      throw err;
    }
  }

  /**
   * Send keys (text) to a tmux session.
   * Waits before pressing Enter to ensure Claude Code receives the input properly.
   */
  async sendKeys(sessionName: string, keys: string, pressEnter: boolean = true): Promise<void> {
    try {
      // Send the text first
      await execa('tmux', ['send-keys', '-t', sessionName, keys]);
      logger.debug(`Sent keys to ${sessionName}: ${keys.substring(0, 50)}...`);

      if (pressEnter) {
        // Wait 3 seconds for Claude Code to process the pasted text
        await new Promise((resolve) => setTimeout(resolve, 3000));
        // Then send Enter
        await execa('tmux', ['send-keys', '-t', sessionName, 'Enter']);
        logger.debug(`Sent Enter to ${sessionName}`);
      }
    } catch (err) {
      logger.error(`Failed to send keys to ${sessionName}`, err);
      throw err;
    }
  }

  /**
   * Send a control sequence (like Ctrl+C).
   */
  async sendControlKey(sessionName: string, key: string): Promise<void> {
    try {
      await execa('tmux', ['send-keys', '-t', sessionName, key]);
      logger.debug(`Sent control key to ${sessionName}: ${key}`);
    } catch (err) {
      logger.error(`Failed to send control key to ${sessionName}`, err);
      throw err;
    }
  }

  /**
   * Capture the visible pane content.
   * WARNING: Do NOT use this for control flow decisions.
   * Use hooks for state changes. This is for logging/debugging only.
   */
  async capturePane(sessionName: string, lines: number = 100): Promise<string> {
    try {
      const { stdout } = await execa('tmux', [
        'capture-pane',
        '-t',
        sessionName,
        '-p', // Print to stdout
        '-S',
        `-${lines}`, // Start from N lines back
      ]);
      return stdout;
    } catch (err) {
      logger.debug(`Failed to capture pane for ${sessionName}`, err);
      return '';
    }
  }

  /**
   * Kill a tmux session.
   */
  async killSession(sessionName: string): Promise<void> {
    try {
      await execa('tmux', ['kill-session', '-t', sessionName]);
      this.sessions.delete(sessionName);
      logger.info(`Killed tmux session: ${sessionName}`);
    } catch (err: unknown) {
      // Session might not exist
      if (err instanceof Error && err.message.includes('session not found')) {
        this.sessions.delete(sessionName);
        return;
      }
      logger.warn(`Failed to kill tmux session: ${sessionName}`, err);
    }
  }

  /**
   * Check if a session exists.
   */
  async sessionExists(sessionName: string): Promise<boolean> {
    try {
      await execa('tmux', ['has-session', '-t', sessionName]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all tmux sessions.
   */
  async listSessions(): Promise<string[]> {
    try {
      const { stdout } = await execa('tmux', ['list-sessions', '-F', '#{session_name}']);
      return stdout.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Kill all orchestrator-related sessions (those starting with 'claude-').
   */
  async killAllOrchestratorSessions(): Promise<void> {
    const sessions = await this.listSessions();
    const orchestratorSessions = sessions.filter((s) => s.startsWith('claude-'));

    for (const session of orchestratorSessions) {
      await this.killSession(session);
    }

    this.sessions.clear();
    logger.info(`Killed ${orchestratorSessions.length} orchestrator sessions`);
  }

  /**
   * Get tracked sessions.
   */
  getTrackedSessions(): string[] {
    return Array.from(this.sessions);
  }
}
