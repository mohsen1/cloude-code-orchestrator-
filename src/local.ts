/**
 * Local runner entry point - runs without Docker using host's OAuth auth.
 * Supports API key rotation when rate limited.
 */

import { parseArgs } from 'node:util';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { LocalOrchestrator, ApiKeyConfig } from './orchestrator/local-runner.js';
import { ConfigLoader } from './config/loader.js';
import { logger } from './utils/logger.js';

async function loadApiKeyConfigs(configDir: string): Promise<ApiKeyConfig[]> {
  const apiKeysPath = join(configDir, 'api-keys.json');

  if (!existsSync(apiKeysPath)) {
    logger.info('No api-keys.json found, using OAuth only');
    return [];
  }

  try {
    const raw = await readFile(apiKeysPath, 'utf-8');
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      logger.warn('api-keys.json should be an array, using OAuth only');
      return [];
    }

    const configs: ApiKeyConfig[] = parsed.map((item: any, i: number) => ({
      name: item.name || `api-key-${i + 1}`,
      env: item.env || {},
    }));

    logger.info(`Loaded ${configs.length} API key configs for rotation`);
    return configs;
  } catch (err) {
    logger.warn('Failed to load api-keys.json', err);
    return [];
  }
}

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
Automatically rotates between OAuth and API keys when rate limited.

Usage:
  npm run local -- --config <path> [--workspace <path>]

Options:
  -c, --config <path>     Path to config directory (required)
  -w, --workspace <path>  Workspace directory (default: /tmp/orchestrator-workspace)
  -h, --help              Show this help

Config Directory Structure:
  <config-dir>/
    orchestrator.json     Main configuration
    api-keys.json         Optional API keys for rotation

api-keys.json format:
  [
    { "name": "key-1", "env": { "ANTHROPIC_API_KEY": "sk-ant-..." } },
    { "name": "z.ai-1", "env": { "ANTHROPIC_AUTH_TOKEN": "...", "ANTHROPIC_BASE_URL": "..." } }
  ]

Rate Limit Rotation:
  When rate limited, the system automatically cycles through:
  1. OAuth (default) -> 2. API Key 1 -> 3. API Key 2 -> ... -> back to OAuth
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

  // Load API key configs for rotation
  const apiKeyConfigs = await loadApiKeyConfigs(values.config);

  // Create and start orchestrator
  const orchestrator = new LocalOrchestrator(config, workspaceDir, apiKeyConfigs);

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
