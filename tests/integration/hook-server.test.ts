import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HookServer, HookPayload } from '../../src/server.js';

// Note: These tests use actual HTTP requests without supertest
// to avoid adding extra dependencies

describe('HookServer', () => {
  let server: HookServer;
  let port: number;

  beforeEach(async () => {
    // Use random port to avoid conflicts
    port = 3000 + Math.floor(Math.random() * 1000);
    server = new HookServer(port);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('health check', () => {
    it('should respond with healthy status', async () => {
      const response = await fetch(`http://localhost:${port}/health`);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('healthy');
      expect(data.timestamp).toBeDefined();
    });
  });

  describe('status endpoint', () => {
    it('should return server status', async () => {
      const response = await fetch(`http://localhost:${port}/status`);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('running');
      expect(typeof data.uptime).toBe('number');
      expect(Array.isArray(data.handlers)).toBe(true);
    });

    it('should list registered handlers', async () => {
      server.on('test-hook', async () => {});
      server.on('another-hook', async () => {});

      const response = await fetch(`http://localhost:${port}/status`);
      const data = await response.json();

      expect(data.handlers).toContain('test-hook');
      expect(data.handlers).toContain('another-hook');
    });
  });

  describe('hook endpoint', () => {
    it('should receive hook payloads', async () => {
      const receivedPayloads: HookPayload[] = [];
      server.on('task-complete', async (payload) => {
        receivedPayloads.push(payload);
      });

      const response = await fetch(`http://localhost:${port}/hooks/task-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instance_id: 'worker-1',
          worker_id: 1,
          instance_type: 'worker',
          data: { task: 'build' },
        }),
      });

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('ok');
      expect(data.hook).toBe('task-complete');
      expect(receivedPayloads.length).toBe(1);
      expect(receivedPayloads[0].instance_id).toBe('worker-1');
      expect(receivedPayloads[0].worker_id).toBe(1);
      expect(receivedPayloads[0].data.task).toBe('build');
    });

    it('should call multiple handlers for same hook', async () => {
      const calls: string[] = [];

      server.on('multi-handler', async () => {
        calls.push('handler1');
      });
      server.on('multi-handler', async () => {
        calls.push('handler2');
      });

      await fetch(`http://localhost:${port}/hooks/multi-handler`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance_id: 'test' }),
      });

      expect(calls).toContain('handler1');
      expect(calls).toContain('handler2');
    });

    it('should handle missing optional fields', async () => {
      const receivedPayloads: HookPayload[] = [];
      server.on('minimal', async (payload) => {
        receivedPayloads.push(payload);
      });

      await fetch(`http://localhost:${port}/hooks/minimal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(receivedPayloads.length).toBe(1);
      expect(receivedPayloads[0].instance_id).toBe('');
      expect(receivedPayloads[0].worker_id).toBe(0);
      expect(receivedPayloads[0].data).toEqual({});
    });

    it('should continue after handler error', async () => {
      const calls: string[] = [];

      server.on('error-test', async () => {
        calls.push('before-error');
        throw new Error('Test error');
      });
      server.on('error-test', async () => {
        calls.push('after-error');
      });

      const response = await fetch(`http://localhost:${port}/hooks/error-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance_id: 'test' }),
      });

      expect(response.status).toBe(200);
      expect(calls).toContain('before-error');
      expect(calls).toContain('after-error');
    });
  });

  describe('handler management', () => {
    it('should register handlers with on()', () => {
      const handler = vi.fn();
      server.on('test-hook', handler);

      const status = server.getApp();
      expect(status).toBeDefined();
    });

    it('should remove handlers with off()', async () => {
      const handler = vi.fn();
      server.on('removable', handler);
      server.off('removable');

      await fetch(`http://localhost:${port}/hooks/removable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance_id: 'test' }),
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('getPort', () => {
    it('should return configured port', () => {
      expect(server.getPort()).toBe(port);
    });
  });

  describe('getApp', () => {
    it('should return express app instance', () => {
      const app = server.getApp();
      expect(app).toBeDefined();
      expect(typeof app.listen).toBe('function');
    });
  });
});
