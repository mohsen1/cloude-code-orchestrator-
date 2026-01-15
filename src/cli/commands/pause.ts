import chalk from 'chalk';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

interface PauseOptions {
  config?: string;
  timeout?: string;
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Pause command handler
 * 
 * Writes a pause signal file that the orchestrator will detect
 * and gracefully pause operations. Waits for acknowledgment before exiting.
 */
export async function pauseCommand(options: PauseOptions): Promise<void> {
  console.log(chalk.cyan('\n⏸️  Claude Code Orchestrator - Pause\n'));
  
  if (!options.config) {
    console.log(chalk.red('Error: --config is required to identify which orchestrator to pause'));
    console.log(chalk.gray('Usage: cco pause --config <path>'));
    process.exit(1);
  }
  
  const configDir = options.config;
  const stateFile = join(configDir, 'state.json');
  const timeoutMs = parseInt(options.timeout ?? '120', 10) * 1000; // Default 2 minutes
  
  // Check if orchestrator.json exists
  if (!existsSync(join(configDir, 'orchestrator.json'))) {
    console.log(chalk.red(`Error: No orchestrator.json found in ${configDir}`));
    process.exit(1);
  }
  
  // Read or create state file
  let state: Record<string, unknown> = {};
  if (existsSync(stateFile)) {
    try {
      state = JSON.parse(await readFile(stateFile, 'utf-8'));
    } catch {
      state = {};
    }
  }
  
  // Check if already paused and acknowledged
  if (state.paused && state.acknowledgedAt) {
    console.log(chalk.yellow('⚠️  Orchestrator is already paused'));
    console.log(chalk.gray(`  Paused at: ${state.pausedAt}`));
    console.log(chalk.gray(`  Acknowledged at: ${state.acknowledgedAt}`));
    return;
  }
  
  // Set paused flag (clear any previous acknowledgment)
  state.paused = true;
  state.pausedAt = new Date().toISOString();
  delete state.acknowledgedAt;
  
  await writeFile(stateFile, JSON.stringify(state, null, 2));
  
  console.log(chalk.yellow('⏳ Pause signal sent, waiting for orchestrator to acknowledge...'));
  console.log(chalk.gray(`  (timeout: ${timeoutMs / 1000}s)`));
  
  // Wait for acknowledgment
  const startTime = Date.now();
  let acknowledged = false;
  let dots = 0;
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      const currentState = JSON.parse(await readFile(stateFile, 'utf-8'));
      if (currentState.acknowledgedAt) {
        acknowledged = true;
        state = currentState;
        break;
      }
    } catch {
      // Ignore read errors
    }
    
    // Show progress
    dots = (dots + 1) % 4;
    process.stdout.write(`\r${chalk.gray('  Waiting' + '.'.repeat(dots) + ' '.repeat(3 - dots))}  `);
    
    await sleep(1000);
  }
  
  process.stdout.write('\r' + ' '.repeat(20) + '\r'); // Clear progress line
  
  if (acknowledged) {
    console.log(chalk.green('\n✅ Orchestrator paused successfully!'));
    console.log(chalk.gray(`  Paused at: ${state.pausedAt}`));
    console.log(chalk.gray(`  Acknowledged at: ${state.acknowledgedAt}`));
    if (state.instanceCount) {
      console.log(chalk.gray(`  Instances preserved: ${state.instanceCount}`));
    }
    console.log();
    console.log(chalk.white('To resume: cco resume --config ' + configDir));
  } else {
    console.log(chalk.red('\n⚠️  Timeout waiting for orchestrator acknowledgment'));
    console.log(chalk.gray('  The pause signal was written but the orchestrator did not acknowledge it.'));
    console.log(chalk.gray('  Possible reasons:'));
    console.log(chalk.gray('    - Orchestrator is not running'));
    console.log(chalk.gray('    - Orchestrator is stuck or unresponsive'));
    console.log(chalk.gray('    - Network/filesystem issues'));
    console.log();
    console.log(chalk.yellow('  The pause signal remains in place. You can:'));
    console.log(chalk.gray('    1. Wait and try "cco pause" again to check status'));
    console.log(chalk.gray('    2. Use "cco status" to check orchestrator state'));
    console.log(chalk.gray('    3. Manually kill and restart the orchestrator'));
    process.exit(1);
  }
}
