import { parseArgs } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { Orchestrator, AuthConfig } from './orchestrator/manager.js';
import { ConfigLoader } from './config/loader.js';
import { logger, configureLogDirectory } from './utils/logger.js';

async function main(): Promise<void> {
  // Parse command line arguments
  const { values } = parseArgs({
    options: {
      config: {
        type: 'string',
        short: 'c',
        description: 'Path to config directory',
      },
      workspace: {
        type: 'string',
        short: 'w',
        description: 'Path to workspace directory',
        default: '/tmp/orchestrator-workspace',
      },
      help: {
        type: 'boolean',
        short: 'h',
        description: 'Show help',
      },
      resume: {
        type: 'boolean',
        short: 'r',
        description: 'Resume from existing workspace if possible',
        default: false,
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

  const workspaceDir = values.workspace ?? '/tmp/orchestrator-workspace';
  const logBaseDir = await resolveLogBaseDir(values.config);
  const runLogDir = await createRunLogDirectory(logBaseDir);
  configureLogDirectory(runLogDir);

  logger.info('Claude Code Orchestrator starting...', {
    configDir: values.config,
    workspaceDir,
    runLogDir,
  });

  // Load and validate configuration
  const loader = new ConfigLoader(values.config);

  let config;

  try {
    const validated = await loader.validate();
    config = validated.config;
    config.logDirectory = logBaseDir;

    logger.info('Configuration loaded', {
      repository: config.repositoryUrl,
      branch: config.branch,
      workerCount: config.workerCount,
      engineerManagerGroupSize: config.engineerManagerGroupSize,
      authMode: config.authMode,
      logDirectory: config.logDirectory,
    });
  } catch (err) {
    logger.error('Configuration error', err);
    process.exit(1);
  }

  // Load auth configs (optional - OAuth is used by default)
  const authConfigs = await loadAuthConfigs(values.config);

  if (config.authMode === 'api-keys-only' && authConfigs.length === 0) {
    logger.error('authMode "api-keys-only" is set but no auth-configs.json was found or it is empty');
    process.exit(1);
  }

  if (config.authMode === 'api-keys-first' && authConfigs.length === 0) {
    logger.warn('authMode "api-keys-first" requested but no auth-configs.json found; falling back to OAuth');
  }

  if (authConfigs.length > 0) {
    logger.info(`Loaded ${authConfigs.length} auth config(s) for rotation: ${authConfigs.map(c => c.name).join(', ')}`);
  } else {
    logger.info('No auth configs loaded - using OAuth authentication');
    logger.info('(Claude will use your local ~/.claude credentials)');
  }

  // Create orchestrator
  const orchestrator = new Orchestrator(config, workspaceDir, authConfigs, runLogDir);

  // Set up signal handlers for graceful shutdown
  setupSignalHandlers(orchestrator);

  // Start orchestrator
  try {
    await orchestrator.start(values.resume);

    // Log status periodically
    const statusInterval = setInterval(() => {
      const status = orchestrator.getStatus();
      logger.info('Orchestrator status', {
        instances: status.instances,
        costs: status.costs,
        directorQueueSize: status.directorQueueSize,
        teams: status.teams,
          hierarchyEnabled: status.hierarchyEnabled,
        authConfigsAvailable: status.authConfigsAvailable,
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

/**
 * Load auth configs from auth-configs.json in config directory.
 * Supports API keys, z.ai configs, and other auth methods.
 * Returns empty array if file doesn't exist (OAuth will be used).
 *
 * Example auth-configs.json:
 * [
 *   { "name": "api-key-1", "env": { "ANTHROPIC_API_KEY": "sk-ant-..." } },
 *   { "name": "z.ai", "env": { "ANTHROPIC_AUTH_TOKEN": "...", "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic" } }
 * ]
 */
async function loadAuthConfigs(configDir: string): Promise<AuthConfig[]> {
  // Try both file names for backwards compatibility
  const authConfigsPath = join(configDir, 'auth-configs.json');
  const legacyPath = join(configDir, 'api-keys.json');

  const configPath = existsSync(authConfigsPath) ? authConfigsPath : legacyPath;

  if (!existsSync(configPath)) {
    return [];
  }

  try {
    const content = await readFile(configPath, 'utf-8');
    const data = JSON.parse(content);

    const configs: AuthConfig[] = [];

    // Support array of AuthConfig objects
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === 'string') {
          // Legacy: plain API key string
          configs.push({
            name: `api-key-${configs.length + 1}`,
            env: { ANTHROPIC_API_KEY: item },
          });
        } else if (item.env && typeof item.env === 'object') {
          // Full AuthConfig
          configs.push({
            name: item.name || `config-${configs.length + 1}`,
            env: item.env,
          });
        } else if (item.key) {
          // Legacy: { key: "..." } format
          configs.push({
            name: item.name || `api-key-${configs.length + 1}`,
            env: { ANTHROPIC_API_KEY: item.key },
          });
        }
      }
    }

    // Support object with 'configs' or 'keys' array
    if (data.configs && Array.isArray(data.configs)) {
      for (const item of data.configs) {
        if (item.env && typeof item.env === 'object') {
          configs.push({
            name: item.name || `config-${configs.length + 1}`,
            env: item.env,
          });
        }
      }
    } else if (data.keys && Array.isArray(data.keys)) {
      // Legacy: { keys: ["sk-...", "sk-..."] }
      for (const key of data.keys) {
        if (typeof key === 'string') {
          configs.push({
            name: `api-key-${configs.length + 1}`,
            env: { ANTHROPIC_API_KEY: key },
          });
        }
      }
    }

    return configs;
  } catch (err) {
    logger.warn('Failed to load auth configs', err);
    return [];
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
Claude Code Orchestrator (Host-Native)
======================================

A distributed system for orchestrating multiple Claude Code instances to work
collaboratively on software projects. Runs directly on the host using tmux.

Usage:
  npm start -- --config <path> [--workspace <path>]
  node dist/index.js --config <path> [--workspace <path>]

Options:
  -c, --config <path>     Path to config directory (required)
  -w, --workspace <path>  Path to workspace directory (default: /tmp/orchestrator-workspace)
  -r, --resume            Resume from existing workspace if possible
  -h, --help              Show this help message

Authentication:
  By default, Claude uses your local OAuth credentials (~/.claude).
  To control auth startup/rotation, set authMode in orchestrator.json:
    - oauth (default): start with OAuth, then rotate into auth-configs.json
    - api-keys-first: start with first entry in auth-configs.json, then OAuth
    - api-keys-only: use only auth-configs.json (required)
  Provide auth-configs.json (or legacy api-keys.json) to supply API keys.

Config Directory Structure:
  <config-dir>/
  ├── orchestrator.json    Main orchestrator settings (required)
  └── auth-configs.json    Auth configurations for rotation (optional)

Example orchestrator.json:
  {
    "repositoryUrl": "https://github.com/org/repo.git",
    "branch": "main",
    "workerCount": 3
  }

Example auth-configs.json (optional):
  [
    {
      "name": "api-key-1",
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    },
    {
      "name": "z.ai",
      "env": {
        "ANTHROPIC_AUTH_TOKEN": "your-z-ai-token",
        "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic"
      }
    }
  ]

For more information, see the documentation.
`);
}

async function resolveLogBaseDir(configDir: string): Promise<string> {
  const configPath = join(configDir, 'orchestrator.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const configured = typeof parsed.logDirectory === 'string' ? parsed.logDirectory.trim() : '';
    if (configured.length > 0) {
      return isAbsolute(configured) ? configured : join(configDir, configured);
    }
  } catch {
    // Ignore and fall back to config dir
  }
  return configDir;
}

async function createRunLogDirectory(baseDir: string): Promise<string> {
  await mkdir(baseDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(baseDir, `run-${timestamp}`);
  await mkdir(runDir, { recursive: true });
  return runDir;
}

// Run main
main().catch((err) => {
  logger.error('Fatal error', err);
  process.exit(1);
});
