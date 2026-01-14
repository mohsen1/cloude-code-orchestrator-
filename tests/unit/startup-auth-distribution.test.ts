import { describe, it, expect, vi } from 'vitest';
import { Orchestrator, type AuthConfig } from '../../src/orchestrator/manager.js';
import type { OrchestratorConfig } from '../../src/config/schema.js';

type AuthMode = OrchestratorConfig['authMode'];

type StubTeam = {
  id: number;
  emInstanceId: string;
  worktreePath: string;
};

type StubOptions = {
  workerCount: number;
  engineerManagerGroupSize: number;
  authMode: AuthMode;
  authConfigs: AuthConfig[];
  teams?: StubTeam[];
  useHierarchy?: boolean;
};

const BASE_CONFIG: Omit<OrchestratorConfig, 'workerCount' | 'engineerManagerGroupSize' | 'authMode'> = {
  repositoryUrl: 'https://example.com/repo.git',
  branch: 'main',
  hookServerPort: 3456,
  serverPort: 3456,
  healthCheckIntervalMs: 30000,
  rateLimitCheckIntervalMs: 10000,
  stuckThresholdMs: 300000,
  managerHeartbeatIntervalMs: 600000,
  maxToolUsesPerInstance: 500,
  maxTotalToolUses: 2000,
  maxRunDurationMinutes: 120,
};

function buildConfig(workerCount: number, engineerManagerGroupSize: number, authMode: AuthMode): OrchestratorConfig {
  return {
    ...BASE_CONFIG,
    workerCount,
    engineerManagerGroupSize,
    authMode,
  };
}

function buildAuthRotationPool(mode: AuthMode, configs: AuthConfig[]): Array<AuthConfig | null> {
  if (mode === 'api-keys-only') {
    return [...configs];
  }

  if (mode === 'api-keys-first') {
    return configs.length > 0 ? [...configs, null] : [null];
  }

  return [null];
}

function createStubOrchestrator(options: StubOptions) {
  const orchestrator = Object.create(Orchestrator.prototype) as Record<string, any>;

  orchestrator.config = buildConfig(options.workerCount, options.engineerManagerGroupSize, options.authMode);
  orchestrator.workspaceDir = '/tmp/workspace';
  orchestrator.useHierarchy = options.useHierarchy ?? options.workerCount > options.engineerManagerGroupSize;
  orchestrator.teams = options.teams ?? [];
  orchestrator.authConfigs = options.authConfigs;
  orchestrator.authRotationPool = buildAuthRotationPool(options.authMode, options.authConfigs);
  orchestrator.authRotationIndex = 0;
  orchestrator.startupAuthAssignmentIndex = 0;

  const createInstance = vi.fn().mockResolvedValue(undefined);
  orchestrator.createInstance = createInstance;

  return { orchestrator, createInstance } as const;
}

describe('Orchestrator startup auth distribution', () => {
  it('round-robins API keys across manager and workers in api-keys-only mode', async () => {
    const authConfigs: AuthConfig[] = [
      { name: 'key-a', env: { ANTHROPIC_API_KEY: 'a' } },
      { name: 'key-b', env: { ANTHROPIC_API_KEY: 'b' } },
    ];

    const { orchestrator, createInstance } = createStubOrchestrator({
      workerCount: 2,
      engineerManagerGroupSize: 5,
      authMode: 'api-keys-only',
      authConfigs,
    });

    await (orchestrator as any).createInstances(false);

    const assignedAuths = createInstance.mock.calls.map(call => call[4]?.name);
    expect(assignedAuths).toEqual(['key-a', 'key-b', 'key-a']);
  });

  it('includes directors and EMs when distributing keys in api-keys-first mode', async () => {
    const authConfigs: AuthConfig[] = [
      { name: 'key-1', env: { ANTHROPIC_API_KEY: '1' } },
      { name: 'key-2', env: { ANTHROPIC_API_KEY: '2' } },
      { name: 'key-3', env: { ANTHROPIC_API_KEY: '3' } },
    ];

    const { orchestrator, createInstance } = createStubOrchestrator({
      workerCount: 2,
      engineerManagerGroupSize: 1,
      authMode: 'api-keys-first',
      authConfigs,
      teams: [{ id: 1, emInstanceId: 'em-1', worktreePath: '/tmp/em-1' }],
      useHierarchy: true,
    });

    await (orchestrator as any).createInstances(false);

    const assignedAuths = createInstance.mock.calls.map(call => call[4]?.name);
    expect(assignedAuths.slice(0, 4)).toEqual(['key-1', 'key-2', 'key-3', 'key-1']);
  });

  it('falls back to a single key when only one config exists', async () => {
    const authConfigs: AuthConfig[] = [{ name: 'solo', env: { ANTHROPIC_API_KEY: 'only' } }];

    const { orchestrator, createInstance } = createStubOrchestrator({
      workerCount: 2,
      engineerManagerGroupSize: 5,
      authMode: 'api-keys-only',
      authConfigs,
    });

    await (orchestrator as any).createInstances(false);

    const assignedAuths = createInstance.mock.calls.map(call => call[4]?.name);
    expect(assignedAuths).toEqual(['solo', 'solo', 'solo']);
  });
});
