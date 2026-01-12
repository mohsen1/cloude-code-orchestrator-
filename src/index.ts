import { parseArgs } from 'node:util';
import { Orchestrator } from './orchestrator/manager.js';
import { ConfigLoader } from './config/loader.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  // Parse command line arguments
  const { values } = parseArgs({
    options: {
      config: {
        type: 'string',
        short: 'c',
        description: 'Path to config directory',
      },
      help: {
        type: 'boolean',
        short: 'h',
        description: 'Show help',
      },
    },
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  if (!values.config) {
    console.error('Error: --config option is required');
    console.error('');
    printHelp();
    process.exit(1);
  }

  // Check for API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required');
    console.error('Set it with: export ANTHROPIC_API_KEY="your-api-key"');
    process.exit(1);
  }

  logger.info('Claude Code Orchestrator starting...', {
    configDir: values.config,
  });

  // Load and validate configuration
  const loader = new ConfigLoader(values.config);

  let config;

  try {
    const validated = await loader.validate();
    config = validated.config;

    logger.info('Configuration loaded', {
      repository: config.repositoryUrl,
      branch: config.branch,
      workerCount: config.workerCount,
    });
  } catch (err) {
    logger.error('Configuration error', err);
    process.exit(1);
  }

  // Create orchestrator
  const orchestrator = new Orchestrator(config);

  // Set up signal handlers for graceful shutdown
  setupSignalHandlers(orchestrator);

  // Start orchestrator
  try {
    await orchestrator.start();

    // Log status periodically
    const statusInterval = setInterval(() => {
      const status = orchestrator.getStatus();
      logger.info('Orchestrator status', {
        instances: status.instances,
        tasks: status.tasks,
        health: status.health,
        costs: status.costs,
      });
    }, 60000);

    // Handle cleanup of status interval on shutdown
    process.on('exit', () => {
      clearInterval(statusInterval);
    });
  } catch (err) {
    logger.error('Failed to start orchestrator', err);
    process.exit(1);
  }
}

function setupSignalHandlers(orchestrator: Orchestrator): void {
  let isShuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      logger.warn('Shutdown already in progress, forcing exit...');
      process.exit(1);
    }

    isShuttingDown = true;
    logger.info(`Received ${signal}, initiating graceful shutdown...`);

    try {
      await orchestrator.shutdown();
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', async (err) => {
    logger.error('Uncaught exception', err);
    await orchestrator.shutdown();
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason) => {
    logger.error('Unhandled rejection', reason);
    await orchestrator.shutdown();
    process.exit(1);
  });
}

function printHelp(): void {
  console.log(`
Claude Code Orchestrator
========================

A distributed system for orchestrating multiple Claude Code instances to work
collaboratively on software projects.

Usage:
  npm start -- --config <path>
  node dist/index.js --config <path>

Options:
  -c, --config <path>  Path to config directory (required)
  -h, --help           Show this help message

Config Directory Structure:
  <config-dir>/
  ├── orchestrator.json   Main orchestrator settings
  └── api-keys.json       API key configuration (optional)

Example orchestrator.json:
  {
    "repositoryUrl": "https://github.com/org/repo.git",
    "branch": "main",
    "workerCount": 3
  }

For more information, see the documentation at:
https://github.com/your-org/claude-code-orchestrator
`);
}

// Run main
main().catch((err) => {
  logger.error('Fatal error', err);
  process.exit(1);
});
