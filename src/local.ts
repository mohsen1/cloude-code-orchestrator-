/**
 * Local runner entry point - runs without Docker using host's OAuth auth.
 */

import { parseArgs } from 'node:util';
import { LocalOrchestrator } from './orchestrator/local-runner.js';
import { ConfigLoader } from './config/loader.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      workspace: { type: 'string', short: 'w' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(`
Local Claude Code Orchestrator (No Docker)
===========================================

Runs Claude Code instances directly using host authentication.

Usage:
  npm run local -- --config <path> [--workspace <path>]

Options:
  -c, --config <path>     Path to config directory (required)
  -w, --workspace <path>  Workspace directory (default: /tmp/orchestrator-workspace)
  -h, --help              Show this help
`);
    process.exit(0);
  }

  if (!values.config) {
    console.error('Error: --config is required');
    process.exit(1);
  }

  const workspaceDir = values.workspace || '/tmp/orchestrator-workspace';

  logger.info('Starting local orchestrator...', { configDir: values.config, workspaceDir });

  // Load config
  const loader = new ConfigLoader(values.config);
  const { config } = await loader.validate();

  // Create and start orchestrator
  const orchestrator = new LocalOrchestrator(config, workspaceDir);

  // Signal handlers
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await orchestrator.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await orchestrator.start();

  // Keep running
  logger.info('Orchestrator running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  logger.error('Fatal error', err);
  process.exit(1);
});
