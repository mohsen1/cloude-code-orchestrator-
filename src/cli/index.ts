#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { startCommand } from './commands/start.js';
import { pauseCommand } from './commands/pause.js';
import { resumeCommand } from './commands/resume.js';
import { cleanupCommand } from './commands/cleanup.js';

const program = new Command();

program
  .name('cco')
  .description(chalk.cyan('Claude Code Orchestrator (V2)') + ' - Orchestrate multiple Claude instances using --print mode')
  .version('2.0.0');

// Default command: interactive start or start with config
program
  .command('start', { isDefault: true })
  .description('Start the orchestrator (interactive if no config provided)')
  .option('-c, --config <path>', 'Path to config directory')
  .option('-w, --workspace <path>', 'Path to workspace directory')
  .action(startCommand);

// Pause command
program
  .command('pause')
  .description('Gracefully pause the orchestrator')
  .option('-c, --config <path>', 'Path to config directory')
  .option('-t, --timeout <seconds>', 'Timeout in seconds to wait for acknowledgment', '120')
  .action(pauseCommand);

// Resume command
program
  .command('resume')
  .description('Resume a paused orchestrator')
  .option('-c, --config <path>', 'Path to config directory')
  .action(resumeCommand);

// Cleanup command
program
  .command('cleanup')
  .description('Clean up orphaned worktrees from previous runs')
  .option('-c, --config <path>', 'Path to config directory')
  .action(cleanupCommand);

program.parse();
