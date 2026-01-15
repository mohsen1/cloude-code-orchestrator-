#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { startCommand } from './commands/start.js';
import { viewCommand } from './commands/view.js';
import { pauseCommand } from './commands/pause.js';
import { resumeCommand } from './commands/resume.js';

const program = new Command();

program
  .name('cco')
  .description(chalk.cyan('Claude Code Orchestrator') + ' - Orchestrate multiple Claude instances')
  .version('1.0.0');

// Default command: interactive start or start with config
program
  .command('start', { isDefault: true })
  .description('Start the orchestrator (interactive if no config provided)')
  .option('-c, --config <path>', 'Path to config directory')
  .option('-w, --workspace <path>', 'Path to workspace directory')
  .action(startCommand);

// View command: tmux cockpit
program
  .command('view')
  .description('View all active orchestrator sessions in a tmux cockpit')
  .option('-c, --config <path>', 'Path to config directory (to identify sessions)')
  .action(viewCommand);

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

program.parse();
