/**
 * Manages Claude Code configuration for local (non-Docker) mode.
 * Alternates between OAuth (empty settings) and API key configs when rate limited.
 */

import { readFile, writeFile, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { logger } from '../utils/logger.js';

export interface ApiKeyConfig {
  name: string;
  // Environment variables to apply (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, etc.)
  env: {
    ANTHROPIC_API_KEY?: string;
    ANTHROPIC_AUTH_TOKEN?: string;
    ANTHROPIC_BASE_URL?: string;
    [key: string]: string | undefined;
  };
}

interface ConfigState {
  type: 'oauth' | 'apikey';
  configIndex?: number; // Which API key config is active
  rateLimitedUntil?: Date;
}

export class LocalConfigManager {
  private claudeSettingsPath: string;
  private originalSettings: string | null = null;
  private apiKeyConfigs: ApiKeyConfig[] = [];
  private configStates: Map<string, ConfigState> = new Map(); // instanceId -> state
  private rateLimitCooldownMinutes: number;
  private hookServerPort: number;

  constructor(apiKeyConfigs: ApiKeyConfig[] = [], rateLimitCooldownMinutes: number = 60, hookServerPort: number = 3000) {
    this.claudeSettingsPath = join(homedir(), '.claude', 'settings.json');
    this.apiKeyConfigs = apiKeyConfigs;
    this.rateLimitCooldownMinutes = rateLimitCooldownMinutes;
    this.hookServerPort = hookServerPort;
  }

  /**
   * Generate the hooks configuration for Claude Code settings.
   * Hooks detect instance from tmux session name and POST to orchestrator.
   */
  private getHooksConfig(): Record<string, string> {
    // Single-line bash script with proper if/then/fi syntax
    const hookScript = (hookName: string) =>
      `SESSION=$(tmux display-message -p '#S' 2>/dev/null || echo 'unknown'); ` +
      `if [[ $SESSION == "claude-manager" ]]; then INSTANCE_ID="manager"; WORKER_ID=0; TYPE="manager"; ` +
      `elif [[ $SESSION == claude-worker-* ]]; then INSTANCE_ID="\${SESSION#claude-}"; WORKER_ID="\${SESSION#claude-worker-}"; TYPE="worker"; ` +
      `else exit 0; fi; ` +
      `curl -s -X POST "http://localhost:${this.hookServerPort}/hooks/${hookName}" ` +
      `-H "Content-Type: application/json" ` +
      `-d "{\\"instance_id\\":\\"$INSTANCE_ID\\",\\"worker_id\\":$WORKER_ID,\\"instance_type\\":\\"$TYPE\\"}" &`;

    return {
      Stop: hookScript('stop'),
      PostToolUse: hookScript('tool_use'),
    };
  }

  /**
   * Initialize - backup original settings.
   */
  async initialize(): Promise<void> {
    if (existsSync(this.claudeSettingsPath)) {
      this.originalSettings = await readFile(this.claudeSettingsPath, 'utf-8');
      logger.info('Backed up original Claude settings');
    } else {
      this.originalSettings = '{}';
    }

    logger.info(`LocalConfigManager initialized`, {
      apiKeyConfigs: this.apiKeyConfigs.length,
      hasOAuth: true, // OAuth is always available as fallback
    });
  }

  /**
   * Get initial config for an instance - start with OAuth.
   */
  async assignConfig(instanceId: string): Promise<'oauth' | 'apikey'> {
    // Start with OAuth (empty settings)
    this.configStates.set(instanceId, { type: 'oauth' });
    await this.applyOAuthConfig();
    logger.info(`Instance ${instanceId} using OAuth authentication`);
    return 'oauth';
  }

  /**
   * Rotate config when rate limited.
   * Alternates: OAuth -> API Key 1 -> API Key 2 -> ... -> OAuth
   */
  async rotateConfig(instanceId: string): Promise<{ type: 'oauth' | 'apikey'; name?: string } | null> {
    const currentState = this.configStates.get(instanceId);

    if (!currentState) {
      return this.assignConfig(instanceId).then(type => ({ type }));
    }

    // Mark current config as rate limited
    const cooldownUntil = new Date(Date.now() + this.rateLimitCooldownMinutes * 60 * 1000);

    if (currentState.type === 'oauth') {
      // OAuth rate limited, try first API key
      if (this.apiKeyConfigs.length > 0) {
        const config = this.apiKeyConfigs[0];
        await this.applyApiKeyConfig(config);
        this.configStates.set(instanceId, {
          type: 'apikey',
          configIndex: 0,
          rateLimitedUntil: cooldownUntil
        });
        logger.info(`Instance ${instanceId} rotated to API key: ${config.name}`);
        return { type: 'apikey', name: config.name };
      } else {
        // No API keys available, stay on OAuth (will hit rate limit again)
        logger.warn(`Instance ${instanceId} has no API keys to rotate to`);
        return null;
      }
    } else {
      // API key rate limited, try next API key or fall back to OAuth
      const nextIndex = (currentState.configIndex ?? 0) + 1;

      if (nextIndex < this.apiKeyConfigs.length) {
        const config = this.apiKeyConfigs[nextIndex];
        await this.applyApiKeyConfig(config);
        this.configStates.set(instanceId, {
          type: 'apikey',
          configIndex: nextIndex,
          rateLimitedUntil: cooldownUntil
        });
        logger.info(`Instance ${instanceId} rotated to API key: ${config.name}`);
        return { type: 'apikey', name: config.name };
      } else {
        // All API keys exhausted, check if OAuth cooldown expired
        const oauthState = this.getOAuthCooldownState();
        if (!oauthState || oauthState < new Date()) {
          await this.applyOAuthConfig();
          this.configStates.set(instanceId, { type: 'oauth' });
          logger.info(`Instance ${instanceId} rotated back to OAuth`);
          return { type: 'oauth' };
        } else {
          // All configs rate limited
          logger.error(`Instance ${instanceId} - all configs rate limited`);
          return null;
        }
      }
    }
  }

  /**
   * Apply OAuth config (empty/minimal settings).
   */
  private async applyOAuthConfig(): Promise<void> {
    const settings = { hooks: this.getHooksConfig() };
    await writeFile(this.claudeSettingsPath, JSON.stringify(settings, null, 2));
    logger.debug('Applied OAuth config with hooks');
  }

  /**
   * Apply API key config by writing env vars to Claude settings.
   */
  private async applyApiKeyConfig(config: ApiKeyConfig): Promise<void> {
    const settings = { env: config.env, hooks: this.getHooksConfig() };
    await writeFile(this.claudeSettingsPath, JSON.stringify(settings, null, 2));
    logger.debug(`Applied API key config: ${config.name}`);
  }

  /**
   * Get OAuth cooldown state (when it was last rate limited).
   */
  private getOAuthCooldownState(): Date | null {
    for (const state of this.configStates.values()) {
      if (state.type === 'oauth' && state.rateLimitedUntil) {
        return state.rateLimitedUntil;
      }
    }
    return null;
  }

  /**
   * Get current config type for an instance.
   */
  getConfigType(instanceId: string): 'oauth' | 'apikey' | null {
    return this.configStates.get(instanceId)?.type ?? null;
  }

  /**
   * Get stats about config usage.
   */
  getStats(): {
    instances: number;
    usingOAuth: number;
    usingApiKey: number;
    availableApiKeys: number;
  } {
    const states = Array.from(this.configStates.values());
    return {
      instances: states.length,
      usingOAuth: states.filter(s => s.type === 'oauth').length,
      usingApiKey: states.filter(s => s.type === 'apikey').length,
      availableApiKeys: this.apiKeyConfigs.length,
    };
  }

  /**
   * Restore original settings on shutdown.
   */
  async restore(): Promise<void> {
    if (this.originalSettings !== null) {
      await writeFile(this.claudeSettingsPath, this.originalSettings);
      logger.info('Restored original Claude settings');
    }
  }

  /**
   * Add an API key config at runtime.
   */
  addApiKeyConfig(config: ApiKeyConfig): void {
    this.apiKeyConfigs.push(config);
    logger.info(`Added API key config: ${config.name}`);
  }
}
