import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalConfigManager, ApiKeyConfig } from '../../src/claude/local-config-manager.js';
import { writeFile, readFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('LocalConfigManager', () => {
  let testDir: string;
  let settingsPath: string;
  let configManager: LocalConfigManager;

  const apiKeyConfigs: ApiKeyConfig[] = [
    {
      name: 'api-key-1',
      env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-1' },
    },
    {
      name: 'z.ai-key',
      env: {
        ANTHROPIC_AUTH_TOKEN: 'test-token',
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      },
    },
  ];

  beforeEach(async () => {
    testDir = join(tmpdir(), `config-manager-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    // Create fake .claude directory
    const claudeDir = join(testDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    settingsPath = join(claudeDir, 'settings.json');

    // Write initial settings
    await writeFile(settingsPath, JSON.stringify({ original: true }, null, 2));

    configManager = new LocalConfigManager(apiKeyConfigs, 60);
    // Override the internal path directly
    (configManager as any).claudeSettingsPath = settingsPath;
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('initialize', () => {
    it('should backup original settings', async () => {
      await configManager.initialize();

      expect((configManager as any).originalSettings).toBe(
        JSON.stringify({ original: true }, null, 2)
      );
    });

    it('should default to empty object if no settings file exists', async () => {
      await rm(settingsPath, { force: true });

      const manager = new LocalConfigManager(apiKeyConfigs);
      (manager as any).claudeSettingsPath = settingsPath;
      await manager.initialize();

      expect((manager as any).originalSettings).toBe('{}');
    });
  });

  describe('assignConfig', () => {
    it('should assign OAuth config by default', async () => {
      await configManager.initialize();
      const type = await configManager.assignConfig('worker-1');

      expect(type).toBe('oauth');
      expect(configManager.getConfigType('worker-1')).toBe('oauth');
    });

    it('should write settings with hooks for OAuth', async () => {
      await configManager.initialize();
      await configManager.assignConfig('worker-1');

      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.Stop).toBeDefined();
      expect(settings.hooks.PostToolUse).toBeDefined();
    });
  });

  describe('rotateConfig', () => {
    beforeEach(async () => {
      await configManager.initialize();
    });

    it('should rotate from OAuth to first API key', async () => {
      await configManager.assignConfig('worker-1');
      const result = await configManager.rotateConfig('worker-1');

      expect(result).toEqual({ type: 'apikey', name: 'api-key-1' });
      expect(configManager.getConfigType('worker-1')).toBe('apikey');
    });

    it('should rotate through API keys sequentially', async () => {
      await configManager.assignConfig('worker-1');

      // OAuth -> API key 1
      let result = await configManager.rotateConfig('worker-1');
      expect(result?.name).toBe('api-key-1');

      // API key 1 -> API key 2 (z.ai)
      result = await configManager.rotateConfig('worker-1');
      expect(result?.name).toBe('z.ai-key');
    });

    it('should write correct settings with env vars and hooks', async () => {
      await configManager.assignConfig('worker-1');
      await configManager.rotateConfig('worker-1');

      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
      expect(settings.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-test-key-1' });
      expect(settings.hooks).toBeDefined();
    });

    it('should write correct settings for Z.AI env config', async () => {
      await configManager.assignConfig('worker-1');
      await configManager.rotateConfig('worker-1'); // to API key 1
      await configManager.rotateConfig('worker-1'); // to z.ai

      const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
      expect(settings.env).toEqual({
        ANTHROPIC_AUTH_TOKEN: 'test-token',
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      });
      expect(settings.hooks).toBeDefined();
    });

    it('should return null when no API keys available and OAuth rate limited', async () => {
      const manager = new LocalConfigManager([], 60);
      (manager as any).claudeSettingsPath = settingsPath;
      await manager.initialize();
      await manager.assignConfig('worker-1');

      const result = await manager.rotateConfig('worker-1');
      expect(result).toBeNull();
    });

    it('should rotate back to OAuth after exhausting all API keys', async () => {
      await configManager.assignConfig('worker-1');

      // Exhaust all API keys
      await configManager.rotateConfig('worker-1'); // API key 1
      await configManager.rotateConfig('worker-1'); // API key 2 (z.ai)
      const result = await configManager.rotateConfig('worker-1'); // back to OAuth

      expect(result).toEqual({ type: 'oauth' });
    });
  });

  describe('getStats', () => {
    it('should return correct stats', async () => {
      await configManager.initialize();
      await configManager.assignConfig('worker-1');
      await configManager.assignConfig('worker-2');
      await configManager.rotateConfig('worker-2');

      const stats = configManager.getStats();

      expect(stats.instances).toBe(2);
      expect(stats.usingOAuth).toBe(1);
      expect(stats.usingApiKey).toBe(1);
      expect(stats.availableApiKeys).toBe(2);
    });
  });

  describe('restore', () => {
    it('should restore original settings', async () => {
      await configManager.initialize();
      await configManager.assignConfig('worker-1');
      await configManager.rotateConfig('worker-1');
      await configManager.restore();

      const settings = await readFile(settingsPath, 'utf-8');
      expect(JSON.parse(settings)).toEqual({ original: true });
    });
  });

  describe('addApiKeyConfig', () => {
    it('should add new API key config at runtime', async () => {
      await configManager.initialize();
      configManager.addApiKeyConfig({
        name: 'new-key',
        env: { ANTHROPIC_API_KEY: 'sk-ant-new-key' },
      });

      const stats = configManager.getStats();
      expect(stats.availableApiKeys).toBe(3);
    });
  });
});
