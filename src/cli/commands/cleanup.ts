import chalk from 'chalk';
import { execSync } from 'child_process';

export async function cleanupCommand(options: { config?: string }): Promise<void> {
  console.log(chalk.cyan('Cleaning up Claude Code Orchestrator resources...\n'));

  // Kill all orchestrator tmux sessions
  console.log(chalk.yellow('Killing tmux sessions...'));
  try {
    const sessions = execSync('tmux list-sessions 2>/dev/null || true', { encoding: 'utf-8' });
    const orchestratorSessions = sessions
      .split('\n')
      .filter(line => line.startsWith('claude-'))
      .map(line => line.split(':')[0]);

    if (orchestratorSessions.length === 0) {
      console.log(chalk.gray('  No orchestrator sessions found'));
    } else {
      for (const session of orchestratorSessions) {
        console.log(chalk.gray(`  Killing session: ${session}`));
        try {
          execSync(`tmux kill-session -t "${session}" 2>/dev/null`, { encoding: 'utf-8' });
        } catch {
          // Session may already be dead
        }
      }
    }
    console.log(chalk.green('  Done\n'));
  } catch {
    console.log(chalk.gray('  No tmux sessions found\n'));
  }

  // Clean up workspace
  const workspacePath = '/tmp/orchestrator-workspace';
  console.log(chalk.yellow('Cleaning up workspace...'));
  try {
    const fs = await import('fs');
    if (fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
      console.log(chalk.gray(`  Removed ${workspacePath}`));
    } else {
      console.log(chalk.gray('  No workspace directory found'));
    }
    console.log(chalk.green('  Done\n'));
  } catch (error) {
    console.log(chalk.red(`  Failed to clean workspace: ${error}\n`));
  }

  console.log(chalk.green('Cleanup complete!'));
}
