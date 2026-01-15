import { execa } from 'execa';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { logger } from '../utils/logger.js';

export class TmuxManager {
  private sessions: Set<string> = new Set();

  /**
   * Create a tmux session with optional environment variables.
   * This allows per-worker auth isolation without Docker.
   *
   * If no ANTHROPIC_API_KEY is provided in env, Claude will use host OAuth.
   */
  async createSession(
    sessionName: string,
    cwd: string,
    env: Record<string, string> = {},
    logFile?: string
  ): Promise<void> {
    try {
      if (await this.sessionExists(sessionName)) {
        logger.warn(`Session ${sessionName} exists, killing...`);
        await this.killSession(sessionName);
      }

      // 1. Create the session detached in the correct directory
      await execa('tmux', ['new-session', '-d', '-s', sessionName, '-c', cwd]);

      if (logFile) {
        await this.attachSessionLogger(sessionName, logFile);
      }

      // 2. Set options to prevent auto-rename (cosmetic but helpful for debugging)
      await execa('tmux', ['set-option', '-t', sessionName, 'allow-rename', 'off']);

      // 3. Inject Environment Variables into this specific session
      // This sets it for tmux, but the running shell needs explicit export
      for (const [key, value] of Object.entries(env)) {
        await execa('tmux', ['set-environment', '-t', sessionName, key, value]);
      }

      // 4. Export env vars in the shell so they're available to claude
      // Use single quotes for values to prevent shell expansion of $ chars
      if (Object.keys(env).length > 0) {
        const exportCmd = Object.entries(env)
          .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
          .join(' && ');
        await this.sendKeys(sessionName, exportCmd, true);
        // Clear screen so we don't expose secrets in terminal history
        await this.sendKeys(sessionName, 'clear', true);
      }

      this.sessions.add(sessionName);
      logger.info(`Created session: ${sessionName}`, {
        envKeys: Object.keys(env),
      });
    } catch (err) {
      logger.error(`Failed to create session: ${sessionName}`, err);
      throw err;
    }
  }

  /**
   * Create a session and start Claude immediately.
   * @param model - Optional model to use (e.g., 'haiku', 'sonnet', 'opus')
   */
  async createSessionWithClaude(
    sessionName: string,
    cwd: string,
    env: Record<string, string> = {},
    model?: string,
    logFile?: string
  ): Promise<void> {
    await this.createSession(sessionName, cwd, env, logFile);

    // Start Claude with optional model
    const claudeCmd = model
      ? `claude --dangerously-skip-permissions --model ${model}`
      : 'claude --dangerously-skip-permissions';
    await this.sendKeys(sessionName, claudeCmd, true);

    // Wait for Claude to actually be ready (not just a fixed timeout)
    await this.waitForClaudeReady(sessionName, 30000);
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
   * Check if session is at a shell prompt (Claude crashed/exited).
   * Detects patterns like: user@host$, root#, bash-5.1$, fish prompts, etc.
   * 
   * Fish shell prompt example: "/p/t/o/w/worker-2 ❯ worker-2 $"
   * Claude prompt example: "❯" at the end of a line without $ or #
   */
  async isAtShellPrompt(sessionName: string): Promise<boolean> {
    const content = await this.capturePane(sessionName, 10);
    const lastLines = content.trim().split('\n').slice(-5).join('\n');
    const lastLine = content.trim().split('\n').slice(-1)[0] || '';
    
    // If we see "fish:" error messages, we're definitely at a fish shell
    if (lastLines.includes('fish:')) {
      return true;
    }
    
    // Look for fish-specific patterns (fish shows path with ❯ AND ends with $)
    // e.g., "/p/t/o/w/worker-2 ❯ worker-2 $"
    if (lastLine.includes('❯') && lastLine.match(/\$\s*$/)) {
      return true; // Fish shell prompt
    }
    
    // Standard shell prompt at end of line (bash, zsh without powerline)
    if (/[$#]\s*$/.test(lastLine) && !lastLines.includes('Claude')) {
      // Make sure we're not in Claude - check for Claude UI indicators
      const hasClaudeUI = lastLines.includes('⏺') || 
                          lastLines.includes('───────') ||
                          lastLines.includes('bypass permissions') ||
                          lastLines.includes('Implementing') ||
                          lastLines.includes('Reading');
      if (!hasClaudeUI) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Check if session is at Claude's input prompt (waiting for user input).
   */
  async isAtClaudePrompt(sessionName: string): Promise<boolean> {
    const content = await this.capturePane(sessionName, 5);
    const lastLines = content.trim().split('\n').slice(-3).join('\n');
    // Claude prompt indicator
    return lastLines.includes('❯') || lastLines.includes('───────');
  }

  /**
   * Check if session shows a confirmation prompt (y/N, Enter to continue, etc.)
   */
  async hasConfirmationPrompt(sessionName: string): Promise<string | null> {
    const content = await this.capturePane(sessionName, 10);
    if (content.includes('(y/N)') || content.includes('(Y/n)')) {
      return 'y';
    }
    if (content.includes('Press Enter') || content.includes('press enter')) {
      return 'Enter';
    }
    return null;
  }

  /**
   * Check if the session has pending input in the prompt buffer (text typed but not sent).
   * Detects text after the ❯ prompt indicator on the same line or next line.
   */
  async hasPendingInput(sessionName: string): Promise<boolean> {
    const content = await this.capturePane(sessionName, 10);
    const lines = content.trim().split('\n');

    // Look for lines with text after the Claude prompt indicator
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Check if line has the prompt indicator followed by non-whitespace text
      const promptMatch = line.match(/❯\s*(.+)/);
      if (promptMatch && promptMatch[1].trim().length > 0) {
        // Has text after prompt - this is pending input
        return true;
      }

      // Also check for text between prompt line and the separator line
      if (line.includes('───────') && i > 0) {
        const prevLine = lines[i - 1].trim();
        // If the previous line has content and isn't a prompt or separator
        if (prevLine.length > 0 && !prevLine.includes('❯') && !prevLine.includes('───────') && !prevLine.includes('⏵⏵')) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Send just Enter key to submit pending input.
   */
  async sendEnter(sessionName: string): Promise<void> {
    try {
      await execa('tmux', ['send-keys', '-t', sessionName, 'Enter']);
      logger.debug(`Sent Enter to ${sessionName}`);
    } catch (err) {
      logger.error(`Failed to send Enter to ${sessionName}`, err);
      throw err;
    }
  }

  /**
   * Ensure Claude is running in the session. Restart if dropped to shell.
   * @param model - Optional model to use when restarting
   */
  async ensureClaudeRunning(sessionName: string, workDir?: string, model?: string): Promise<boolean> {
    const isShell = await this.isAtShellPrompt(sessionName);
    if (isShell) {
      logger.warn(`Session ${sessionName} dropped to shell. Restarting Claude...`);
      // Clear screen and restart
      await this.sendControlKey(sessionName, 'C-l');
      await new Promise(r => setTimeout(r, 500));

      const modelFlag = model ? ` --model ${model}` : '';
      const cmd = workDir
        ? `cd "${workDir}" && claude --dangerously-skip-permissions${modelFlag}`
        : `claude --dangerously-skip-permissions${modelFlag}`;
      await this.sendKeys(sessionName, cmd, true);

      // Wait for Claude to start and verify it's actually running
      await this.waitForClaudeReady(sessionName, 30000);
      return true; // Did restart
    }
    return false; // Was already running
  }
  
  /**
   * Wait for Claude to be ready (showing prompt or actively working).
   * @param timeoutMs - Maximum time to wait in milliseconds
   */
  async waitForClaudeReady(sessionName: string, timeoutMs: number = 30000): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 1000;
    
    while (Date.now() - startTime < timeoutMs) {
      const content = await this.capturePane(sessionName, 15);
      const lines = (content || '').trim();
      
      // Check for Claude UI indicators
      const isClaudeRunning = lines.includes('❯') && !lines.match(/❯.*\$\s*$/) || // Claude prompt without shell $ at end
                              lines.includes('⏺') || // Claude working indicator
                              lines.includes('───────') || // Claude separator
                              lines.includes('bypass permissions') || // Claude startup message
                              lines.includes('Implementing') || 
                              lines.includes('Reading') ||
                              lines.includes('Thinking') ||
                              lines.includes('Running');
      
      if (isClaudeRunning) {
        logger.debug(`Claude is ready in ${sessionName}`);
        return true;
      }
      
      // Check if we're still at shell (Claude failed to start)
      if (lines.includes('fish:') || lines.includes('command not found')) {
        logger.error(`Claude failed to start in ${sessionName} - shell error detected`);
        return false;
      }
      
      await new Promise(r => setTimeout(r, checkInterval));
    }
    
    logger.warn(`Timeout waiting for Claude to be ready in ${sessionName}`);
    return false;
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

  async attachSessionLogger(sessionName: string, logFile: string): Promise<void> {
    try {
      await mkdir(dirname(logFile), { recursive: true });
      const escaped = logFile.replace(/'/g, "'\\''");
      const command = `exec cat >> '${escaped}'`;
      await execa('tmux', ['pipe-pane', '-t', sessionName, command]);
      logger.debug(`Attached logger to ${sessionName}`, { logFile });
    } catch (err) {
      logger.warn(`Failed to attach logger to ${sessionName}`, err);
    }
  }
}
