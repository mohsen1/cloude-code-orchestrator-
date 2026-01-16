import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { V2Orchestrator } from '../../v2/index.js';
import type { AuthConfig, V2OrchestratorConfig } from '../../v2/types.js';
import { ConfigLoader } from '../../config/loader.js';
import { logger, configureLogDirectory } from '../../utils/logger.js';
import { extractRepoName } from '../../utils/repo.js';

interface StartOptions {
  config?: string;
  workspace?: string;
}

/**
 * Interactive prompts for configuration
 */
async function runInteractiveSetup(): Promise<{ configDir: string; workspaceDir: string }> {
  console.log(chalk.cyan('\n🚀 Claude Code Orchestrator (V2) - Interactive Setup\n'));

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'repositoryUrl',
      message: 'Repository URL:',
      validate: (input: string) => {
        if (!input.trim()) return 'Repository URL is required';
        if (!input.match(/^(https?:\/\/|git@)/)) return 'Must be a valid git URL (HTTPS or SSH)';
        return true;
      },
    },
    {
      type: 'input',
      name: 'branch',
      message: 'Branch:',
      default: 'main',
    },
    {
      type: 'number',
      name: 'workerCount',
      message: 'Number of workers:',
      default: 2,
      validate: (input: number) => {
        if (input < 1 || input > 20) return 'Worker count must be between 1 and 20';
        return true;
      },
    },
    {
      type: 'list',
      name: 'authMode',
      message: 'Authentication mode:',
      choices: [
        { name: 'OAuth (use ~/.claude credentials)', value: 'oauth' },
        { name: 'API Keys First (fall back to OAuth)', value: 'api-keys-first' },
        { name: 'API Keys Only', value: 'api-keys-only' },
      ],
      default: 'oauth',
    },
  ]);

  // Create temporary config directory
  const repoName = extractRepoName(answers.repositoryUrl);
  const timestamp = Date.now();
  const configDir = join(tmpdir(), `cco-${repoName}-${timestamp}`);
  const workspaceDir = join(configDir, 'workspace');

  await mkdir(configDir, { recursive: true });

  // Write orchestrator.json
  const config = {
    repositoryUrl: answers.repositoryUrl,
    branch: answers.branch,
    workerCount: answers.workerCount,
    authMode: answers.authMode,
    workspaceDir,
  };

  await writeFile(join(configDir, 'orchestrator.json'), JSON.stringify(config, null, 2));

  console.log(chalk.green(`\n✓ Config created at: ${configDir}`));
  console.log(chalk.gray(`  Workspace will be at: ${workspaceDir}\n`));

  // If api-keys-only, prompt for API key
  if (answers.authMode === 'api-keys-only') {
    const keyAnswer = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter Anthropic API key:',
        mask: '*',
        validate: (input: string) => input.trim().length > 0 || 'API key is required for api-keys-only mode',
      },
    ]);

    const apiKeys = [{ name: 'api-key-1', apiKey: keyAnswer.apiKey }];
    await writeFile(join(configDir, 'api-keys.json'), JSON.stringify(apiKeys, null, 2));
    console.log(chalk.green('✓ API key saved'));
  }

  return { configDir, workspaceDir };
}

/**
 * Load auth configs from api-keys.json in config directory.
 */
async function loadAuthConfigs(configDir: string): Promise<AuthConfig[]> {
  const configPath = join(configDir, 'api-keys.json');
  const legacyPath = join(configDir, 'auth-configs.json');
  const finalPath = existsSync(configPath) ? configPath : legacyPath;

  if (!existsSync(finalPath)) {
    return [];
  }

  try {
    const content = await readFile(finalPath, 'utf-8');
    const data = JSON.parse(content);
    const configs: AuthConfig[] = [];

    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === 'string') {
          // Plain API key string
          configs.push({ name: `api-key-${configs.length + 1}`, apiKey: item });
        } else if (item.apiKey) {
          // V2 format: { name, apiKey }
          configs.push({ name: item.name || `api-key-${configs.length + 1}`, apiKey: item.apiKey });
        } else if (item.key) {
          // Legacy format: { name, key }
          configs.push({ name: item.name || `api-key-${configs.length + 1}`, apiKey: item.key });
        } else if (item.env?.ANTHROPIC_API_KEY) {
          // Legacy env format
          configs.push({ name: item.name || `api-key-${configs.length + 1}`, apiKey: item.env.ANTHROPIC_API_KEY });
        }
      }
    }

    return configs;
  } catch (err) {
    logger.warn('Failed to load auth configs', err);
    return [];
  }
}

/**
 * Resolve log base directory from config
 */
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
    // Fall back to config dir
  }
  return configDir;
}

/**
 * Create timestamped run log directory
 */
async function createRunLogDirectory(baseDir: string): Promise<string> {
  await mkdir(baseDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(baseDir, `run-${timestamp}`);
  await mkdir(runDir, { recursive: true });
  return runDir;
}

/**
 * Set up signal handlers for graceful shutdown
 */
function setupSignalHandlers(orchestrator: V2Orchestrator): void {
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

/**
 * Start command handler
 */
export async function startCommand(options: StartOptions): Promise<void> {
  let configDir: string;
  let workspaceDir: string | undefined;

  // If no config provided, run interactive setup
  if (!options.config) {
    const setup = await runInteractiveSetup();
    configDir = setup.configDir;
    workspaceDir = setup.workspaceDir;
  } else {
    configDir = options.config;
    workspaceDir = options.workspace;
  }

  const logBaseDir = await resolveLogBaseDir(configDir);
  const runLogDir = await createRunLogDirectory(logBaseDir);
  configureLogDirectory(runLogDir);

  // Load and validate configuration
  const loader = new ConfigLoader(configDir);
  let config;

  try {
    const validated = await loader.validate();
    config = validated.config;
    config.logDirectory = logBaseDir;

    // Use workspaceDir from config if available, otherwise from CLI, otherwise generate
    if (!workspaceDir) {
      if (config.workspaceDir) {
        workspaceDir = config.workspaceDir;
      } else {
        const repoName = extractRepoName(config.repositoryUrl);
        workspaceDir = join(tmpdir(), `cco-workspace-${repoName}-${Date.now()}`);
      }
    }

    logger.info('Claude Code Orchestrator (V2) starting...', {
      configDir,
      workspaceDir,
      runLogDir,
    });

    logger.info('Configuration loaded', {
      repository: config.repositoryUrl,
      branch: config.branch,
      workerCount: config.workerCount,
      engineerManagerGroupSize: config.engineerManagerGroupSize,
      authMode: config.authMode,
      taskTimeoutMs: config.taskTimeoutMs,
      pollIntervalMs: config.pollIntervalMs,
    });
  } catch (err) {
    logger.error('Configuration error', err);
    process.exit(1);
  }

  // Load auth configs
  const authConfigs = await loadAuthConfigs(configDir);

  if (config.authMode === 'api-keys-only' && authConfigs.length === 0) {
    logger.error('authMode "api-keys-only" is set but no api-keys.json was found or it is empty');
    process.exit(1);
  }

  if (config.authMode === 'api-keys-first' && authConfigs.length === 0) {
    logger.warn('authMode "api-keys-first" requested but no api-keys.json found; falling back to OAuth');
  }

  if (authConfigs.length > 0) {
    logger.info(`Loaded ${authConfigs.length} auth config(s) for rotation: ${authConfigs.map((c) => c.name).join(', ')}`);
  } else {
    logger.info('No auth configs loaded - using OAuth authentication');
  }

  // Build V2 config
  const v2Config: V2OrchestratorConfig = {
    repositoryUrl: config.repositoryUrl,
    branch: config.branch,
    workerCount: config.workerCount,
    workspaceDir: workspaceDir!,
    logDirectory: config.logDirectory,
    model: config.model,
    authMode: config.authMode,
    engineerManagerGroupSize: config.engineerManagerGroupSize,
    taskTimeoutMs: config.taskTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    maxToolUsesPerInstance: config.maxToolUsesPerInstance,
    maxTotalToolUses: config.maxTotalToolUses,
    maxRunDurationMinutes: config.maxRunDurationMinutes,
    envFiles: config.envFiles,
    cloneDepth: config.cloneDepth,
    useRunBranch: config.useRunBranch,
  };

  // Create pause signal path
  const pauseSignalPath = join(configDir, 'pause.signal');

  // Create and start orchestrator
  const orchestrator = new V2Orchestrator(v2Config, authConfigs, pauseSignalPath);
  setupSignalHandlers(orchestrator);

  try {
    // For now, start without tasks - tasks will be loaded from the project
    // In a real implementation, you'd load tasks from a task file or API
    await orchestrator.start();

    // Log status periodically
    const statusIntervalMs = config.pollIntervalMs * 6; // Every 30 seconds by default
    const statusInterval = setInterval(() => {
      const status = orchestrator.getStatus();
      logger.info('Orchestrator status', {
        mode: status.mode,
        isRunning: status.isRunning,
        isPaused: status.isPaused,
        totalTasks: status.totalTasks,
        completedTasks: status.completedTasks,
        failedTasks: status.failedTasks,
        pendingTasks: status.pendingTasks,
        runDurationMinutes: status.runDurationMinutes.toFixed(1),
        workers: status.workers.map((w) => ({
          id: w.id,
          status: w.status,
          task: w.currentTaskTitle || 'idle',
        })),
      });
    }, statusIntervalMs);

    process.on('exit', () => clearInterval(statusInterval));
  } catch (err) {
    logger.error('Failed to start orchestrator', err);
    process.exit(1);
  }
}
