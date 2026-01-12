import { vi } from 'vitest';
import type { ClaudeInstance, InstanceType } from '../../src/claude/instance.js';

export interface MockInstance {
  id: string;
  type: InstanceType;
  workerId: number;
  toolUseCount: number;
  status: 'idle' | 'ready' | 'busy' | 'error';
  lastToolUse?: Date;
  currentTaskFull?: string;
}

export function createMockInstanceManager(instances: MockInstance[] = []) {
  const instanceMap = new Map<string, MockInstance>();
  instances.forEach((i) => instanceMap.set(i.id, i));

  return {
    instances: instanceMap,
    getInstance: vi.fn((id: string) => instanceMap.get(id) || null),
    getAllInstances: vi.fn(() => Array.from(instanceMap.values())),
    setToolUseCount: (id: string, count: number) => {
      const instance = instanceMap.get(id);
      if (instance) {
        instance.toolUseCount = count;
      }
    },
    setStatus: (id: string, status: MockInstance['status']) => {
      const instance = instanceMap.get(id);
      if (instance) {
        instance.status = status;
      }
    },
    setLastToolUse: (id: string, date: Date | undefined) => {
      const instance = instanceMap.get(id);
      if (instance) {
        instance.lastToolUse = date;
      }
    },
    addInstance: (instance: MockInstance) => {
      instanceMap.set(instance.id, instance);
    },
    sendPrompt: vi.fn(),
    updateInstanceStatus: vi.fn(),
    incrementToolUse: vi.fn(),
  };
}

export function createMockInstance(
  id: string,
  type: InstanceType = 'worker',
  overrides: Partial<MockInstance> = {}
): MockInstance {
  return {
    id,
    type,
    workerId: type === 'manager' ? 0 : parseInt(id.split('-')[1] || '1'),
    toolUseCount: 0,
    status: 'ready',
    ...overrides,
  };
}
