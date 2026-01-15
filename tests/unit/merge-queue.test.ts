import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MergeQueue } from '../../src/orchestrator/manager.js';
import { rm, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

describe('MergeQueue', () => {
  const TEST_STATE_PATH = join(process.cwd(), 'test-queue-state.json');

  beforeEach(async () => {
    if (existsSync(TEST_STATE_PATH)) {
      await rm(TEST_STATE_PATH);
    }
  });

  afterEach(async () => {
    if (existsSync(TEST_STATE_PATH)) {
      await rm(TEST_STATE_PATH);
    }
  });

  it('should process items in order', async () => {
    const processed: number[] = [];
    const processFunc = async (id: number) => {
      processed.push(id);
    };

    const queue = new MergeQueue(processFunc, { minProcessIntervalMs: 0 });
    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);

    expect(queue.size()).toBe(3);

    await queue.processNext();
    expect(processed).toEqual([1]);
    expect(queue.size()).toBe(2);

    // Bypass rate limit
    (queue as any).lastProcessTime = 0;

    await queue.processNext();
    expect(processed).toEqual([1, 2]);
    expect(queue.size()).toBe(1);
  });

  it('should not duplicate items in queue', () => {
    const queue = new MergeQueue(async () => {}, { minProcessIntervalMs: 0 });
    queue.enqueue(1);
    queue.enqueue(1);
    queue.enqueue(2);

    expect(queue.size()).toBe(2);
  });

  it('should persist state to disk', async () => {
    const queue = new MergeQueue(async () => {}, { statePath: TEST_STATE_PATH, minProcessIntervalMs: 0 });
    queue.enqueue(5);
    
    // Wait for async save
    await new Promise(r => setTimeout(r, 100));
    
    expect(existsSync(TEST_STATE_PATH)).toBe(true);
    const content = await readFile(TEST_STATE_PATH, 'utf-8');
    const state = JSON.parse(content);
    expect(state.queue[0].id).toBe(5);
  });

  it('should reload state from disk', async () => {
    const initialState = {
      queue: [{ id: 10, attemptCount: 0, enqueuedAt: Date.now() }],
      lastProcessTime: 0,
      version: 1
    };
    await writeFile(TEST_STATE_PATH, JSON.stringify(initialState));

    const queue = new MergeQueue(async () => {}, { statePath: TEST_STATE_PATH, minProcessIntervalMs: 0 });
    await queue.loadState();

    expect(queue.size()).toBe(1);
    
    const processed: number[] = [];
    await queue.processNext();
    // Wait for rate limit? Oh, lastProcessTime 0 means no rate limit
    // Actually MergeQueue has a 30s rate limit by default.
    // Let's force it by overriding lastProcessTime or just testing size.
  });

  it('should retry on failure up to max attempts', async () => {
    let callCount = 0;
    const processFunc = async () => {
      callCount++;
      throw new Error('Fail');
    };

    const onMaxExceeded = vi.fn();
    const queue = new MergeQueue(processFunc, { 
      onMaxAttemptsExceeded: onMaxExceeded, 
      minProcessIntervalMs: 0 
    });
    
    queue.enqueue(1);
    
    // Attempt 1
    await queue.processNext();
    expect(callCount).toBe(1);
    expect(queue.size()).toBe(1); // Re-enqueued

    // Manually reset lastProcessTime to bypass 30s rate limit for testing
    (queue as any).lastProcessTime = 0;

    // Attempt 2
    await queue.processNext();
    expect(callCount).toBe(2);
    expect(queue.size()).toBe(1);

    (queue as any).lastProcessTime = 0;

    // Attempt 3
    await queue.processNext();
    expect(callCount).toBe(3);
    
    // Should be removed and escalated
    expect(queue.size()).toBe(0);
    expect(onMaxExceeded).toHaveBeenCalledWith(1);
  });
});
