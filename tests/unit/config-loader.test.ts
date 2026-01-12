import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigLoader } from '../../src/config/loader.js';
import { writeFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ConfigLoader', () => {
  let testDir: string;
  let loader: ConfigLoader;

  const validConfig = {
    repositoryUrl: 'https://github.com/test/repo.git',
    branch: 'main',
    workerCount: 2,
    claudeConfigs: '/tmp/claude-configs/*.json',
    hookServerPort: 3000,
  };

  beforeEach(async () => {
    testDir = join(tmpdir(), `config-loader-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    loader = new ConfigLoader(testDir);
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('loadOrchestratorConfig', () => {
    it('should load valid config', async () => {
      await writeFile(
        join(testDir, 'orchestrator.json'),
        JSON.stringify(validConfig)
      );

      const config = await loader.loadOrchestratorConfig();

      expect(config.repositoryUrl).toBe(validConfig.repositoryUrl);
      expect(config.workerCount).toBe(2);
      expect(config.branch).toBe('main');
    });

    it('should apply default values', async () => {
      const minimalConfig = {
        repositoryUrl: 'https://github.com/test/repo.git',
        workerCount: 1,
        claudeConfigs: '*.json',
      };
      await writeFile(
        join(testDir, 'orchestrator.json'),
        JSON.stringify(minimalConfig)
      );

      const config = await loader.loadOrchestratorConfig();

      expect(config.branch).toBe('main');
      expect(config.hookServerPort).toBe(3000);
      expect(config.healthCheckIntervalMs).toBe(30000);
      expect(config.stuckThresholdMs).toBe(300000);
      expect(config.maxToolUsesPerInstance).toBe(500);
      expect(config.maxTotalToolUses).toBe(2000);
      expect(config.maxRunDurationMinutes).toBe(120);
    });

    it('should cache loaded config', async () => {
      await writeFile(
        join(testDir, 'orchestrator.json'),
        JSON.stringify(validConfig)
      );

      const config1 = await loader.loadOrchestratorConfig();
      const config2 = await loader.loadOrchestratorConfig();

      expect(config1).toBe(config2); // Same object reference
    });

    it('should throw when config file not found', async () => {
      await expect(loader.loadOrchestratorConfig()).rejects.toThrow(
        'Config file not found'
      );
    });

    it('should throw when config is invalid JSON', async () => {
      await writeFile(join(testDir, 'orchestrator.json'), '{ invalid json }');

      await expect(loader.loadOrchestratorConfig()).rejects.toThrow(
        'Invalid JSON'
      );
    });

    it('should throw when required fields are missing', async () => {
      await writeFile(
        join(testDir, 'orchestrator.json'),
        JSON.stringify({ branch: 'main' })
      );

      await expect(loader.loadOrchestratorConfig()).rejects.toThrow();
    });

    it('should reject invalid repository URL', async () => {
      await writeFile(
        join(testDir, 'orchestrator.json'),
        JSON.stringify({ ...validConfig, repositoryUrl: 'not-a-url' })
      );

      await expect(loader.loadOrchestratorConfig()).rejects.toThrow();
    });

    it('should reject invalid worker count', async () => {
      await writeFile(
        join(testDir, 'orchestrator.json'),
        JSON.stringify({ ...validConfig, workerCount: 0 })
      );

      await expect(loader.loadOrchestratorConfig()).rejects.toThrow();
    });

    it('should reject worker count above maximum', async () => {
      await writeFile(
        join(testDir, 'orchestrator.json'),
        JSON.stringify({ ...validConfig, workerCount: 100 })
      );

      await expect(loader.loadOrchestratorConfig()).rejects.toThrow();
    });

    it('should reject invalid port numbers', async () => {
      await writeFile(
        join(testDir, 'orchestrator.json'),
        JSON.stringify({ ...validConfig, hookServerPort: 80 })
      );

      await expect(loader.loadOrchestratorConfig()).rejects.toThrow();
    });
  });

  describe('loadClaudeConfigs', () => {
    let claudeConfigDir: string;

    beforeEach(async () => {
      claudeConfigDir = join(testDir, 'claude-configs');
      await mkdir(claudeConfigDir, { recursive: true });

      // Write orchestrator config with pattern pointing to test dir
      await writeFile(
        join(testDir, 'orchestrator.json'),
        JSON.stringify({
          ...validConfig,
          claudeConfigs: `${claudeConfigDir}/*.json`,
        })
      );
    });

    it('should find matching config files', async () => {
      await writeFile(
        join(claudeConfigDir, 'config1.json'),
        JSON.stringify({ apiKey: 'key1' })
      );
      await writeFile(
        join(claudeConfigDir, 'config2.json'),
        JSON.stringify({ apiKey: 'key2' })
      );

      const paths = await loader.loadClaudeConfigs();

      expect(paths.length).toBe(2);
      expect(paths.some((p) => p.includes('config1.json'))).toBe(true);
      expect(paths.some((p) => p.includes('config2.json'))).toBe(true);
    });

    it('should throw when no config files match', async () => {
      await expect(loader.loadClaudeConfigs()).rejects.toThrow(
        'No Claude config files found'
      );
    });
  });

  describe('validateClaudeConfigs', () => {
    let claudeConfigDir: string;

    beforeEach(async () => {
      claudeConfigDir = join(testDir, 'claude-configs');
      await mkdir(claudeConfigDir, { recursive: true });
    });

    it('should validate valid config files', async () => {
      const configPath = join(claudeConfigDir, 'valid.json');
      await writeFile(configPath, JSON.stringify({ apiKey: 'sk-ant-test' }));

      await expect(loader.validateClaudeConfigs([configPath])).resolves.not.toThrow();
    });

    it('should allow additional properties (passthrough)', async () => {
      const configPath = join(claudeConfigDir, 'extended.json');
      await writeFile(
        configPath,
        JSON.stringify({
          apiKey: 'sk-ant-test',
          customSetting: 'value',
          env: { CUSTOM_VAR: 'test' },
        })
      );

      await expect(loader.validateClaudeConfigs([configPath])).resolves.not.toThrow();
    });

    it('should reject invalid JSON files', async () => {
      const configPath = join(claudeConfigDir, 'invalid.json');
      await writeFile(configPath, '{ not valid json }');

      await expect(loader.validateClaudeConfigs([configPath])).rejects.toThrow(
        'Invalid Claude config files'
      );
    });
  });

  describe('validate', () => {
    it('should return config and claude paths when valid', async () => {
      const claudeConfigDir = join(testDir, 'claude-configs');
      await mkdir(claudeConfigDir, { recursive: true });

      await writeFile(
        join(testDir, 'orchestrator.json'),
        JSON.stringify({
          ...validConfig,
          claudeConfigs: `${claudeConfigDir}/*.json`,
        })
      );

      await writeFile(
        join(claudeConfigDir, 'config1.json'),
        JSON.stringify({ apiKey: 'key1' })
      );
      await writeFile(
        join(claudeConfigDir, 'config2.json'),
        JSON.stringify({ apiKey: 'key2' })
      );
      await writeFile(
        join(claudeConfigDir, 'config3.json'),
        JSON.stringify({ apiKey: 'key3' })
      );

      const result = await loader.validate();

      expect(result.config.repositoryUrl).toBe(validConfig.repositoryUrl);
      expect(result.claudeConfigPaths.length).toBe(3);
    });
  });
});
