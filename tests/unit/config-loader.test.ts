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

  describe('validate', () => {
    it('should return config when valid', async () => {
      await writeFile(
        join(testDir, 'orchestrator.json'),
        JSON.stringify(validConfig)
      );

      const result = await loader.validate();

      expect(result.config.repositoryUrl).toBe(validConfig.repositoryUrl);
      expect(result.config.workerCount).toBe(validConfig.workerCount);
    });
  });
});
