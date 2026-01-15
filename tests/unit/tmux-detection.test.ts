import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TmuxManager } from '../../src/tmux/session.js';

// Mock execa
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

describe('TmuxManager detection methods', () => {
  let tmux: TmuxManager;
  let execaMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmux = new TmuxManager();
    const { execa } = await import('execa');
    execaMock = execa as ReturnType<typeof vi.fn>;
    execaMock.mockReset();
  });

  describe('isAtShellPrompt', () => {
    it('should detect bash prompt', async () => {
      execaMock.mockResolvedValue({
        stdout: 'some output\nuser@host:~/code$ ',
      });

      const result = await tmux.isAtShellPrompt('test-session');
      expect(result).toBe(true);
    });

    it('should detect root prompt', async () => {
      execaMock.mockResolvedValue({
        stdout: 'some output\nroot@host:/# ',
      });

      const result = await tmux.isAtShellPrompt('test-session');
      expect(result).toBe(true);
    });

    it('should detect fish shell prompt', async () => {
      // Fish shell has a specific format with ❯ AND $ on the same line
      execaMock.mockResolvedValue({
        stdout: '/p/t/o/w/worker-2 ❯ worker-2 $ ',
      });

      const result = await tmux.isAtShellPrompt('test-session');
      expect(result).toBe(true);
    });

    it('should detect fish error messages', async () => {
      execaMock.mockResolvedValue({
        stdout: 'fish: Unknown command: You\n/p/t/o/w/worker-2 ❯ worker-2 $ ',
      });

      const result = await tmux.isAtShellPrompt('test-session');
      expect(result).toBe(true);
    });

    it('should not detect Claude prompt as shell', async () => {
      execaMock.mockResolvedValue({
        stdout: 'Claude output\n❯ ',
      });

      const result = await tmux.isAtShellPrompt('test-session');
      expect(result).toBe(false);
    });

    it('should not detect Claude output indicator as shell', async () => {
      execaMock.mockResolvedValue({
        stdout: '⏺ Writing file...\n',
      });

      const result = await tmux.isAtShellPrompt('test-session');
      expect(result).toBe(false);
    });
  });

  describe('isAtClaudePrompt', () => {
    it('should detect Claude prompt with arrow', async () => {
      execaMock.mockResolvedValue({
        stdout: 'Output\n❯ ',
      });

      const result = await tmux.isAtClaudePrompt('test-session');
      expect(result).toBe(true);
    });

    it('should detect Claude prompt with separator', async () => {
      execaMock.mockResolvedValue({
        stdout: 'Output\n───────────────────────────────\n',
      });

      const result = await tmux.isAtClaudePrompt('test-session');
      expect(result).toBe(true);
    });

    it('should not detect shell prompt as Claude', async () => {
      execaMock.mockResolvedValue({
        stdout: 'user@host:~$ ',
      });

      const result = await tmux.isAtClaudePrompt('test-session');
      expect(result).toBe(false);
    });
  });

  describe('hasConfirmationPrompt', () => {
    it('should detect y/N prompt', async () => {
      execaMock.mockResolvedValue({
        stdout: 'Do you want to continue? (y/N) ',
      });

      const result = await tmux.hasConfirmationPrompt('test-session');
      expect(result).toBe('y');
    });

    it('should detect Y/n prompt', async () => {
      execaMock.mockResolvedValue({
        stdout: 'Proceed? (Y/n) ',
      });

      const result = await tmux.hasConfirmationPrompt('test-session');
      expect(result).toBe('y');
    });

    it('should detect Press Enter prompt', async () => {
      execaMock.mockResolvedValue({
        stdout: 'Press Enter to continue...',
      });

      const result = await tmux.hasConfirmationPrompt('test-session');
      expect(result).toBe('Enter');
    });

    it('should return null for no confirmation prompt', async () => {
      execaMock.mockResolvedValue({
        stdout: 'Regular output here',
      });

      const result = await tmux.hasConfirmationPrompt('test-session');
      expect(result).toBeNull();
    });
  });

  describe('ensureClaudeRunning', () => {
    it('should restart Claude when at shell prompt', async () => {
      // First call: isAtShellPrompt -> capturePane returns shell prompt
      execaMock.mockResolvedValueOnce({
        stdout: 'user@host:~$ ',
      });
      // sendControlKey for C-l
      execaMock.mockResolvedValueOnce({});
      // sendKeys for claude command
      execaMock.mockResolvedValueOnce({});
      // sendKeys Enter
      execaMock.mockResolvedValueOnce({});
      // waitForClaudeReady -> capturePane returns Claude UI
      execaMock.mockResolvedValueOnce({
        stdout: '❯ \n───────\nbypass permissions on',
      });

      const result = await tmux.ensureClaudeRunning('test-session', '/workspace');

      expect(result).toBe(true);
      // Should have sent control key, command, etc.
      expect(execaMock).toHaveBeenCalledWith('tmux', ['send-keys', '-t', 'test-session', 'C-l']);
    });

    it('should not restart when Claude is running', async () => {
      // capturePane returns Claude prompt (isAtShellPrompt checks)
      execaMock.mockResolvedValueOnce({
        stdout: '❯ \n───────\nbypass permissions',
      });

      const result = await tmux.ensureClaudeRunning('test-session');

      expect(result).toBe(false);
    });
  });
});
